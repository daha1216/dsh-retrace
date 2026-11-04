/**
 * 产物库离线检查与清理（工作包 I）。
 *
 * 为什么需要：0.4.58 之前写进 `refcounts` 的引用没有会话前缀（`v12:src/a.ts`），
 * 归属无法可靠恢复，所以这些 legacy 引用永远不会被自动 GC 命中，也不会被任何
 * 会话查到——它们只是长期占着磁盘和元数据。这个模块提供只读盘点 + 只删「无人引用」
 * 对象的清理，供 `retrace store` 子命令使用。
 *
 * 安全边界（刻意保守）：
 *  - 只删除「磁盘上存在、但任何引用（含 legacy）都不指向」的对象；
 *  - 有引用的对象、legacy 引用指向的对象，一律不动；
 *  - 引用存在而对象缺失（悬空引用）只报告，不修，因为无法判断该丢引用还是找文件；
 *  - 默认 dry-run，`--apply` 必须再带 `--yes`。
 */
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const SHA = /^[0-9a-f]{64}$/

/** Ignore unsupported Windows file syncs; other pre-publish sync failures abort the write. */
function syncBestEffort(handle, { sync = fsyncSync, platform = process.platform } = {}) {
  try {
    sync(handle)
  } catch (error) {
    const ignorable = platform === 'win32' && ['EPERM', 'ENOSYS', 'EINVAL'].includes(error?.code)
    if (!ignorable) throw error
  }
}

/** Persist a published directory entry where directory handles are supported. */
export function syncDirectory(path, { open = openSync, sync = fsyncSync, close = closeSync, platform = process.platform } = {}) {
  if (platform === 'win32') return
  const handle = open(path, 'r')
  try {
    sync(handle)
  } finally {
    close(handle)
  }
}

/**
 * How recently the store must have been touched for us to call a host "alive".
 * The seam writes `capture-epoch.json` and flushes the domain file as it runs,
 * so a recent mtime means a live owner is plausible; there is no pid/lock file
 * to check instead.
 */
const LIVE_WINDOW_MS = 120_000

/** Files whose recency suggests a host currently owns this store. */
function liveHostMarker(root) {
  const probes = [
    join(root, 'capture-epoch.json'),
    join(root, 'tmp'),
  ]
  const now = Date.now()
  for (const probe of probes) {
    let info = null
    try { info = statSync(probe) } catch { continue }
    const age = now - info.mtimeMs
    if (age >= 0 && age < LIVE_WINDOW_MS) return `${probe} updated ${Math.round(age / 1000)}s ago`
  }
  return null
}

/** Write through an exclusive sibling temp file and publish it with rename. */
export function writeFileAtomic(file, text, overrides = {}) {
  const io = {
    open: openSync,
    write: writeFileSync,
    sync: fsyncSync,
    close: closeSync,
    rename: renameSync,
    unlink: unlinkSync,
    uuid: randomUUID,
    platform: process.platform,
    ...overrides,
  }
  io.syncDirectory ??= (path) => syncDirectory(path, io)

  let temporary
  let handle
  for (let attempt = 0; attempt < 8; attempt += 1) {
    temporary = `${file}.tmp-${io.uuid()}`
    try {
      handle = io.open(temporary, 'wx', 0o600)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === 7) throw error
    }
  }

  try {
    io.write(handle, text, 'utf8')
    syncBestEffort(handle, io)
    io.close(handle)
    handle = undefined
    io.rename(temporary, file)
    temporary = undefined
  } catch (error) {
    if (handle !== undefined) {
      try { io.close(handle) } catch { /* already closed */ }
    }
    if (temporary !== undefined) {
      try { io.unlink(temporary) } catch { /* already gone */ }
    }
    throw error
  }

  try {
    io.syncDirectory(dirname(file))
  } catch (cause) {
    // rename already published the target; make that state explicit to callers.
    const error = new Error(`store file was committed but its directory sync failed: ${file}`, { cause })
    error.code = 'store-commit-uncertain'
    error.committed = true
    throw error
  }
}

