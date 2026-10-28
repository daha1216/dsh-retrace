/**
 * dsh-retrace — lib/adapter/dsh.js
 *
 * DSH 平台适配器(2026-09-01)——实现 EventReader 接口。
 *
 * 职责:从 DSH 会话文件(session.vN.jsonl.zstd / session.jsonl.zstd)读全量事件——可靠事实,
 * 不依赖 host 内存视图(DSH 2.0.3 host 的 session.events 可能稀疏/窗口化)。
 *
 * 换架构时:业务层(message-list.js/守卫)零改动,新平台实现自己的 EventReader
 * (读自己的日志格式 → 同样的通用事件结构)。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// 官方 foldSurface:重放得与写入端完全一致的 surface nodes(replace 插 marker、
// 遮蔽移除节点 → nodes 非 seq 单调;span 计算必须用它,否则 start/end indexOf
// 会 not found/倒置 → S4/S8 拒 → 撤回死锁,ISSUE-20260907113201)。peerDep 提供。
import { foldSurface } from '@deepseek-ai/dsh-session'
import { editorOf, eventAt, messageIdOf, shadowedSeqsOf } from './normalize.js'

/**
 * 最近读过的会话日志(路径 → 大小/mtime 指纹 + 事件),避免重复全量解压。
 * Bounded by count AND by file bytes: a handful of image-heavy sessions would
 * otherwise pin hundreds of MB for the life of the host process.
 */
const LOG_CACHE_LIMIT = 4
const LOG_CACHE_BYTES_LIMIT = 64 * 1024 * 1024
const logCache = new Map()
let logCacheBytes = 0

function forgetLog(key) {
  const entry = logCache.get(key)
  if (!entry) return
  logCache.delete(key)
  logCacheBytes -= entry.size
}

function rememberLog(filePath, entry) {
  forgetLog(filePath)
  logCache.set(filePath, entry)
  logCacheBytes += entry.size
  while (logCache.size > LOG_CACHE_LIMIT) {
    forgetLog(logCache.keys().next().value)
  }
  // Always keep at least the just-read log even when it alone exceeds the
  // budget (otherwise the next op would re-decompress it immediately).
  while (logCacheBytes > LOG_CACHE_BYTES_LIMIT) {
    let victim = null
    for (const key of logCache.keys()) {
      if (key !== filePath) {
        victim = key
        break
      }
    }
    if (victim === null) break
    forgetLog(victim)
  }
}

/** 官方 nodes 里 [start..end] 位置段的节点 seq(折叠候选 shadowedSeqs)。 */
function rangeSeqs(nodes, start, end) {
  const si = nodes.indexOf(start)
  const ei = nodes.indexOf(end)
  if (si === -1 || ei === -1 || si > ei) return []
  return nodes.slice(si, ei + 1)
}

/** 会话日志文件名:`session.jsonl.zstd`(旧)与 `session.vN.jsonl.zstd`(2.0.x 起)。 */
const SESSION_LOG_PATTERN = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

/** 一个会话目录里版本号最高的日志文件(旧格式视为 v1)。 */
function newestSessionLog(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  let bestVersion = -1
  for (const name of names) {
    const match = SESSION_LOG_PATTERN.exec(name)
    if (!match) continue
    const version = match[1] === undefined ? 1 : Number(match[1])
    if (version > bestVersion) {
      bestVersion = version
      best = join(dir, name)
    }
  }
  return best
}

/** 会话 ID 是宿主生成的 UUID；只接受安全字符，避免拼出会话目录之外的路径。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** 找 DSH 会话文件路径(遍历 $DSH_HOME/sessions 各工作区；DSH_HOME 可覆盖默认 ~/.dsh)。 */
export function sessionFilePath(sessionId) {
  // sessionId 来自 HTTP/客户端，未校验时 `..\..\x` 会让 join 跳出 sessions/<ws>
  // 去读任意含 session*.jsonl.zstd 的目录（且解压/解析不受控字节）。
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return null
  const root = join(resolveDshHome(), 'sessions')
  let workspaces
  try {
    workspaces = readdirSync(root)
  } catch {
    return null
  }
  for (const workspace of workspaces) {
    const candidate = newestSessionLog(join(root, workspace, String(sessionId)))
    if (candidate) return candidate
  }
  return null
}

