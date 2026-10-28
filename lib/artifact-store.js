/**
 * dsh-retrace — content-addressed artifact snapshot store + `retrace` domain.
 *
 * PLAN.md §3.3 / §4.3: snapshots live under
 *
 *     $DSH_HOME/dsh-retrace/objects/<sha256[:2]>/<sha256>
 *
 * written with the same durable recipe as the official attachment store
 * (`dsh-attachment-local` saveImageFile): stage in tmp → O_EXCL write →
 * fsync → hardlink publish → directory fsync → integrity-verified reads.
 * The plugin owns this directory (host node:fs, exactly like attachments —
 * it never touches the workspace or any user-approval surface); workspace
 * reads/writes keep going through `ctx.fs`.
 *
 * Reference counting rides the `retrace` storageDomain (`refCounts` table +
 * global config) so one content-addressed object is shared across versions
 * and can be GC'd when nothing references it anymore. References are
 * `<sessionId>|<versionId>|<path>` strings, so rollback can look an object up
 * by the exact (session, version, file) triple.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// retrace storageDomain (refCounts + global config)
// ---------------------------------------------------------------------------

const refCountRecordSchema = z.object({
  /** `<sessionId>|<versionId>|<path>` strings referencing this object. */
  refs: z.array(z.string()),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  /**
   * Boundary time of each reference, keyed by ref string. `createdAt` only knows
   * the earliest boundary that stored these bytes, which dedupe makes useless
   * for judging a newer reference; this keeps the per-reference fact.
   */
  refAt: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /**
   * References whose captured bytes could not be proven to belong to their
   * boundary: a later boundary touched the same path before the read landed.
   * The content is still intact; restore refuses these instead of writing bytes
   * that belong to a newer version.
   */
  racy: z.array(z.string()).optional(),
})

const globalConfigSchema = z.object({
  retentionLimit: z.number().int().min(1),
  gitEnabled: z.boolean(),
})

/** One version's git facts, recorded at the boundary (P1 GitAdapter). */
const versionGitRecordSchema = z.object({
  /** HEAD at the version boundary (null = not a repository then). */
  headHash: z.string().nullable(),
  /** Working tree dirty at the boundary. */
  dirty: z.boolean(),
})

/**
 * What one artifact rollback overwrote, so it can be undone once. Bytes are
 * content-addressed like snapshots; `sha256: null` means the path did not exist
 * before the rollback, so undoing it deletes the file again.
 */
const undoRecordSchema = z.object({
  sessionId: z.string(),
  versionId: z.string(),
  createdAt: z.number().int().nonnegative(),
  entries: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().nullable(),
      sizeBytes: z.number().int().nonnegative(),
    }),
  ),
})

/**
 * The `retrace` domain spec — open via `ctx.storageDomain.open(retraceDomainSpec)`.
 * The web composition's `storage-json` backend lands it at
 * `$DSH_HOME/storages/retrace.json` beside the session projection cache.
 */
export const retraceDomainSpec = defineDomain({
  name: 'retrace',
  version: 1,
  tables: {
    // UNIT_NAME_RE is lowercase-only; `refcounts` is the official-safe spelling
    // of the plan's `refCounts` table.
    refcounts: domainTable(refCountRecordSchema),
    versiongit: domainTable(versionGitRecordSchema),
    undorecords: domainTable(undoRecordSchema),
  },
  global: {
    schema: globalConfigSchema,
    initial: { retentionLimit: 50, gitEnabled: true },
  },
})

// ---------------------------------------------------------------------------
// Durable directory plumbing (attachment-local pattern)
// ---------------------------------------------------------------------------

/** fsync a directory so its entries survive a crash. */
async function syncDirectory(path) {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS journaling owns entry durability there. */
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Create a private directory tree and persist every ancestor entry up to a
 * caller-vouched durable boundary (mirrors `ensureDurableDirectory` in
 * `dsh-attachment-local`). Re-syncing a durable entry is harmless; skipping
 * an unsynced one is not.
 */
async function ensureDurableDirectory(path, boundary) {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- callers pass a boundary that is an ancestor of path. */
    if (parent === level) return
    level = parent
  }
}