/** 读取 DSH storageDomain 落盘文件（缺失时返回空结构）。 */
export function readDomain(file) {
  let raw = null
  try { raw = readFileSync(file, 'utf8') } catch { return { refcounts: new Map(), versiongit: new Map(), present: false } }
  const parsed = JSON.parse(raw)
  const tables = parsed?.tables ?? {}
  return {
    present: true,
    refcounts: new Map(Object.entries(tables.refcounts ?? {})),
    versiongit: new Map(Object.entries(tables.versiongit ?? {})),
    global: parsed?.global ?? null,
  }
}

/** 列出对象库里的 blob（`objects/<2位>/<sha>`）。 */
export function listObjects(root) {
  const out = []
  let buckets = []
  try { buckets = readdirSync(join(root, 'objects')) } catch { return out }
  for (const bucket of buckets) {
    if (!/^[0-9a-f]{2}$/.test(bucket)) continue
    let names = []
    try { names = readdirSync(join(root, 'objects', bucket)) } catch { continue }
    for (const name of names) {
      if (!SHA.test(name)) continue
      const path = join(root, 'objects', bucket, name)
      let size = 0
      try { size = statSync(path).size } catch { size = 0 }
      out.push({ sha: name, path, size })
    }
  }
  return out
}

/** 引用分类：`<sessionId>|v12:path` 为 scoped，`v12:path` 为 legacy。 */
export function classifyRef(ref) {
  const bar = ref.indexOf('|')
  const colon = ref.indexOf(':')
  if (bar !== -1 && (colon === -1 || bar < colon)) {
    return { scoped: true, sessionId: ref.slice(0, bar), versionId: ref.slice(bar + 1, colon === -1 ? undefined : colon) }
  }
  return { scoped: false, sessionId: null, versionId: colon === -1 ? ref : ref.slice(0, colon) }
}

/**
 * 盘点：对象、引用、悬空、孤儿、legacy 统计。
 * `verifyHashes` 为 true 时逐个校验对象内容 sha（慢，默认关）。
 */
export function inventory({ domainFile, root, verifyHashes = false }) {
  const domain = readDomain(domainFile)
  const objects = listObjects(root)
  const referenced = new Set()
  const dangling = []
  const legacyRefs = []
  const scopedRefs = []
  const zeroRefRows = []
  let refBytes = 0
  for (const [sha, record] of domain.refcounts) {
    const refs = Array.isArray(record?.refs) ? record.refs : []
    refBytes += Number(record?.sizeBytes ?? 0)
    if (refs.length === 0) { zeroRefRows.push(sha); continue }
    for (const ref of refs) {
      const parsed = classifyRef(ref)
      if (parsed.scoped) scopedRefs.push({ sha, ref, sessionId: parsed.sessionId, versionId: parsed.versionId })
      else legacyRefs.push({ sha, ref, versionId: parsed.versionId })
      referenced.add(sha)
    }
  }
  const onDisk = new Set(objects.map((object) => object.sha))
  for (const sha of referenced) if (!onDisk.has(sha)) dangling.push(sha)
  const orphans = objects.filter((object) => !referenced.has(object.sha))
  const mismatched = []
  if (verifyHashes) {
    for (const object of objects) {
      let bytes = null
      try { bytes = readFileSync(object.path) } catch { continue }
      if (createHash('sha256').update(bytes).digest('hex') !== object.sha) mismatched.push(object.sha)
    }
  }
  return {
    domainPresent: domain.present,
    objects,
    objectBytes: objects.reduce((sum, object) => sum + object.size, 0),
    refRows: domain.refcounts.size,
    zeroRefRows,
    scopedRefs,
    legacyRefs,
    dangling,
    orphans,
    mismatched,
    versionRows: domain.versiongit.size,
    legacyVersionRows: [...domain.versiongit.keys()].filter((key) => !key.includes('|')).length,
    refBytes,
  }
}

