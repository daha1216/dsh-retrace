/**
 * dsh-retrace — Host plugin entry (published form).
 *
 * Registers the retrace operations behind two transports so the same
 * package serves both the desktop/web GUI and headless deployments:
 *
 *  - `harness.handle` when present (the dynamic-package RPC bridge), and
 *  - a same-origin HTTP route under `/api/plugins/retrace/*` for
 *    bundled (published) client modules.
 *
 * The HTTP surface additionally serves the P0 versioning channels:
 * `GET /versions` (projection snapshot fallback), `GET /event` and
 * `GET /surface` (lazy sessionQuery reads). The versioning seam itself
 * (`lib/versioning.js`) lives behind `ctx.inject(...)` — headless
 * compositions without the projection/storage services simply degrade to
 * plain L1 (recall / edit / regenerate), exactly like 0.2.x.
 *
 * Every op resolves to a result object `{ ok: true, value }` /
 * `{ ok: false, error }` produced by the host core, so both transports carry
 * the identical wire shape.
 */
import { createEditorApi } from './host-core.js'
import { createRetraceHttpHandler, ROUTE_PREFIX } from './http.js'
import { createVersioningSeam } from './versioning.js'
import { createRollbackExecutor } from './rollback.js'
import { createMarkerGuard } from './prewrite-guard.js'
import { createWatchdog } from './watchdog.js'
import { attachExitWarning } from './interrupt-guard.js'
import { sessionBadge as fnvBadge } from './badge.js'
import { dshAdapter, semanticBadgeOf } from './adapter/dsh.js'
import { createDshMarkerWriter } from './adapter/dsh-writer.js'
import { capabilitiesFromEnv, gateEditorApi, resolveCapabilities } from './capabilities.js'
import { withoutClientSpan } from './request-guard.js'
import { Session } from '@deepseek-ai/dsh-session'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 语义短码（2026-09-01 对齐修复线定稿规则）：优先查 `会话短码表.json`
 * （工作区+序号+父子语义，如 op065op016），命中即返回；否则 FNV 兜底。
 * 短码表由 `tools/gen-session-codes.mjs` 生成（基于 header.createdAt + parentSession）。
 */
const BADGE_TABLE_PATH = join(homedir(), 'opena-archive-2026-08', '会话短码表.json')
let badgeTable = null
try {
  badgeTable = JSON.parse(readFileSync(BADGE_TABLE_PATH, 'utf8')).codes ?? null
} catch { /* 表缺失时 FNV 兜底 */ }
/**
 * 会话短码(2026-09-02 v2,三级):
 * ① archive 短码表(修复线维护,固定);
 * ② 实时推导(工作区 createdAt 序号+父链,与 gen-session-codes.mjs 同规则,
 *    表的新鲜超集——新 fork 会话也能得到语义短码);
 * ③ FNV-1a 确定性兜底(任何环境可复现,人机交互最低保障)。
 */
async function sessionBadge(sessionId) {
  const semantic = badgeTable?.[sessionId]
  if (typeof semantic === 'string' && semantic.length > 0) return semantic
  try {
    const derived = await semanticBadgeOf(sessionId)
    if (derived) return derived
  } catch { /* 推导失败 → FNV 兜底 */ }
  return fnvBadge(sessionId)
}

export const name = 'dsh-retrace'
export const inject = ['sessions', 'agents', 'webServer', 'fs', 'subprocess', 'sandboxPolicy']

/**
 * 宿主契约探测（工作包 B6）。
 *
 * 本构建的读契约按现行 Session（`snapshotEvents()` + `surface.nodes` + 官方
 * surface fold）验证；旧版宿主的 `session.events` 只保留只读兼容。探测失败时
 * 不猜兼容：关闭写入能力，时间线仍可只读浏览。
 */
function probeHostContract() {
  try {
    const prototype = Session?.prototype
    return {
      snapshotEvents: typeof prototype?.snapshotEvents === 'function',
      surfaceNodes: typeof prototype?.surface === 'object' || typeof Object.getOwnPropertyDescriptor(prototype ?? {}, 'surface')?.get === 'function',
    }
  } catch {
    return { snapshotEvents: false, surfaceNodes: false }
  }
}

