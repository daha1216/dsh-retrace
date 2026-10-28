/**
 * dsh-retrace — the capture epoch marker.
 *
 * `capture-epoch.json` records the first run that captured boundary content
 * honestly. A snapshot whose reference predates it cannot be proven to hold
 * that boundary's bytes, so restore refuses it instead of writing today's
 * bytes over the user's file (see `predatesCapture` in `versioning.js`).
 *
 * The marker therefore has one critical property: **it must never move
 * forward**. Moving it forward retroactively invalidates every snapshot the
 * user already has, and there is no way to undo that — restore silently
 * refuses all of them, forever.
 *
 * The previous implementation wrote the marker with a bare `writeFile`, so an
 * interrupted or partial write could leave a truncated file. The next load
 * failed to parse it, fell through to `Date.now()`, and wrote the *newer*
 * epoch: exactly the irreversible failure described above. This module makes
 * the write atomic and salvages a damaged marker instead of discarding it.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const CAPTURE_EPOCH_FILE = 'capture-epoch.json'

/**
 * Epoch values are milliseconds since 1970. A whole JSON marker is trusted as
 * written (tests inject small clocks); only the regex salvage below — which
 * runs on damaged text — must look like a real millisecond timestamp, so a
 * truncated `{"epoch":17000` cannot be mistaken for a 1970 epoch and disable
 * `predatesCapture` forever.
 */
const MIN_EPOCH_MS = 1_600_000_000_000 // 2020-09-13
const MAX_EPOCH_MS = 4_102_444_800_000 // 2100-01-01

/** Unique sibling path for the temp file, so concurrent runs cannot collide. */
function tempPath(file) {
  const unique = randomBytes(6).toString('hex')
  return `${file}.tmp-${process.pid}-${unique}`
}

/**
 * Write `data` to `file` such that a reader only ever sees the old content or
 * the new content, never a prefix. `rename` is atomic within a directory on
 * both POSIX and Windows (`MoveFileEx` with `REPLACE_EXISTING`).
 */
export async function writeFileAtomic(file, data) {
  const tmp = tempPath(file)
  try {
    await writeFile(tmp, data)
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * Read the epoch out of a marker's raw text.
 *
 * Returns `null` when nothing usable is present. A truncated marker can still
 * carry the number (`{"epoch":1759...`), and keeping that number is what
 * prevents the epoch from jumping forward, so a regex salvage runs before
 * giving up.
 */
export function parseEpoch(raw) {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    if (Number.isSafeInteger(parsed?.epoch) && parsed.epoch >= 0) return parsed.epoch
  } catch {
    // Truncated or corrupt: try to salvage the digits below.
  }
  // Only a plausible millisecond timestamp is salvaged. A shorter number is
  // exactly what a half-written/edited marker can leave behind, and trusting
  // it would move the epoch backwards (fail-open for `predatesCapture`).
  const match = /"epoch"\s*:\s*(\d{13,16})/.exec(raw)
  if (match) {
    const salvaged = Number(match[1])
    if (Number.isSafeInteger(salvaged) && salvaged >= MIN_EPOCH_MS && salvaged <= MAX_EPOCH_MS) return salvaged
  }
  return null
}

/** Best-effort forensic copy of a marker we could not use. Never throws. */
async function preserveDamaged(file, now) {
  await rename(file, `${file}.damaged-${now()}`).catch(() => {})
}

/**
 * Persist `epoch` and verify the write landed. Returns false (after warning)
 * instead of throwing: versioning must keep running, but a marker that only
 * lives in memory is exactly how the epoch moves forward on the next boot, so
 * the failure cannot stay silent.
 */
async function persistEpoch(file, epoch, warn) {
  const canonical = `${JSON.stringify({ epoch })}\n`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFileAtomic(file, canonical)
    const readBack = await readFile(file, 'utf8')
    if (readBack !== canonical) throw new Error('read-back mismatch')
    return true
  } catch (error) {
    warn?.(`capture epoch could not be persisted to ${file}: ${String(error)}; snapshots from this run may be refused after a restart`)
    return false
  }
}

/**
 * Load the capture epoch, establishing it on first use.
 *
 * Never throws: versioning degrades rather than failing the seam, and a
 * missing/unwritable marker must not take the plugin down. It also never
 * advances an epoch that is still readable.
 *
 * @param {string} root - the retrace store root.
 * @param {{ now?: () => number, warn?: (message: string) => void }} [options]
 *   - injectable clock and diagnostic sink for tests/hosts.
 * @returns {Promise<number>} the epoch (milliseconds).
 */
export async function loadCaptureEpoch(root, options = {}) {
  const now = options.now ?? Date.now
  const warn = typeof options.warn === 'function' ? options.warn : undefined
  const file = join(root, CAPTURE_EPOCH_FILE)

  let raw = null
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    raw = null // absent, or unreadable: treated as first use below
  }

  const existing = parseEpoch(raw)
  if (existing !== null) {
    // A salvaged marker is left in place by parseEpoch only when the JSON was
    // whole; repairing here keeps later reads on the fast path.
    if (raw !== `${JSON.stringify({ epoch: existing })}\n`) {
      await preserveDamaged(file, now)
      await persistEpoch(file, existing, warn)
    }
    return existing
  }

  if (raw !== null) {
    // Present but unusable. Keep it for diagnosis, then re-establish. This is
    // the only path that moves the epoch. `Date.now()` would retroactively
    // invalidate every snapshot taken before this boot; the marker's mtime is
    // the closest recoverable lower bound for when it was first written, so a
    // truncated marker does not destroy earlier history.
    let fallback = now()
    try {
      const info = await stat(file)
      if (Number.isFinite(info?.mtimeMs) && info.mtimeMs > 0) fallback = Math.floor(info.mtimeMs)
    } catch { /* unreadable metadata: keep now() */ }
    warn?.(`capture epoch marker is damaged; recovering epoch ${fallback} from its mtime instead of advancing to now()`)
    await preserveDamaged(file, now)
    await persistEpoch(file, fallback, warn)
    return fallback
  }

  const epoch = now()
  await persistEpoch(file, epoch, warn)
  return epoch
}