/** 是否是真实的用户输入(轮边界)——排除 context/steering 注入。 */
export function isRoundBoundary(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
}

/**
 * DSH 事件读取器:从文件读全量事件(通用事件结构)。
 * @returns {Promise<Array<{seq:number, type:string, turn?:number, data?:object, source?:object}>|null>}
 */
async function readEvents(sessionId) {
  const filePath = sessionFilePath(sessionId)
  return readEventsFromFile(filePath)
}

/** 从指定文件路径读全量事件(测试可注入路径;生产走 readEvents 找 ~/.dsh)。 */
async function readEventsFromFile(filePath) {
  try {
    if (!filePath) return null
    // One op (span + summary + maxStep) reads the same log up to three times;
    // an append-only log only changes when its size/mtime changes, so a small
    // fingerprint cache keeps repeated ops from decompressing the whole file.
    const info = statSync(filePath)
    const cached = logCache.get(filePath)
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      // True LRU: a hit moves the entry to the young end of the insertion order.
      logCache.delete(filePath)
      logCache.set(filePath, cached)
      return cached.events
    }
    const { loadSessionLog } = await import('dsh-log-contract')
    const log = loadSessionLog(filePath)
    const events = log.events.map((r) => r.event)
    rememberLog(filePath, { size: info.size, mtimeMs: info.mtimeMs, events })
    return events
  } catch { return null }
}

/**
 * 从全量事件计算遮蔽范围(业务逻辑,基于通用事件,与 DSH 无关)。
 *
 * 2026-09-07 修复(ISSUE-20260907113201-3f9e4f12):nodes 不再从 events 顺序收集
 * (seq 递增的虚拟 nodes),改为**官方 foldSurface 重放得真实 surface nodes**——
 * 官方 replace 会把 marker(新 seq)插入遮蔽范围开头、移除被遮蔽节点 → nodes 非
 * seq 单调。旧算法按 seq 递增假设算 span,写入时官方 nodes 里 indexOf(start/end)
 * 可能 not found(目标已被遮蔽)或倒置(startIdx>endIdx,marker 插入) → S4/S8 拒 →
 * 撤回死锁(evidence 快照实测:target 710693 span[710693..711448] → index 442>441)。
 * 新算法 nodes = 官方 foldSurface 结果 → span 的 start/end 与写入端完全一致,
 * not found/倒置不可能;target 已被遮蔽(不在 nodes)= 返回 null(target-shadowed)。
 *
 * @param {Array} events - 全量事件(通用格式)。
 * @param {number|string} target - seq 或 messageId(round/tail 用);range 模式下为区间起点。
 * @param {'round'|'tail'|'range'} [mode] - round=遮蔽目标轮;tail=遮蔽目标位置之后全部;
 *   range=遮蔽 [target..opts.endSeq] 区间(折叠完成块,三段式窗口批1)。
 * @param {object} [opts] - range 模式:opts.endSeq = 区间终点(必须为 surface 节点)。
 */