/**
 * 冻结 legacy 状态并清理纯元数据垃圾行。
 *
 * 两件事，都不碰任何 blob：
 *  1. 删掉 refs 为空、且对象已不存在的 refcounts 行——它们只是历史残留的元数据；
 *  2. 写一份 `legacy-frozen.json` 侧车文件，把「有多少 legacy 引用、从何时起冻结、
 *     为什么不能归属」记录下来，免得将来有人把它们当垃圾清掉。
 *
 * 归属不可恢复是事实：legacy 引用形如 `v12:src/a.ts`，既没有会话 id，versiongit 里
 * 的对应行也没有。任何「按时间/路径猜会话」的迁移都会把 A 会话的快照算到 B 会话头上，
 * 所以这里只冻结、不重写引用。
 */
export function migrate({ domainFile, root, apply = false, force = false }) {
  const report = inventory({ domainFile, root })
  const onDisk = new Set(report.objects.map((object) => object.sha))
  const raw = readFileSync(domainFile, 'utf8')
  const parsed = JSON.parse(raw)
  const refcounts = parsed?.tables?.refcounts ?? {}
  const droppable = Object.keys(refcounts).filter((sha) => {
    const refs = Array.isArray(refcounts[sha]?.refs) ? refcounts[sha].refs : []
    return refs.length === 0 && !onDisk.has(sha)
  })
  const frozen = {
    frozenAt: new Date().toISOString(),
    policy: 'unattributable-legacy-refs-are-frozen',
    reason: 'pre-0.4.58 refs carry no session id; guessing an owner would restore another session\'s bytes',
    legacyRefs: report.legacyRefs.length,
    legacyVersionRows: report.legacyVersionRows,
    objectsKept: new Set(report.legacyRefs.map((entry) => entry.sha)).size,
  }
  const result = { mode: apply ? 'apply' : 'dry-run', droppableRows: droppable.length, droppedRows: 0, backupPath: null, sidecarPath: join(root, 'legacy-frozen.json'), frozen }
  if (!apply) return result

  // The domain file belongs to a storage domain that a running host keeps in
  // memory and rewrites on its own flush: a CLI rewrite under it is silently
  // undone at the next flush, or worse, races a flush mid-write. Refuse while a
  // host looks alive unless the operator says otherwise.
  if (!force) {
    const live = liveHostMarker(root)
    if (live) {
      throw Object.assign(
        new Error(`A running host appears to own this store (${live}); stop it first, or pass --force if you are certain`),
        { code: 'store-in-use' },
      )
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${domainFile}.bak-${stamp}`
  writeFileAtomic(backupPath, readFileSync(domainFile))
  // Re-read immediately before publishing. The domain file is rewritten whole by
  // the host, so a flush that landed since `inventory` carries refcount rows this
  // run never saw — publishing our stale copy would delete them.
  const fresh = JSON.parse(readFileSync(domainFile, 'utf8'))
  const freshRefcounts = fresh?.tables?.refcounts ?? {}
  let dropped = 0
  for (const sha of droppable) {
    const row = freshRefcounts[sha]
    if (!row) continue
    if (Array.isArray(row.refs) && row.refs.length > 0) continue
    delete freshRefcounts[sha]
    dropped += 1
  }
  // Atomic publish: a truncated domain file is unreadable to the domain loader,
  // which then starts from an empty store and orphans every blob on disk.
  // Publish the audit sidecar first: if the second rename fails, the durable
  // domain still describes the pre-migration state and can be retried safely.
  writeFileAtomic(result.sidecarPath, JSON.stringify(frozen, null, 2))
  writeFileAtomic(domainFile, JSON.stringify(fresh, null, 2))
  result.droppedRows = dropped
  result.backupPath = backupPath
  return result
}

/**
 * 删除孤儿对象。只接受 inventory 算出的 orphans（调用方不得自行传 sha）。
 * 返回 { removed, bytes, failed }。
 */
export function pruneOrphans(report) {
  let removed = 0
  let bytes = 0
  const failed = []
  for (const object of report.orphans) {
    try {
      unlinkSync(object.path)
      removed += 1
      bytes += object.size
    } catch (error) {
      failed.push({ sha: object.sha, message: String(error?.message ?? error) })
    }
  }
  return { removed, bytes, failed }
}