export function apply(ctx) {
  const log = (line) => ctx.logger?.info(line)

  // Capability gates (lib/capabilities.js): restore/capture/GC ship off until
  // the storage and recovery work packages prove them safe on real data.
  const hostContract = probeHostContract()
  const requested = resolveCapabilities(capabilitiesFromEnv())
  // 契约不明（既无 snapshotEvents 也无 surface）→ 只读：拒绝一切写入，不猜兼容。
  const writable = hostContract.snapshotEvents
  const capabilities = writable ? requested : { ...requested, contextEdit: false }
  log(`retrace: capabilities ${JSON.stringify(capabilities)}`)
  if (!writable) {
    log('retrace: host session contract not recognised (no snapshotEvents) — running read-only; context edits are refused with capability-disabled')
  }

  // P0 versioning seam: projection unit + artifact snapshots + config view.
  const seam = createVersioningSeam(ctx, log, {
    capabilities,
    // Every session the projection sees gets the one-time badge-prefix cleanup:
    // a boot sweep alone misses sessions opened later.
    onSessionSeen: (session) => { void cleanBadgeTitle(session?.id, session) },
  })
  seam.register()

  // 写前校验守卫（8-25 事故闭环）：marker 落盘前过三层契约；依赖缺失自动降级。
  const guard = createMarkerGuard({
    log,
    enabled: (sessionId) => seam.configFor(sessionId).prewrite !== false,
  })
  // 遮蔽写入器（2026-09-02 抽象设计落地）：业务层表达「遮蔽这些消息」，
  // DSH 的 turn/step 翻译（三情形/计数器推进/窗口化防御）隔离在 adapter。
  const markerWriter = createDshMarkerWriter({
    agents: ctx.agents,
    validateMarker: guard.validateMarkerAppend,
    // 情形② step 号从文件全量算（host 窗口化内存不可信，1e99e1ff 复盘 §五）
    readMaxStep: async (sessionId, turn) => dshAdapter.maxStepInTurnFromFile(sessionId, turn),
    log,
  })
  // `onSession` lets the HTTP layer ask for the one-time badge-prefix cleanup
  // when a session shows up after the boot sweep (declared before hooks: the
  // cleanup helpers below are hoisted function declarations).
  const hooks = {
    validateMarker: guard.validateMarkerAppend,
    writeMarker: markerWriter.writeMarker,
    onSession: (sessionId) => { void cleanBadgeTitle(sessionId, ctx.sessions?.get?.(sessionId)) },
  }

  // P1 rollback executor: context/artifact restore over the seam (git + snapshots).
  const rollback = createRollbackExecutor({ ctx, sessions: ctx.sessions, agents: ctx.agents, seam, validateMarker: hooks.validateMarker, writeMarker: hooks.writeMarker, log, capabilities })

  const api = gateEditorApi(createEditorApi(ctx, ctx.sessions, ctx.agents, log, hooks), capabilities)

  // ── 会话短码 / 标题 / 水位（HTTP 与 harness 桥共用）─────────────────────────
  // 0.4.x 里这些操作只挂在 harness 桥上；发布桌面模式没有 `harness` 全局，
  // 整块桥是 no-op，于是短码/标题/水位在桌面版全部失效（HTTP 404）。
  // 现在抽到装配层，两条传输共用同一实现。
  function readTitleFromEvents(session) {
    const events = Array.isArray(session?.events) ? session.events : null
    if (!events) return ''
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'session/title') return String(events[i].data?.title ?? '')
    }
    return ''
  }

  /** 当前标题：内存事件优先，稀疏/窗口化时回退读会话日志。 */
  async function currentTitleOf(sessionId, session) {
    const fromEvents = readTitleFromEvents(session)
    if (fromEvents) return fromEvents
    try {
      return await dshAdapter.titleFromFile(sessionId)
    } catch {
      return ''
    }
  }

  /** 官方 rename pin:user source title → 关闭自动改名 + 投影刷新。 */
  function pinTitle(session, title) {
    const titles = ctx.get?.('sessionTitle')
    if (session && titles && typeof titles.rename === 'function') {
      try { titles.rename(session, title); return true } catch { /* fallback append */ }
    }
    session?.append?.('session/title', { title, source: { kind: 'user' } })
    return true
  }

  /**
   * The short code is a display label, not part of the title. Older builds
   * prefixed it onto every session they touched, so strip that prefix back off
   * once per session and leave the human title alone from then on.
   */
  // Badges are mixed case (e.g. dd833FF000): match case-insensitively.
  const BADGE_PREFIX_RE = /^\[[a-z0-9]{6,}\]\s*/i
  const cleanedTitles = new Set()

  async function cleanBadgeTitle(sessionId, session) {
    const sid = String(sessionId ?? '')
    if (!sid || cleanedTitles.has(sid)) return { sessionId: sid, skipped: 'already-checked' }
    cleanedTitles.add(sid)
    try {
      const currentTitle = await currentTitleOf(sid, session)
      if (!currentTitle || !BADGE_PREFIX_RE.test(currentTitle)) return { sessionId: sid, skipped: 'clean' }
      const clean = currentTitle.replace(BADGE_PREFIX_RE, '')
      if (!clean) return { sessionId: sid, skipped: 'empty-after-strip' }
      pinTitle(session, clean)
      return { sessionId: sid, restored: clean }
    } catch (error) {
      return { sessionId: sid, error: String(error) }
    }
  }

  async function sessionBadgeOp(args) {
    const sessionId = String(args?.sessionId ?? '')
    return { ok: true, value: { sessionId, badge: await sessionBadge(sessionId) } }
  }

  /** Kept for API compatibility: reports the title, never writes one. */
  async function setBadgeTitleOp(args) {
    const sessionId = String(args?.sessionId ?? '')
    if (!sessionId) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } }
    const session = ctx.sessions?.get?.(sessionId)
    if (!session) return { ok: false, error: { code: 'not-found', message: 'session not found' } }
    try {
      const badge = await sessionBadge(sessionId)
      const currentTitle = await currentTitleOf(sessionId, session)
      return { ok: true, value: { title: currentTitle, badge, written: false, note: 'the short code is display-only; titles are never rewritten' } }
    } catch (error) {
      return { ok: false, error: { code: 'internal', message: String(error) } }
    }
  }

  /** User-initiated rename: writes exactly what the user typed, no badge prefix. */
  async function setUserTitleOp(args) {
    const sessionId = String(args?.sessionId ?? '')
    const title = String(args?.title ?? '').trim().replace(BADGE_PREFIX_RE, '')
    if (!sessionId) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } }
    if (!title) return { ok: false, error: { code: 'bad-request', message: 'title required' } }
    const session = ctx.sessions?.get?.(sessionId)
    if (!session) return { ok: false, error: { code: 'not-found', message: 'session not found' } }
    try {
      pinTitle(session, title)
      cleanedTitles.add(sessionId)
      return { ok: true, value: { title } }
    } catch (error) {
      return { ok: false, error: { code: 'internal', message: String(error) } }
    }
  }

  /** Strip badge prefixes left by older builds from every resident session. */
  async function pinAllResident() {
    const results = []
    const sessionStore = ctx.sessions
    if (!sessionStore || (typeof sessionStore.list !== 'function' && typeof sessionStore.values !== 'function')) {
      return { ok: false, error: { code: 'unavailable', message: 'session store not enumerable' } }
    }
    try {
      const sessions = typeof sessionStore.list === 'function' ? sessionStore.list() : [...sessionStore.values()]
      for (const session of sessions) {
        const sessionId = session?.id ?? session?.sessionId
        if (!sessionId) continue
        results.push(await cleanBadgeTitle(sessionId, session))
      }
      return { ok: true, value: { total: results.length, results } }
    } catch (error) {
      return { ok: false, error: { code: 'internal', message: String(error) } }
    }
  }

  /** 会话水位体检 + 折叠建议（中文文案给正解）。 */
  async function waterLevelOp(args) {
    const sessionId = String(args?.sessionId ?? '')
    const level = await dshAdapter.waterLevelFromFile(sessionId, {
      window: Number(args?.window) || undefined,
    })
    if (!level) return { ok: false, error: { code: 'session-not-found', message: '会话文件不可读' } }
    const bandText = { green: '🟢 健康', yellow: '🟡 接近黄线', red: '🔴 超红线' }[level.band] ?? '?'
    const pctText = `${Math.round(level.pct * 100)}%`
    const adv = []
    if (level.band === 'green') {
      adv.push(`水位${bandText}(${pctText}),缓存红利中,无需动作。`)
    } else if (level.suggestion) {
      const s = level.suggestion
      adv.push(`水位${bandText}(${pctText}),余量约 ${Math.round(level.remaining / 10000)} 万 token。`)
      adv.push(`建议折叠最早完成块(seq ${s.foldRange.start}..${s.foldRange.end},${s.foldRange.rounds} 轮),释放约 ${s.gainTokens} token,折叠后水位降至约 ${Math.round(s.afterPct * 100)}%。`)
      if (level.band === 'red') adv.push('红线前必须已折(官方自动压缩会折头部=缓存全断);若仍逼近,请 fork 续聊。')
    }
    return { ok: true, value: { ...level, advice: adv.join('\n') } }
  }

  const badgeOps = {
    sessionBadge: sessionBadgeOp,
    setBadgeTitle: setBadgeTitleOp,
    setUserTitle: setUserTitleOp,
    initBadgeTitles: pinAllResident,
    waterLevel: waterLevelOp,
  }

  const handler = createRetraceHttpHandler(ctx, {
    sessions: ctx.sessions,
    agents: ctx.agents,
    seam,
    rollback,
    hooks,
    badge: badgeOps,
    capabilities,
    hostContract,
    log,
  })

  const disposeRoute = (() => {
    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.register === 'function') {
      try {
        return webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler,
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-retrace: route registration failed: ${String(error)}`)
      }
    }
    return () => {}
  })()

  // Dynamic-package bridge: no-op when this file runs as a plain published plugin.
  const disposeHarness = (() => {
    if (typeof harness === 'undefined' || !harness || typeof harness.handle !== 'function') return () => {}

    // 2026-09-01:操作前从文件算遮蔽(绕开 host 稀疏 session.events,用户方案)
    const withFileSpan = (op, modeOf) => async (rawArgs) => {
      // 情形② step 号:writer 的 readMaxStep 已在装配时注入(index.js createDshMarkerWriter
      // 闭包,从文件全量算)——不再经 args 传递(3e2262a 下沉后 writer 是唯一消费方)。
      // The span decides how much surface a marker replaces and the rollback
      // preflight only counts its length — never trust one supplied by the RPC
      // caller either (the HTTP route strips it for the same reason).
      let args = withoutClientSpan(rawArgs)
      try {
        // fold 用 args.start(range 起点);其余 op 用 seq/messageId。
        const target = op === 'fold' ? Number(args?.start) : (typeof args?.seq === 'number' ? args.seq : args?.messageId)
        if (target !== undefined && target !== null) {
          const spec = modeOf(args)
          const mode = typeof spec === 'string' ? spec : spec?.mode
          const endSeq = typeof spec === 'object' && spec ? spec.endSeq : undefined
          const span = await dshAdapter.spanFromFile(args.sessionId, target, mode, endSeq !== undefined ? { endSeq } : undefined)
          log(`retrace: spanFromFile(op=${op} target=${String(target).slice(0, 24)} mode=${mode}) → ${span ? `${span.shadowedSeqs.length} seqs` : 'null(fallback)'}`)
          if (span) args = { ...args, span }
        } else {
          log(`retrace: spanFromFile skipped(op=${op} target=${String(target).slice(0, 24)})`)
        }
      } catch (error) { log(`retrace: spanFromFile wrapper error: ${String(error).slice(0, 120)}`) }
      return api[op](args)
    }
    /**
     * 启动清理:旧版本把短码写进了标题,这里把前缀摘掉还回原标题。会话渐进驻留,
     * 所以保留少量重试;每个会话只处理一次(cleanedTitles),不会反复写标题。
     */
    const BOOT_PIN_ATTEMPTS = 3
    let bootPinTimer = null
    let bootPinDisposed = false
    function scheduleBootPin(attempts) {
      if (bootPinDisposed || attempts >= BOOT_PIN_ATTEMPTS) return
      bootPinTimer = setTimeout(() => {
        bootPinTimer = null
        bootPin(attempts + 1)
      }, 30000)
    }
    function bootPin(attempts = 0) {
      if (bootPinDisposed) return
      const sessionStore = ctx.sessions
      const hasSessions = sessionStore && (
        (typeof sessionStore.list === 'function' && sessionStore.list().length > 0) ||
        (typeof sessionStore.values === 'function' && sessionStore.values().length > 0)
      )
      if (!hasSessions) {
        scheduleBootPin(attempts)
        return
      }
      pinAllResident()
        .then((result) => {
          log(`retrace: bootPin(${attempts}) → ${result?.value?.total ?? 0} 个驻留会话已检查标题前缀`)
          scheduleBootPin(attempts)
        })
        .catch((error) => {
          log(`retrace: bootPin error: ${String(error).slice(0, 160)}`)
          scheduleBootPin(attempts)
        })
    }
    bootPin(0)
    const disposers = [
      // 2026-09-07:recall 语义 = 遮蔽目标轮及之后全部(编辑=从此处分叉,bfb965e4/
      // 3f9e4f12 issue 要求)——不再只遮蔽目标轮(缺陷①断层);tail 在官方 foldSurface
      // nodes 上按位置切(ISSUE-20260907113201 修复),大范围遮蔽由快照点守卫引导分支。
      harness.handle('retrace.recall', withFileSpan('recall', () => 'tail')),
      harness.handle('retrace.editAndResend', withFileSpan('editAndResend', (a) => (a?.fromScratch ? 'tail' : 'round'))),
      harness.handle('retrace.regenerate', withFileSpan('regenerate', () => 'round')),
      // 三段式窗口批1:fold 完成块区间(marker 折叠承载,range mode)
      // 三段式批4:waterLevel(会话水位体检 + 折叠建议,中文文案给正解)
      harness.handle('retrace.waterLevel', waterLevelOp),
      // 三段式批3:unfold(视图层展开数据,从日志读被遮蔽内容,模型上下文不变)
      harness.handle('retrace.unfold', async (args) => {
        const markerSeq = Number(args?.markerSeq)
        if (!Number.isInteger(markerSeq) || markerSeq < 0) {
          return { ok: false, error: { code: 'bad-request', message: 'unfold 需要 fold marker 的 seq' } }
        }
        const content = await dshAdapter.unfoldContentFromFile(String(args?.sessionId ?? ''), markerSeq)
        if (!content) return { ok: false, error: { code: 'marker-not-found', message: '指定 seq 不是 retrace-fold- 折叠 marker 或无遮蔽内容' } }
        return { ok: true, value: content }
      }),
      harness.handle('retrace.fold', (async (args) => {
        const withSpan = withFileSpan('fold', (a) => ({ mode: 'range', endSeq: Number(a?.end) }))
        // fold 摘要:从文件生成(确定摘要,批2)注入 args.summary
        if (!args?.summary) {
          const start = Number(args?.start)
          const end = Number(args?.end)
          if (Number.isInteger(start) && Number.isInteger(end)) {
            try {
              const summary = await dshAdapter.summaryFromFile(args.sessionId, start, end)
              if (summary) args = { ...args, summary }
            } catch { /* 摘要失败不阻断折叠(空 content) */ }
          }
        }
        return withSpan(args)
      })),
      // 会话短码（2026-08-31）：session id → 确定性 10 位短码，人机交互识别用。
      harness.handle('retrace.sessionBadge', sessionBadgeOp),
      // 短码只做展示：该 op 只回报当前标题，绝不写入（0.4.74 起）。
      harness.handle('retrace.setBadgeTitle', setBadgeTitleOp),
      // 用户自定义会话名称：原样写入用户输入，不加短码前缀。
      harness.handle('retrace.setUserTitle', setUserTitleOp),
      harness.handle('retrace.initBadgeTitles', () => pinAllResident()),
      // The 30s retry chain must not outlive the plugin fiber: on a dynamic
      // reload the old instance would keep pinning titles after dispose.
      () => {
        bootPinDisposed = true
        if (bootPinTimer !== null) {
          clearTimeout(bootPinTimer)
          bootPinTimer = null
        }
      },
    ]
    return () => disposers.forEach((dispose) => dispose())
  })()

  // R1 实时看门狗：轮询文件尾部 seq vs 内存长度，捕获并发写入/旧光标回放现场。
  // 2.0.x 的内存事件可能窗口化（长度与文件 seq 不可比），默认关闭，仅诊断时开。
  const watchdog = createWatchdog(ctx, log, { enabled: globalThis.process?.env?.DSH_RETRACE_WATCHDOG === '1' })

  // R4 中断轮次治理：退出/重载时对未闭合 turn 会话提示（只检测不写事件）。
  const warnUnclosed = attachExitWarning(ctx, log)

  ctx.effect(() => () => {
    disposeRoute()
    disposeHarness()
    watchdog.dispose()
    warnUnclosed()
  }, 'dsh-retrace: transports')
}