export function computeSpan(events, target, mode = 'round', opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return null
  let seq = typeof target === 'number' ? target : -1
  if (seq === -1) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      const id = ev?.type === 'user/message' || ev?.type === 'assistant/message' ? messageIdOf(ev) : undefined
      if (typeof id === 'string' && id === target) { seq = ev.seq; break }
    }
  }
  if (seq === -1 || !eventAt(events, seq)) return null
  // 官方 foldSurface 重放 = 与写入端一致的当前 surface(含 marker 插入效应、排除被遮蔽节点)
  let nodes
  try {
    const folded = foldSurface(events)
    nodes = folded?.nodes
  } catch {
    return null
  }
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const index = nodes.indexOf(seq)
  if (index === -1) return null // 目标已被遮蔽/不在 surface → 调用方报 target-shadowed
  if (mode === 'range') {
    // range:折叠完成块区间 [seq..endSeq]——位置连续段(三段式窗口批1 marker 折叠承载)。
    // 端点必须是 surface 节点;区间可含 marker(先前折叠节点,折叠链收敛语义)。
    const endSeq = typeof opts?.endSeq === 'number' ? opts.endSeq : seq
    const endIndex = nodes.indexOf(endSeq)
    if (endIndex === -1) return null
    if (index > endIndex) return null
    const shadowedSeqs = nodes.slice(index, endIndex + 1)
    if (shadowedSeqs.length === 0) return null
    return { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs }
  }
  if (mode === 'tail') {
    // tail:从目标所在轮首遮蔽到 surface 尾(撤回 = 移除整轮 input+output + 其后全部,
    // R2 语义;目标若是轮内 assistant/tool 则回退到轮首 user,防孤立输入)。
    let startPos = index
    for (let i = index; i >= 0; i--) { if (isRoundBoundary(eventAt(events, nodes[i]))) { startPos = i; break } }
    const shadowedSeqs = nodes.slice(startPos)
    if (shadowedSeqs.length === 0) return null
    return { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs }
  }
  // round:目标轮(在官方 nodes 位置序上找轮边界;marker 是 assistant/message 非轮边界)
  let startIdx = index
  for (let i = index; i >= 0; i--) { if (isRoundBoundary(eventAt(events, nodes[i]))) { startIdx = i; break } }
  let endIdx = nodes.length - 1
  for (let i = startIdx + 1; i < nodes.length; i++) { if (isRoundBoundary(eventAt(events, nodes[i]))) { endIdx = i - 1; break } }
  const span = nodes.slice(startIdx, endIdx + 1)
  if (span.length === 0) return null
  return { start: span[0], end: span[span.length - 1], shadowedSeqs: span }
}

/**
 * DSH 适配器:EventReader 实现。
 * 从文件读全量事件(可靠事实),并提供基于它的遮蔽计算。
 */
