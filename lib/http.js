/**
 * dsh-retrace — HTTP route aggregation for `/api/plugins/retrace/*`.
 *
 * Serves both the published-client transports and the versioning surface:
 *
 *   POST /api/plugins/retrace/{recall|editAndResend|regenerate}
 *     — the L1 editor ops (unchanged wire shape from 0.2.x).
 *   GET  /api/plugins/retrace/versions?sessionId=
 *     — live projection snapshot (HTTP fallback channel; the push channel is
 *       `session/projection` frames via dsh-host-apiproxy).
 *   GET  /api/plugins/retrace/forkmap?sessionId=
 *     — the fork-map projection snapshot (branch topology, P2.1; same
 *       push-frame + HTTP fallback dual channel as /versions).
 *   GET  /api/plugins/retrace/event?sessionId=&seq=&before=&after=
 *     — one event + context window (sessionQuery.readEvent, lazy reads).
 *   GET  /api/plugins/retrace/surface?sessionId=
 *     — current model surface (sessionQuery.readSurface).
 *   POST /api/plugins/retrace/rollback/preview
 *     — dry-run: messages removed + artifact actions (no side effects).
 *   POST /api/plugins/retrace/rollback
 *     — execute the rollback ({sessionId, versionId, scope}).
 *   GET  /api/plugins/retrace/git/status?sessionId=
 *     — repo detection + HEAD + dirty (timeline git banner).
 *   POST /api/plugins/retrace/git/init
 *     — one-click git init for a non-repository workspace (user-confirmed).
 *   GET  /api/plugins/retrace/storage
 *   GET  /api/plugins/retrace/doctor?sessionId=
 *     — compression pre-check: scan for token-meter-breaking turn-null markers
 *       (B1, incident root cause 3) — read-only.
 *   GET  /api/plugins/retrace/snapshot?sessionId=&versionId=&path=
 *     — read one version's snapshot content (rollback preview / detail).
 *
 * Per PLAN.md §4.6 the client carries its localStorage config on every
 * request as `x-retrace-config: {"versioning":bool,"git":bool,
 * "retentionLimit":n}`; the host honors it per request and does not persist
 * it. A missing/malformed header falls back to the plugin defaults.
 */
import { createEditorApi } from './host-core.js'
import { dshAdapter } from './adapter/dsh.js'
import { gateEditorApi } from './capabilities.js'
import { isLoopbackRequest, withoutClientSpan } from './request-guard.js'
export const ROUTE_PREFIX = '/api/plugins/retrace'
const MAX_BODY_BYTES = 64 * 1024

/** Read budget for one snapshot response (capture writes cap files at 4 MiB). */
const MAX_SNAPSHOT_READ_BYTES = 4 * 1024 * 1024

/** Requests from this plugin's own UI carry this header (see client.js). */
const CLIENT_HEADER_VALUE = 'web'

/** A tunnel/LAN host is opt-in: the route is unauthenticated by design. */
const REMOTE_ALLOWED = process.env.DSH_RETRACE_ALLOW_REMOTE === '1'

/** Default per-request config (client overrides via the header). */
export const DEFAULT_CONFIG = { versioning: true, git: true, retentionLimit: 50, prewrite: true }

/** Parse the `x-retrace-config` request header (tolerant of garbage). */
export function parseRetraceConfig(raw) {
  const config = { ...DEFAULT_CONFIG }
  if (typeof raw !== 'string' || raw.length === 0) return config
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.versioning === 'boolean') config.versioning = parsed.versioning
    if (typeof parsed.git === 'boolean') config.git = parsed.git
    if (Number.isInteger(parsed.retentionLimit) && parsed.retentionLimit > 0) {
      config.retentionLimit = parsed.retentionLimit
    }
    if (typeof parsed.prewrite === 'boolean') config.prewrite = parsed.prewrite
  } catch {
    // malformed header → defaults
  }
  return config
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Config carried by a request, or `null` when the caller sent no header.
 *
 * `parseRetraceConfig('')` returns the defaults, and applying defaults on every
 * GET reset the per-session config (a user setting turned off came back on as
 * soon as the timeline polled a route without the header).
 */
function configFromRequest(req) {
  const raw = req.headers['x-retrace-config']
  return typeof raw === 'string' && raw.length > 0 ? parseRetraceConfig(raw) : null
}