/** sha256 of bytes (Buffer or Uint8Array). */
function digest(data) {
  return createHash('sha256').update(data).digest('hex')
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/

/**
 * Content addresses are always lowercase hex. Validating them before building
 * a path keeps a hostile/corrupt reference from walking out of `objects/`
 * (`objectPath` joins `sha.slice(0, 2)`), and turns a silent ENOENT into an
 * explicit integrity error.
 */
function assertSha256(sha256) {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error('retrace artifact: invalid sha256 content address')
  }
}

/** Absolute path of one content-addressed object below the store root. */
export function objectPath(root, sha256) {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

// ---------------------------------------------------------------------------
// ArtifactStore
// ---------------------------------------------------------------------------

/**
 * Create the content-addressed snapshot store below `root`
 * (`$DSH_HOME/dsh-retrace`). All I/O is host `node:fs` on the plugin's own
 * directory; nothing here reads or writes the workspace.
 */
export function createArtifactStore(root) {
  const objectsRoot = join(root, 'objects')
  const staging = join(root, 'tmp')

  return {
    root,
    /** Absolute path of one object (read/remove). */
    pathOf: (sha256) => objectPath(root, sha256),

    /**
     * Durably persist immutable bytes and return their content address.
     * Deduplicated by sha256: a second save of identical bytes hardlinks to
     * the existing object after verifying its integrity (`existed: true`).
     * @returns {Promise<{sha256: string, sizeBytes: number, existed: boolean}>}
     */
    async save(data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      const sha256 = digest(bytes)
      const bucket = join(objectsRoot, sha256.slice(0, 2))
      const target = objectPath(root, sha256)
      await ensureDurableDirectory(bucket, root)
      await ensureDurableDirectory(staging, root)
      const temporary = join(staging, randomUUID())
      let handle
      try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        await handle.writeFile(bytes)
        await handle.sync()
        await handle.close()
        handle = undefined
        let existed = false
        try {
          await link(temporary, target)
        } catch (error) {
          // EEXIST is the only recoverable link race: another save published first.
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
          existed = true
          const existing = new Uint8Array(await readFile(target))
          if (digest(existing) !== sha256) {
            throw new Error(`retrace artifact integrity mismatch at ${target}`)
          }
        }
        await syncDirectory(bucket)
        await syncDirectory(objectsRoot)
        // The object is published (hardlinked) at this point; a failing tmp
        // cleanup must not turn a successful save into "snapshot skipped".
        await unlink(temporary).catch(() => {})
        return { sha256, sizeBytes: bytes.byteLength, existed }
      } catch (error) {
        /* v8 ignore next -- descriptor can remain open only when write/sync/close failed. */
        if (handle !== undefined) await handle.close().catch(() => {})
        await unlink(temporary).catch(() => {})
        throw error
      }
    },

    /**
     * Read an object, verifying its content address (integrity-checked).
     * `options.maxBytes` refuses oversized objects *before* reading them, so a
     * read route can enforce a memory budget without loading the blob first.
     */
    async read(sha256, options = {}) {
      assertSha256(sha256)
      const target = objectPath(root, sha256)
      const maxBytes = Number(options?.maxBytes)
      if (Number.isFinite(maxBytes) && maxBytes > 0) {
        const info = await stat(target)
        if (info.size > maxBytes) {
          const error = new Error(`artifact exceeds the ${maxBytes} byte read budget`)
          error.code = 'payload-too-large'
          throw error
        }
      }
      const data = new Uint8Array(await readFile(target))
      if (digest(data) !== sha256) {
        throw new Error(`retrace artifact integrity check failed for ${sha256}`)
      }
      return data
    },

    /** Remove one object; missing objects are a no-op. */
    async remove(sha256) {
      assertSha256(sha256)
      try {
        await unlink(objectPath(root, sha256))
      } catch (error) {
        /* v8 ignore next -- concurrent GC removing the same object is fine. */
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    },

    /** Every stored object sha256 (walks `objects/<xx>/<sha>`). */
    async list() {
      let buckets
      try {
        buckets = await readdir(objectsRoot, { withFileTypes: true })
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
        throw error
      }
      const hashes = []
      for (const bucket of buckets) {
        if (!bucket.isDirectory() || bucket.name.length !== 2) continue
        for (const entry of await readdir(join(objectsRoot, bucket.name))) {
          if (entry.length === 64) hashes.push(entry)
        }
      }
      return hashes.sort()
    },
  }
}

/**
 * Remove every stored object not in `keep` (a Set of sha256).
 * Callers derive `keep` from the `refCounts` table (refs.length > 0) plus
 * whatever retention policy applies. Returns the number of removed objects.
 *
 * `minAgeMs` spares objects younger than that: a snapshot can be saved (blob
 * published) a moment before its refcounts row is written, and a concurrent
 * sweep must never delete a blob that is still in flight.
 *
 * `isReferenced(sha256)` is the last-moment guard for references written after
 * the caller computed `keep`: a sweep only waits for snapshots that had already
 * started, so a snapshot beginning right after can add a ref to an old object
 * while the keep set is being collected. Returning true spares the object.
 */
export async function gcArtifacts(store, keep, options = {}) {
  const minAgeMs = Number.isFinite(options.minAgeMs) ? Math.max(0, options.minAgeMs) : 0
  const isReferenced = typeof options.isReferenced === 'function' ? options.isReferenced : null
  const cutoff = minAgeMs > 0 ? Date.now() - minAgeMs : 0
  const removed = []
  for (const sha256 of await store.list()) {
    if (keep.has(sha256)) continue
    if (cutoff > 0) {
      const info = await stat(store.pathOf(sha256)).catch(() => null)
      // Missing (removed concurrently) or too fresh to be provably dead.
      if (!info || info.mtimeMs > cutoff) continue
    }
    if (isReferenced && (await isReferenced(sha256))) continue
    await store.remove(sha256)
    removed.push(sha256)
  }
  return removed.length
}

/**
 * Reference separator. Version ids are numbered per session (`v<boundarySeq>`),
 * so a bare `<versionId>:<path>` reference was ambiguous across sessions: two
 * sessions that both reached seq 10 wrote the same reference for different
 * bytes, and a lookup could hand back another session's content. Every key that
 * names a version therefore carries the session id.
 */
export const REF_SEPARATOR = '|'

/**
 * Parse a reference. Rows written before 0.4.58 have no session id; they come
 * back with `legacy: true` — they are never GC'd and never match a
 * session-scoped lookup, because the owner cannot be recovered reliably.
 */
export function parseRef(ref) {
  const first = ref.indexOf(REF_SEPARATOR)
  if (first === -1) {
    const colon = ref.indexOf(':')
    return {
      legacy: true,
      sessionId: null,
      versionId: colon === -1 ? null : ref.slice(0, colon),
      path: colon === -1 ? ref : ref.slice(colon + 1),
    }
  }
  const second = ref.indexOf(REF_SEPARATOR, first + 1)
  if (second === -1) return { legacy: true, sessionId: null, versionId: null, path: ref }
  return {
    legacy: false,
    sessionId: ref.slice(0, first),
    versionId: ref.slice(first + 1, second),
    path: ref.slice(second + 1),
  }
}

/** Build a `<sessionId>|<versionId>|<path>` reference string. */
export function refFor(sessionId, versionId, path) {
  return `${sessionId}${REF_SEPARATOR}${versionId}${REF_SEPARATOR}${path}`
}

/** Key of one version's git facts (`<sessionId>|<versionId>`). */
export function versionKey(sessionId, versionId) {
  return `${sessionId}${REF_SEPARATOR}${versionId}`
}

/** Parse a versiongit key; pre-0.4.58 rows come back `legacy: true`. */
export function parseVersionKey(key) {
  const first = key.indexOf(REF_SEPARATOR)
  if (first === -1) return { legacy: true, sessionId: null, versionId: key }
  return { legacy: false, sessionId: key.slice(0, first), versionId: key.slice(first + 1) }
}