export const dshAdapter = {
  reader: { readEvents },
  /** 便捷:读事件 + 算遮蔽一步到位(供 index.js/http.js 注入 args.span)。 */
  async spanFromFile(sessionId, target, mode = 'round', opts = {}) {
    const events = await readEvents(sessionId)
    return computeSpan(events, target, mode, opts)
  },
  /** 最后一条 session/title 的标题(读文件;读不到返回空串)。 */
  async titleFromFile(sessionId) {
    const events = await readEvents(sessionId)
    if (!Array.isArray(events)) return ''
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'session/title') return String(events[i].data?.title ?? '')
    }
    return ''
  },
  /**
   * 水位体检 + 折叠建议(三段式批4):读文件 → 测量水位(中文校正)+ 候选折叠块
   * (头部之后最老完成块)+ 收益估算。全中文建议给正解。
   */
  async waterLevelFromFile(sessionId, opts = {}) {
    const events = await readEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return null
    const { measureWaterLevel, estimateRangeTokens } = await import('../water-level.js')
    const { foldBoundaryFrom } = await import('../fold-boundary.js')
    const level = measureWaterLevel(events, opts)
    // 折叠候选:foldSurface nodes 里最早的完成块(跳过头部?基础版:找 nodes 首 user 轮起
    // 的单轮完成块;fold-boundary 从 nodes[0] 附近 user 起)。收益 = 块内消息 token 估算。
    let suggestion = null
    if (level.band !== 'green') {
      const nodes = (() => { try { return foldSurface(events).nodes } catch { return [] } })()
      const firstUser = nodes.find((s) => events[s]?.type === 'user/message')
      if (firstUser !== undefined) {
        const b = foldBoundaryFrom(events, firstUser)
        if (b) {
          const gain = estimateRangeTokens(events, rangeSeqs(nodes, b.start, b.end))
          suggestion = {
            foldRange: { start: b.start, end: b.end, rounds: b.rounds, reason: b.reason },
            gainTokens: gain,
            afterPct: Math.max(0, (level.cjkTokens - gain) / level.window),
          }
        }
      }
    }
    return { ...level, suggestion }
  },
  /**
   * unfold 展开数据(三段式批3,视图层回填):读文件 → 找 fold marker 的 sourceEventSeqs
   * → 提取被遮蔽 seq 的消息内容(按序,供客户端渲染整块供人回看)。模型上下文不变(仍=摘要)。
   * 逆序链式定位 = 按 markerSeq 找(展开指定折叠块)。
   */
  async unfoldContentFromFile(sessionId, markerSeq, filePath) {
    const events = filePath ? await readEventsFromFile(filePath) : await readEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return null
    // 现行日志首事件 seq=0(index==seq),但窗口化/旧格式不保证——按值找 seq,不靠下标。
    const marker = events.find((e) => e?.seq === Number(markerSeq))
    // Fold markers exist in both generations: legacy `assistant/message` with
    // data.message.id, current `user/message` with data.id. Recognise by id, not
    // by event type (a type check silently hides every fold written today).
    const markerId = marker && editorOf(marker) ? messageIdOf(marker) : null
    if (!marker || typeof markerId !== 'string' || !markerId.startsWith('retrace-fold-')) {
      return null
    }
    const shadowed = shadowedSeqsOf(marker)
    if (shadowed.length === 0) return null
    const bySeq = new Map(events.map((e) => [e?.seq, e]))
    const rows = []
    for (const seq of shadowed) {
      const ev = bySeq.get(seq)
      if (!ev) continue
      const type = ev.type
      let text = ''
      if (type === 'user/message') {
        text = Array.isArray(ev.data?.content) ? ev.data.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
      } else if (type === 'assistant/message') {
        text = Array.isArray(ev.data?.message?.content) ? ev.data.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
      }
      rows.push({ seq, type: type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : 'tool', text })
    }
    return { markerSeq: Number(markerSeq), rows }
  },
  /**
   * 折叠摘要(三段式批2):读文件 → 区间事件切片 → 确定摘要。
   * 区间含边界事件(完整 turn 结构);摘要纯函数确定性。
   */
  async summaryFromFile(sessionId, start, end) {
    const events = await readEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return null
    const lo = Number(start)
    const hi = Number(end)
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo) return null
    // Slice by seq, not by array index: current logs start at seq 0, but the
    // windowed/legacy shapes do not guarantee index === seq.
    const slice = events.filter((event) => typeof event?.seq === 'number' && event.seq >= lo && event.seq <= hi)
    if (slice.length === 0) return null
    const { buildFoldSummary } = await import('../fold-summary.js')
    return buildFoldSummary(slice, { start: lo, end: hi })
  },
  /**
   * 从文件全量事件算某 turn 内的最大 step 号(情形② marker step 分配用)。
   * 绕开 host 窗口化 session.events(稀疏内存视图可能看不到 turn 内全部 step,
   * 算小 → 新 step 号与窗口外既有 step 冲突 = step key 冲突白屏,1e99e1ff 复盘)。
   * 失败返回 null(调用方 fallback 内存扫描)。
   * @param {string} [filePath] 可选:直接指定会话文件路径(测试注入)。
   */
  async maxStepInTurnFromFile(sessionId, turn, filePath) {
    const events = filePath ? await readEventsFromFile(filePath) : await readEvents(sessionId)
    if (!Array.isArray(events)) return null
    let max = 0
    for (const ev of events) {
      if (ev?.type === 'step/start' && ev.data?.turn === turn) {
        const step = ev.data?.step
        if (typeof step === 'number' && Number.isSafeInteger(step) && step > max) max = step
      }
    }
    return max
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 语义短码推导(2026-09-02)——工作区 createdAt 序号 + 父链,与修复线
// gen-session-codes.mjs 同规则(表的新鲜版,不冲突)。
// 短码 = 工作区2 + 序号3 + 父工作区2 + 父序号3;根父 = FF000。
// 只读会话文件帧1(header),全量 ~110 会话 ≈ 30ms,懒加载缓存。
// ─────────────────────────────────────────────────────────────────────────────

/** 工作区目录名 → 2 位缩写(与 gen-session-codes.mjs 同逻辑: …/Users/<账号>/opena → op)。 */
function workspaceAbbr(workspace) {
  const name = String(workspace)
    .replace(/^[A-Za-z]--Users-[^-]+-/, '') // C--Users-<account>-…
    .replace(/^--Users-[^-]+-/, '')
    .replace(/^-+|-+$/g, '')
  const parts = name.split('-').filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toLowerCase()
  return (parts[0] ?? name).slice(0, 2).toLowerCase()
}

/** 派生短码表:扫全部工作区会话 header,按 createdAt 排序编号,含父链。 */
export async function deriveBadgeTable() {
  const { readSessionHeader } = await import('dsh-log-contract')
  const root = join(resolveDshHome(), 'sessions')
  const rows = [] // { id, ws, createdAt, parent }
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let sids
    try { sids = readdirSync(wsDir) } catch { continue }
    for (const sid of sids) {
      let header
      try {
        const logFile = newestSessionLog(join(wsDir, sid))
        if (!logFile) continue
        header = readSessionHeader(logFile)
      } catch {
        continue
      }
      if (!header || typeof header.id !== 'string') continue
      rows.push({
        id: header.id,
        ws: workspaceAbbr(workspace),
        createdAt: header.createdAt ?? 0,
        parent: typeof header.parentSession === 'string' ? header.parentSession : null,
      })
    }
  }
  // 工作区内按 createdAt 排序 → 序号(与 gen-session-codes 一致)
  const byWs = {}
  for (const r of rows) (byWs[r.ws] ??= []).push(r)
  const seqOf = new Map() // sessionId → { ws, seq }
  for (const ws of Object.keys(byWs)) {
    byWs[ws].sort((a, b) => a.createdAt - b.createdAt)
    byWs[ws].forEach((r, i) => seqOf.set(r.id, { ws, seq: i + 1 }))
  }
  const WS = 2
  const SEQ = 3
  const pad = (n) => String(n).padStart(SEQ, '0')
  const codes = {}
  for (const r of rows) {
    const self = seqOf.get(r.id)
    if (!self) continue
    const selfCode = `${self.ws}${pad(self.seq)}`
    const parentInfo = r.parent ? seqOf.get(r.parent) : null
    codes[r.id] = parentInfo
      ? `${selfCode}${parentInfo.ws}${pad(parentInfo.seq)}`
      : `${selfCode}FF${'0'.repeat(SEQ)}`
  }
  return codes
}

let deriveCache = null
let derivePromise = null

/** 语义短码(推导):懒加载缓存;会话不在表(如已删/新加入但未扫)返回 null。 */
export async function semanticBadgeOf(sessionId) {
  const id = String(sessionId ?? '')
  if (deriveCache !== null) return deriveCache[id] ?? null
  derivePromise ??= deriveBadgeTable().then((codes) => {
    deriveCache = codes
    return codes
  }).catch(() => {
    deriveCache = {}
    return deriveCache
  })
  const codes = await derivePromise
  return codes[id] ?? null
}

/** 刷新推导缓存(新会话创建/删除后调用,后台)。 */
export function invalidateBadgeDerive() {
  deriveCache = null
  derivePromise = null
}