/** HTTP status for a plugin error code; the body keeps the {ok:false,error} shape. */
function statusForCode(code) {
  switch (code) {
    case 'bad-request':
    case 'bad-json':
    case 'bad-fold-range':
    case 'bad-scope':
    case 'blank-text':
    case 'empty-surface':
    case 'no-prompt':
    case 'no-text':
    case 'not-assistant-message':
    case 'not-user-message':
    case 'unsupported-media-type':
    case 'confirm-required':
      return 400
    case 'origin-not-allowed':
    case 'host-not-allowed':
    case 'client-header-required':
      return 403
    case 'session-not-found':
    case 'not-found':
    case 'target-shadowed':
    case 'marker-not-found':
    case 'message-not-found':
    case 'version-not-found':
    case 'unknown-op':
    case 'undo-not-found':
      return 404
    // Rollback plans are single-use and bound to the preview the user saw.
    case 'plan-required':
    case 'plan-expired':
    case 'plan-used':
    case 'plan-mismatch':
    case 'plan-stale':
    case 'restore-unsupported':
    case 'undo-expired':
    case 'marker-rejected':
    case 'rollback-guide':
    case 'span-unavailable':
    case 'log-unavailable':
    case 'no-cwd':
      return 409
    case 'agent-busy':
    case 'agent-stop-timeout':
    case 'agent-stop-failed':
    case 'agent-unavailable':
    case 'followup-failed':
    case 'working-tree-dirty':
    case 'sandbox-policy-unavailable':
      return 409
    case 'payload-too-large':
      return 413
    case 'writer-unavailable':
    case 'rollback-unavailable':
    case 'versioning-unavailable':
    case 'capability-disabled':
    case 'session-contract':
      return 503
    default:
      return 500
  }
}

function sendError(res, error) {
  const code = error && typeof error.code === 'string' ? error.code : 'internal'
  const status = statusForCode(code)
  // 5xx means "we do not know what broke": the raw message can carry absolute
  // paths and fs internals, so only known conflict/validation codes echo text.
  const message = status >= 500
    ? 'internal error (details in the host log)'
    : (error instanceof Error ? error.message : String(error))
  sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
    },
  })
}

/** Route one request. `seam` is the versioning seam (lib/versioning.js). */
export function createRetraceHttpHandler(ctx, { sessions, agents, seam, rollback, hooks = {}, badge = {}, capabilities = {}, hostContract = null, log = () => {} }) {
  const api = gateEditorApi(createEditorApi(ctx, sessions, agents, log, hooks), capabilities)

  function handleVersions(req, res, sessionId, config) {
    if (config) seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.snapshot(sessionId) })
    } catch (error) {
      sendError(res, error)
    }
  }

  /** What this build may do to real sessions/workspaces (client-side courtesy). */
  function handleCapabilities(req, res) {
    // `hostContract` reports what the plugin verified about the running host, so
    // the client can explain a read-only build instead of silently hiding buttons.
    sendJson(res, 200, { ok: true, value: { ...capabilities, hostContract } })
  }

  function handleForkmap(req, res, sessionId, config) {
    if (config) seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.snapshotForkmap(sessionId) })
    } catch (error) {
      sendError(res, error)
    }
  }

  function handleLineage(req, res, sessionId) {
    try {
      sendJson(res, 200, { ok: true, value: seam.lineage(sessionId) })
    } catch (error) {
      sendError(res, error)
    }
  }

  async function handleEvent(req, res, searchParams) {
    const sessionId = searchParams.get('sessionId') ?? ''
    const seq = Number(searchParams.get('seq'))
    const before = searchParams.has('before') ? Number(searchParams.get('before')) : undefined
    const after = searchParams.has('after') ? Number(searchParams.get('after')) : undefined
    try {
      const value = await seam.readEvent({ sessionId, seq, before, after })
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error)
    }
  }

  async function handleSurface(req, res, sessionId) {
    try {
      const value = await seam.readSurface(sessionId)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error)
    }
  }

  async function handleGitStatus(req, res, sessionId) {
    try {
      const value = await seam.gitStatus(sessionId)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error)
    }
  }

  async function handleDoctor(req, res, sessionId, config) {
    if (config) seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.doctorScan(sessionId) })
    } catch (error) {
      sendError(res, error)
    }
  }

  async function handleStorage(req, res) {
    try {
      sendJson(res, 200, { ok: true, value: await seam.storageInventory() })
    } catch (error) {
      sendError(res, error)
    }
  }

  async function handleSnapshot(req, res, searchParams) {
    const sessionId = searchParams.get('sessionId') ?? ''
    const versionId = searchParams.get('versionId') ?? ''
    const path = searchParams.get('path') ?? ''
    try {
      // Once a session is gone its snapshot bytes must not stay readable by
      // anyone who still knows the id (the ref rows outlive the session).
      if (typeof sessions?.get === 'function' && !sessions.get(sessionId)) {
        const error = new Error(`session "${sessionId}" not found`)
        error.code = 'session-not-found'
        throw error
      }
      const sha = await seam.resolveSnapshot(sessionId, versionId, path)
      if (!sha) {
        sendJson(res, 200, { ok: true, value: { found: false } })
        return
      }
      const bytes = await seam.readSnapshot(sha, { maxBytes: MAX_SNAPSHOT_READ_BYTES })
      // The route decodes the blob into a JSON string: without a cap one
      // request can hold and serialize an arbitrarily large object in memory.
      // The store refuses oversized objects before reading; this is the
      // fallback for seams that do not honor maxBytes.
      if (bytes.byteLength > MAX_SNAPSHOT_READ_BYTES) {
        sendJson(res, 413, {
          ok: false,
          error: { code: 'payload-too-large', message: 'snapshot exceeds the 4 MiB read budget' },
        })
        return
      }
      sendJson(res, 200, {
        ok: true,
        value: {
          found: true,
          sha256: sha,
          sizeBytes: bytes.byteLength,
          text: new TextDecoder().decode(bytes),
        },
      })
    } catch (error) {
      sendError(res, error)
    }
  }

  /**
   * Read a JSON POST body with a hard byte cap. `onReady` runs once; a body
   * that is too large or malformed is answered here and never dispatched.
   */
  function readJsonBody(req, res, onReady) {
    let body = ''
    let size = 0
    let settled = false
    const fail = (status, code, message) => {
      if (settled) return
      settled = true
      sendJson(res, status, { ok: false, error: { code, message } })
    }
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (settled) return
      body += chunk
      size += Buffer.byteLength(chunk, 'utf8')
      if (size > MAX_BODY_BYTES) {
        fail(413, 'payload-too-large', 'payload exceeds 64 KiB')
        req.destroy()
      }
    })
    req.on('error', () => { settled = true })
    req.on('end', () => {
      if (settled) return
      settled = true
      let args = {}
      if (body.length > 0) {
        try {
          args = JSON.parse(body)
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'bad-json', message: 'request body is not valid JSON' } })
          return
        }
      }
      void onReady(args)
    })
  }

  /** POST body parse + dispatch shared by the rollback/git ops. */
  /**
   * Sessions the UI touches after boot still need their badge prefix removed:
   * the boot sweep only sees sessions resident at that moment.
   */
  function notifySession(sessionId) {
    if (!sessionId || typeof hooks?.onSession !== 'function') return
    try { hooks.onSession(sessionId) } catch { /* cleanup must never break an op */ }
  }

  function handleJsonPost(req, res, fn) {
    readJsonBody(req, res, async (args) => {
      const sessionId = String(args?.sessionId ?? '')
      const config = configFromRequest(req)
      if (sessionId && config) seam.setConfig(sessionId, config)
      notifySession(sessionId)
      try {
        const value = await fn(args)
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        sendError(res, error)
      }
    })
  }

  /** Envelope variant of the 5xx redaction: `handlePost`/badge ops bypass sendError. */
  function safeEnvelope(envelope) {
    if (!envelope || envelope.ok !== false) return envelope
    if (statusForCode(envelope.error?.code) < 500) return envelope
    return {
      ok: false,
      error: {
        code: typeof envelope.error?.code === 'string' ? envelope.error.code : 'internal',
        message: 'internal error (details in the host log)',
      },
    }
  }

  /** POST dispatch for ops that already return the `{ ok, … }` envelope. */
  function handleJsonPostEnvelope(req, res, fn) {
    readJsonBody(req, res, async (args) => {
      const sessionId = String(args?.sessionId ?? '')
      const config = configFromRequest(req)
      if (sessionId && config) seam.setConfig(sessionId, config)
      notifySession(sessionId)
      try {
        const envelope = await fn(args)
        const safe = safeEnvelope(envelope)
        const status = safe && safe.ok === false ? statusForCode(safe.error?.code) : 200
        sendJson(res, status, safe)
      } catch (error) {
        sendError(res, error)
      }
    })
  }

  function handlePost(req, res, op) {
    readJsonBody(req, res, async (rawArgs) => {
      // Never trust a caller-supplied span: it selects the surface range a
      // marker replaces, and the rollback-share preflight only counts
      // sourceEventSeqs.length. Recompute from the session log instead.
      let args = withoutClientSpan(rawArgs)
      const sessionId = String(args?.sessionId ?? '')
      const config = configFromRequest(req)
      if (sessionId && config) seam.setConfig(sessionId, config)
      const opFn = api[op]
      if (typeof opFn !== 'function') {
        sendJson(res, 404, { ok: false, error: { code: 'unknown-op', message: `unknown operation "${op}"` } })
        return
      }
      // 情形② step 号:writer 的 readMaxStep 已在 index.js 装配时注入(文件全量算)。
      // 2026-09-01:编辑操作前从文件算遮蔽(绕开 host 稀疏 session.events,用户方案)
      // 2026-09-09:recall mode 改 tail(遮蔽目标轮及之后全部)——与 index.js harness 入口
      // 同语义(独立审查 ❌-1:HTTP 入口此前漏改仍 round,两入口分叉违反"编辑走哪个入口都生效")
      if (op === 'recall' || op === 'editAndResend' || op === 'regenerate' || op === 'fold') {
        try {
          const target = op === 'fold' ? Number(args?.start) : (typeof args?.seq === 'number' ? args.seq : args?.messageId)
          if (target !== undefined && target !== null) {
            const mode = op === 'recall' || (op === 'editAndResend' && args?.fromScratch) ? 'tail'
              : op === 'fold' ? 'range'
              : 'round'
            const span = await dshAdapter.spanFromFile(sessionId, target, mode, op === 'fold' ? { endSeq: Number(args?.end) } : undefined)
            if (span) args = { ...args, span }
          }
        } catch { /* span 计算失败 fallback 内部 */ }
      }
      try {
        const result = await opFn(args)
        // Editor ops return the transport-neutral envelope; a failed op is an
        // error response, not a 200 carrying ok:false.
        const safe = safeEnvelope(result)
        const status = safe && safe.ok === false ? statusForCode(safe.error?.code) : 200
        sendJson(res, status, safe)
      } catch (error) {
        sendError(res, error)
      }
    })
  }

  /**
   * Loopback hosts are the normal case; a tunnel or LAN host needs an opt-in.
   * The Host header is forgeable, so the socket peer must be loopback too —
   * otherwise a local process (or a DNS-rebinding page whose Host matches its
   * Origin) reaches the unauthenticated read routes.
   */
  function hostAllowed(req) {
    return isLoopbackRequest(req, { remoteAllowed: REMOTE_ALLOWED })
  }

  /** Mutating ops must come from this plugin's own UI (custom header). */
  function clientHeaderOk(req) {
    return String(req.headers['x-retrace-client'] ?? '') === CLIENT_HEADER_VALUE
  }

  /** Same-origin gate: browsers may only call from this host's own origin. */
  function originAllowed(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.length === 0) return true // non-browser client
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return parsed.host === (req.headers.host ?? '')
  }

  /** Reflect the caller's origin for allowed same-origin preflights only. */
  function corsHeaders(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.length === 0) return {}
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-retrace-config',
      Vary: 'Origin',
    }
  }

  return (req, res) => {
    if (!hostAllowed(req)) {
      return sendJson(res, 403, {
        ok: false,
        error: {
          code: 'host-not-allowed',
          message: 'this host is not allowed to call the plugin API (set DSH_RETRACE_ALLOW_REMOTE=1 to opt in)',
        },
      })
    }
    if (!originAllowed(req)) {
      return sendJson(res, 403, {
        ok: false,
        error: { code: 'origin-not-allowed', message: 'cross-origin requests are not allowed' },
      })
    }
    const url = new URL(req.url ?? '/', 'http://retrace.local')
    const segments = url.pathname.split('/').filter(Boolean)
    const op = segments.at(-1) ?? ''
    const searchParams = url.searchParams
    const sessionId = searchParams.get('sessionId') ?? ''
    const config = configFromRequest(req)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req))
      res.end()
      return
    }
    if (req.method === 'POST') {
      // Same-origin fetches by this plugin's UI carry the marker header; a
      // cross-site page cannot add a custom header without a preflight.
      if (!clientHeaderOk(req)) {
        return sendJson(res, 403, {
          ok: false,
          error: { code: 'client-header-required', message: 'missing x-retrace-client header' },
        })
      }
      // JSON-only: a browser form/`text/plain` POST cannot forge an op.
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (contentType.length > 0 && !contentType.startsWith('application/json')) {
        return sendJson(res, 415, {
          ok: false,
          error: { code: 'unsupported-media-type', message: 'Content-Type must be application/json' },
        })
      }
    }
    if (req.method === 'GET') {
      switch (op) {
        case 'capabilities':
          return handleCapabilities(req, res)
        case 'versions':
          return handleVersions(req, res, sessionId, config)
        case 'forkmap':
          return handleForkmap(req, res, sessionId, config)
        case 'lineage':
          return handleLineage(req, res, sessionId)
        case 'event':
          return void handleEvent(req, res, searchParams)
        case 'surface':
          return void handleSurface(req, res, sessionId)
        case 'status':
          return void handleGitStatus(req, res, sessionId)
        case 'doctor':
          return handleDoctor(req, res, sessionId, config)
        case 'storage':
          return void handleStorage(req, res)
        case 'snapshot':
          return void handleSnapshot(req, res, searchParams)
        default:
          return sendJson(res, 404, {
            ok: false,
            error: { code: 'unknown-op', message: `unknown operation "${op}"` },
          })
      }
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: 'POST or GET only' },
      })
    }
    // P1 rollback/git POST ops (last segment discriminates).
    if (segments.includes('rollback') && op === 'preview') {
      if (!rollback) return sendJson(res, 503, { ok: false, error: { code: 'rollback-unavailable', message: 'rollback surface unavailable' } })
      return handleJsonPost(req, res, (args) => rollback.preview(args))
    }
    // Undo must be matched before the generic rollback branch (both carry
    // 'rollback' in their segments).
    if (segments.includes('rollback') && op === 'undo') {
      if (!rollback || typeof rollback.undo !== 'function') {
        return sendJson(res, 503, { ok: false, error: { code: 'rollback-unavailable', message: 'rollback surface unavailable' } })
      }
      return handleJsonPost(req, res, (args) => rollback.undo(args))
    }
    if (segments.includes('rollback')) {
      if (!rollback) return sendJson(res, 503, { ok: false, error: { code: 'rollback-unavailable', message: 'rollback surface unavailable' } })
      return handleJsonPost(req, res, (args) => rollback.execute(args))
    }
    if (segments.includes('git') && op === 'init') {
      // Creating a repository writes to the user's workspace, so the request
      // must carry the confirmation the UI collected (window.confirm).
      return handleJsonPost(req, res, (args) => {
        if (args?.confirm !== true) {
          const error = new Error('git init requires explicit confirmation')
          error.code = 'confirm-required'
          throw error
        }
        return seam.gitInit(String(args?.sessionId ?? ''), { confirm: true })
      })
    }
    // 三段式批3:unfold(视图层展开数据,纯读)与 fold(api op,走 handlePost)
    if (op === 'unfold') {
      return handleJsonPost(req, res, async (args) => {
        const markerSeq = Number(args?.markerSeq)
        if (!Number.isInteger(markerSeq) || markerSeq < 0) {
          const error = new Error('unfold 需要 fold marker 的 seq')
          error.code = 'bad-request'
          throw error
        }
        const content = await dshAdapter.unfoldContentFromFile(String(args?.sessionId ?? ''), markerSeq)
        if (!content) {
          const error = new Error('指定 seq 不是 retrace-fold- 折叠 marker 或无遮蔽内容')
          error.code = 'marker-not-found'
          throw error
        }
        return content
      })
    }
    // 会话短码 / 标题 / 水位:与 harness 桥共用实现,发布模式下同样可用。
    if (typeof badge[op] === 'function') {
      return handleJsonPostEnvelope(req, res, (args) => badge[op](args))
    }
    return handlePost(req, res, op)
  }
}
