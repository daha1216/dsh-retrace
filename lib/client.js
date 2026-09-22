/**
 * dsh-retrace — Client plugin entry (published form).
 *
 * Adds to the Web conversation view:
 *  1. an action strip on assistant replies (撤回 / 重新生成) via the
 *     `conversation.chat.assistant-actions` list seat,
 *  2. an action row under every user message (编辑 / 撤回) with an inline
 *     editor; after a recall the recalled text is echoed into the composer,
 *  3. a `recall-marker` node that HIDES every shadowed message row from the
 *     flow (CSS `data-chat-anchor-key` rules) and renders a notice row with an
 *     optional "original input" comparison block,
 *  4. two preference toggles under Settings → General (original-input
 *     comparison row, fresh-start editing) backed by localStorage.
 *
 * Operations reach the Host through the same-origin route
 * `/api/plugins/retrace/*` registered by the Host half.
 */
import { createElement, Fragment, useEffect, useRef, useState } from 'react'
import { sessionBadge } from './badge.js'

export const name = 'dsh-retrace'
export const inject = ['slots', 'locale', 'uiConversation']

const NS = 'retrace'
const ROUTE_BASE = '/api/plugins/retrace'
const MARKER_PREFIX = 'retrace'
/**
 * Every marker-id prefix this build can recognise. `MARKER_PREFIX` is the
 * prefix NEW markers are written with; the rest are LEGACY prefixes produced
 * by earlier plugin names (dsh-message-editor). RENAME RULE: when the plugin
 * changes its identity again, keep the old prefix in this list (and in
 * LEGACY_MARKER_PREFIXES) so markers written under the previous name keep
 * rendering — recognition must never be broken by a rename.
 */
const MARKER_PREFIXES = [MARKER_PREFIX, 'message-editor']
/**
 * Legacy prefixes whose markers are treated as annotations only: the notice
 * and the "original input" reference render, but their shadowed ranges are
 * NEVER hidden. Rationale: a marker written by an older plugin name may not
 * match this build's edit semantics; hiding content based on it would
 * silently re-hide conversations the user already sees. Renames must ADD the
 * retired prefix here (soft-compat: renamed-era markers become annotations,
 * so a rename can never hide previously visible content).
 */
const LEGACY_MARKER_PREFIXES = ['message-editor']
/** Recognise any marker id this build can interpret, current or legacy. */
function isMarkerId(id) {
  return typeof id === 'string' && MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`))
}
/** Whether a marker id was written under a legacy (renamed-away) prefix. */
function isLegacyMarkerId(id) {
  return typeof id === 'string' && LEGACY_MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`))
}
const CONFIG_KEY = 'dsh-retrace:config'
/** Config keys of renamed-away plugin names, read as a fallback on first load. */
const LEGACY_CONFIG_KEYS = ['dsh-message-editor:config']

/** Simplified Chinese dictionary (key-set source of truth). */
const zh = {
  'action.edit': '编辑',
  'action.editAria': '编辑这条消息',
  'action.editPlaceholder': '输入修改后的内容...',
  'action.recall': '撤回',
  'action.recallAssistant': '撤回这条回复',
  'action.recallUser': '撤回这条消息',
  'action.recallConfirm': '确认撤回？',
  'action.recallConfirmHint': '再点一次执行撤回',
  'action.regenerate': '重新生成',
  'action.send': '发送',
  'action.cancel': '取消',
  'marker.recall': '已撤回这条消息及其后的对话',
  'marker.recallMany': '已撤回 {count} 条消息',
  'marker.recallOne': '已撤回 1 条消息',
  'marker.edit': '已编辑此消息并重新发送，对话从新消息继续',
  'marker.regenerate': '已重新生成回复',
  'marker.fold': '已折叠此完成块（{count} 个节点，日志完整，可展开）',
  'marker.unfold': '展开此折叠块',
  'marker.originalLabel': '原输入',
  'marker.referenceHint': '点击展开查看原提问（仅作对照，不会进入模型上下文）',
  'marker.degradedHint': '此操作涉及大范围对话，为保护历史未隐藏内容（日志完好）。',
  'marker.unionHint': '已累积隐藏约 {count}% 的历史消息；可在 设置→通用 关闭「按标记隐藏」查看完整历史。',
  'marker.t1Broken': '编辑已生效；此标记会使本会话的 /compact 失效。离线清理：关闭会话后运行 dsh-log-contract fix --drop-turnnull（编辑外观会回退为原始内容）。',
  'options.title': '消息编辑插件',
  'options.showOriginalInput': '编辑后显示原提问对照',
  'options.editFromScratch': '编辑后从新对话开始（隐藏此前的消息，默认关）',
  'options.hideShadowed': '按标记隐藏被编辑/撤回的消息',
  'options.hideShadowedDesc': '开（默认）：撤回/编辑/重新生成按标记隐藏被替换的那一轮消息。关：所有消息保持可见，标记仅显示提示与对照（查看完整历史用）。一次操作要隐藏超过 40% 的对话时自动降级为不隐藏。',
  'options.versioning': '版本与产物快照',
  'options.versioningDesc': '开：每次撤回/编辑记录一个版本（消息与触碰文件），提供时间线与产物回退；关：仅回退上下文，不记录版本、不追踪产物（最省资源）。',
  'options.git': '启用 git 集成',
  'options.gitDesc': '开：工作区是 git 仓库时用 git 记录与回退（不自动提交、不动你的分支），非仓库可在时间线里一键启用；关：一律用内置快照（存于 ~/.dsh），不触碰工作区 git 状态，功能等价。',
  'options.retention': '版本保留上限',
  'options.retentionDesc': '文件快照只保留最近 N 个版本，超出自动清理最旧的；时间线记录与审计痕迹始终保留。',
  'timeline.open': '时间线',
  'timeline.openAria': '打开会话时间线',
  'timeline.title': '版本时间线',
  'view.retrace': '版本',
  'timeline.refresh': '刷新',
  'timeline.close': '关闭',
  'timeline.empty': '还没有版本。撤回 / 编辑 / 重新生成会在此记录版本。',
  'timeline.loading': '加载中…',
  'timeline.error': '时间线加载失败',
  'timeline.kind.recall': '撤回',
  'timeline.kind.edit': '编辑重发',
  'timeline.kind.regenerate': '重新生成',
  'timeline.kind.restore': '恢复',
  'timeline.kind.compaction': '压缩',
  'timeline.kind.replace': '替换',
  'timeline.messages': '{count} 条消息',
  'timeline.files': '{created} 增 / {modified} 改 / {deleted} 删',
  'timeline.filesNone': '无文件变更',
  'timeline.preview': '回退预览',
  'timeline.previewDesc': '将回退到版本 {version}（{kind}）。',
  'timeline.contextOnly': '仅对话',
  'timeline.contextOnlyDesc': '移除该版本之后的消息（保留日志审计痕迹）',
  'timeline.artifactsOnly': '仅产物',
  'timeline.artifactsOnlyDesc': '把该版本触碰的文件恢复到当时的內容',
  'timeline.both': '两者',
  'timeline.bothDesc': '先回退对话，再回退产物',
  'timeline.messagesRemoved': '将移除 {count} 条消息',
  'timeline.noChanges': '当前已在该版本状态，无变化',
  'timeline.artifactsList': '产物动作（{count}）',
  'timeline.artifact.restore': '恢复',
  'timeline.artifact.delete': '删除',
  'timeline.artifact.skip': '跳过',
  'timeline.confirm': '确认回退',
  'timeline.cancel': '取消',
  'timeline.busy': '回退中…',
  'timeline.detail': '详情',
  'timeline.trajectory': '轨迹台账',
  'timeline.jump': '跳转',
  'timeline.jumpFailed': '该版本在较远的过去（超出自动加载预算），无法直接定位。请向上滚动加载更早消息后重试；或用「详情」查看该版本当时的事件原文。',
  'timeline.doctorWarn': '该会话含 {count} 个编辑/撤回标记，压缩（/compact）前请先清理（token meter 兼容）。',
  'timeline.gitRepo': 'git 仓库',
  'timeline.gitHead': 'HEAD {hash}',
  'timeline.gitDirty': '工作区有未提交改动',
  'timeline.gitInit': '启用 git 版本管理',
  'timeline.gitInitDesc': '在工作区执行 git init（仅添加 .gitignore 与一个基线提交），版本回退将优先使用 git。',
  'timeline.gitInitConfirm': '确定要初始化 git 吗？',
  'error.generic': '操作失败，请重试',
  'error.busy': '请先停止当前回复再操作',
  'view.fork': '分叉',
  'fork.title': '分叉图',
  'fork.empty': '还没有分叉。撤回 / 编辑 / 重新生成 / 恢复会在此产生分叉。',
  'fork.refresh': '刷新',
  'fork.spine': '当前路径',
  'fork.shadowed': '被遮蔽 {count} 个节点',
  'fork.node.user': '用户消息',
  'fork.node.assistant': '助手回复',
  'fork.node.tool': '工具结果',
  'fork.histTitle': '历史分叉点',
  'fork.lineage': '会话谱系',
  'fork.lineageThis': '当前会话',
  'fork.lineageParent': '父会话',
  'fork.lineageRoot': '根会话',
  'fork.lineageEmpty': '本会话没有父会话（独立根会话）。',
  'fork.badge': '会话短码',
  'fork.badgeHint': '短码由会话唯一 id 确定性导出，永不变（标题会变）。',
  'fork.rename': '改名称',
  'fork.renamePrompt': '输入会话名称（自动拼接短码，设置后固定不再自动改名）：',
}
/** English dictionary, checked complete against the zh key set. */
const en = {
  'action.edit': 'Edit',
  'action.editAria': 'Edit this message',
  'action.editPlaceholder': 'Type edited message...',
  'action.recall': 'Recall',
  'action.recallAssistant': 'Recall this reply',
  'action.recallUser': 'Recall this message',
  'action.recallConfirm': 'Confirm recall?',
  'action.recallConfirmHint': 'Click again to recall',
  'action.regenerate': 'Regenerate',
  'action.send': 'Send',
  'action.cancel': 'Cancel',
  'marker.recall': 'This message and the following conversation were recalled',
  'marker.recallMany': '{count} messages were recalled',
  'marker.recallOne': '1 message recalled',
  'marker.edit': 'Edited and re-sent; the conversation continues from the new message',
  'marker.regenerate': 'Reply regenerated',
  'marker.fold': 'Completed block folded ({count} nodes; log intact, expandable)',
  'marker.unfold': 'Expand this folded block',
  'marker.originalLabel': 'Original input',
  'marker.referenceHint': 'Click to expand the original input (reference only, never sent to the model)',
  'marker.degradedHint': 'This operation spans a large part of the conversation; content stays visible to protect your history (the log is intact).',
  'marker.unionHint': 'About {count}% of the history is hidden in total; disable "Hide shadowed messages" in Settings → General to review the full history.',
  'marker.t1Broken': 'Edit applied; this marker will break /compact for this session. Offline clean-up: close the session and run dsh-log-contract fix --drop-turnnull (the edit reverts to the original content).',
  'options.title': 'Message editor plugin',
  'options.showOriginalInput': 'Show the original input after editing',
  'options.editFromScratch': 'Start a fresh conversation after editing (hide earlier messages, default off)',
  'options.hideShadowed': 'Hide shadowed messages per marker',
  'options.hideShadowedDesc': 'On (default): recall/edit/regenerate hide the replaced round per their markers. Off: every message stays visible; markers only show the notice and reference (use to review full history). A single op that would hide more than 40% of the conversation degrades to notice-only automatically.',
  'options.versioning': 'Version & artifact snapshots',
  'options.versioningDesc': 'On: every recall/edit records a version (messages and touched files) powering the timeline and artifact rollback. Off: only rewinds context — no version records, no artifact tracking (lightest).',
  'options.git': 'Git integration',
  'options.gitDesc': 'On: uses git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the timeline. Off: built-in snapshots under ~/.dsh only — the plugin never touches the workspace git state; equivalent features.',
  'options.retention': 'Version retention limit',
  'options.retentionDesc': 'File snapshots are kept for the most recent N versions; older ones are pruned automatically (timeline records and the audit trail are always kept).',
  'timeline.open': 'Timeline',
  'timeline.openAria': 'Open the session timeline',
  'timeline.title': 'Version timeline',
  'view.retrace': 'Versions',
  'timeline.refresh': 'Refresh',
  'timeline.close': 'Close',
  'timeline.empty': 'No versions yet. Recall / edit / regenerate record a version here.',
  'timeline.loading': 'Loading…',
  'timeline.error': 'Failed to load the timeline',
  'timeline.kind.recall': 'Recall',
  'timeline.kind.edit': 'Edit & resend',
  'timeline.kind.regenerate': 'Regenerate',
  'timeline.kind.restore': 'Restore',
  'timeline.kind.compaction': 'Compaction',
  'timeline.kind.replace': 'Replace',
  'timeline.messages': '{count} messages',
  'timeline.files': '{created} created / {modified} modified / {deleted} deleted',
  'timeline.filesNone': 'No file changes',
  'timeline.preview': 'Rollback preview',
  'timeline.previewDesc': 'Will roll back to version {version} ({kind}).',
  'timeline.contextOnly': 'Context only',
  'timeline.contextOnlyDesc': 'Remove messages after this version (the log audit trail stays)',
  'timeline.artifactsOnly': 'Artifacts only',
  'timeline.artifactsOnlyDesc': 'Restore the files this version touched to their state at that version',
  'timeline.both': 'Both',
  'timeline.bothDesc': 'Roll back the context first, then the artifacts',
  'timeline.messagesRemoved': '{count} messages will be removed',
  'timeline.noChanges': 'Already at this version; nothing to change',
  'timeline.artifactsList': 'Artifact actions ({count})',
  'timeline.artifact.restore': 'restore',
  'timeline.artifact.delete': 'delete',
  'timeline.artifact.skip': 'skip',
  'timeline.confirm': 'Confirm rollback',
  'timeline.cancel': 'Cancel',
  'timeline.busy': 'Rolling back…',
  'timeline.detail': 'Details',
  'timeline.trajectory': 'Trajectory',
  'timeline.jump': 'Jump',
  'timeline.jumpFailed': 'This version lies too far back (beyond the auto-load budget) to locate directly. Scroll up to load earlier messages, or use Details to read the original event text of this version.',
  'timeline.doctorWarn': 'This session has {count} edit/recall markers; clean them before /compact (token-meter compatibility).',
  'timeline.gitRepo': 'git repository',
  'timeline.gitHead': 'HEAD {hash}',
  'timeline.gitDirty': 'working tree has uncommitted changes',
  'timeline.gitInit': 'Enable git versioning',
  'timeline.gitInitDesc': 'Runs git init in the workspace (adds a minimal .gitignore and a baseline commit); rollback will prefer git.',
  'timeline.gitInitConfirm': 'Initialize git in this workspace?',
  'error.generic': 'Operation failed; please try again',
  'error.busy': 'Stop the current reply before recalling or editing',
  'view.fork': 'Fork',
  'fork.title': 'Fork map',
  'fork.empty': 'No forks yet. Recall / edit / regenerate / restore fork the path here.',
  'fork.refresh': 'Refresh',
  'fork.spine': 'Current path',
  'fork.shadowed': '{count} shadowed nodes',
  'fork.node.user': 'User message',
  'fork.node.assistant': 'Assistant reply',
  'fork.node.tool': 'Tool result',
  'fork.histTitle': 'Historical fork points',
  'fork.lineage': 'Session lineage',
  'fork.lineageThis': 'This session',
  'fork.lineageParent': 'Parent session',
  'fork.lineageRoot': 'Root session',
  'fork.lineageEmpty': 'This session has no parent (standalone root).',
  'fork.badge': 'Session badge',
  'fork.badgeHint': 'A stable shortcode derived from the session id (titles change, badges never do).',
  'fork.rename': 'Rename',
  'fork.renamePrompt': 'Enter a session name (badge is prefixed automatically; the title is then pinned, no auto-rename):',
}

// ---------------------------------------------------------------------------
// Durable-surface helpers (mirror of @deepseek-ai/dsh-session/surface).
// ---------------------------------------------------------------------------
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

function isReplacementSurfaceEvent(event) {
  return SURFACE_TYPES.has(event.type) && event.surfaceOp !== undefined && event.surfaceOp !== 'append'
}

// ---------------------------------------------------------------------------
// Wire call
// ---------------------------------------------------------------------------
// The published client calls the same-origin HTTP route registered by the Host
// half. The generated dynamic client (scripts/generate-dynamic.mjs) swaps in
// `host.call` before apply runs, so ONE source serves both runtimes and the
// two can never drift apart.
let wire = null

export function __setMessageEditorWire(fn) {
  wire = fn
}

function callOp(op, payload) {
  if (typeof wire === 'function') return wire(op, payload)
  return fetch(`${ROUTE_BASE}/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...retraceConfigHeaders() },
    body: JSON.stringify(payload),
  }).then((res) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
    return res.json()
  })
}

/** The localStorage plugin config, carried to the Host on every request
 * (PLAN §4.6: the host honors it per request and does not persist it). */
function retraceConfigHeaders() {
  const { versioning, git, retentionLimit } = getConfig()
  return { 'x-retrace-config': JSON.stringify({ versioning, git, retentionLimit }) }
}

// ---------------------------------------------------------------------------
// Plugin preferences (localStorage-backed, reactive)
// ---------------------------------------------------------------------------
/**
 * v3 defaults (2026-08-26 incident fix, finalized): v1's default
 * `editFromScratch: true` made a single edit hide the WHOLE conversation before
 * the edit point, so clicking "load earlier" appeared to load nothing. v3 keeps
 * normal edit UX while making the wipe impossible:
 *  - `editFromScratch: false` — editing one message no longer rewinds the whole
 *    conversation; only the edited round is replaced on the model surface.
 *  - `hideShadowed: true` — the replaced round of an edit/recall/regenerate is
 *    hidden from the view (the natural "old message disappears" UX), while the
 *    safety guard in `useHiddenKeys` (40% of the conversation) refuses any
 *    single marker from blanking out most of the history.
 */
const CONFIG_VERSION = 3
const CONFIG_DEFAULTS = { version: CONFIG_VERSION, showOriginalInput: true, editFromScratch: false, hideShadowed: true, versioning: true, git: true, retentionLimit: 50, prewrite: true }
const configListeners = new Set()
let configCache = readConfig()

/** resendMessageId -> the exact text that edit replaced (most recent, host-authoritative). */
const editReferences = new Map()

/**
 * Pre-v3 migration: the destructive default `editFromScratch: true` is always
 * reset to false; `hideShadowed` is reset to true (the natural edit UX) for
 * configs written under the interim v2 defaults (where it was force-false).
 * Every other customization is preserved.
 */
function migrateConfig(parsed) {
  const version = typeof parsed.version === 'number' ? parsed.version : 1
  if (version >= CONFIG_VERSION) return { ...CONFIG_DEFAULTS, ...parsed }
  return {
    ...CONFIG_DEFAULTS,
    ...parsed,
    version: CONFIG_VERSION,
    editFromScratch: CONFIG_DEFAULTS.editFromScratch,
    hideShadowed: CONFIG_DEFAULTS.hideShadowed,
  }
}

function readConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw !== null) {
      const parsed = raw ? JSON.parse(raw) : {}
      const migrated = migrateConfig(parsed)
      const storedVersion = typeof parsed.version === 'number' ? parsed.version : 1
      if (storedVersion < CONFIG_VERSION) {
        // Persist the migration so the next load starts from the v3 shape.
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(migrated)) } catch { /* storage unavailable */ }
      }
      return migrated
    }
    // Rename-safe fallback: pick up settings saved under a previous plugin name.
    for (const legacyKey of LEGACY_CONFIG_KEYS) {
      const legacyRaw = localStorage.getItem(legacyKey)
      if (legacyRaw !== null) {
        const migrated = migrateConfig(legacyRaw ? JSON.parse(legacyRaw) : {})
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(migrated)) } catch { /* storage unavailable */ }
        return migrated
      }
    }
    return { ...CONFIG_DEFAULTS }
  } catch {
    return { ...CONFIG_DEFAULTS }
  }
}
function getConfig() {
  return configCache
}
function setConfig(patch) {
  configCache = { ...configCache, ...patch }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(configCache))
  } catch { /* storage unavailable */ }
  for (const listener of configListeners) listener(configCache)
}
function subscribeConfig(listener) {
  configListeners.add(listener)
  return () => {
    configListeners.delete(listener)
  }
}
function useConfig() {
  const [, force] = useState(0)
  useEffect(() => subscribeConfig(() => force((x) => x + 1)), [])
  return getConfig()
}

// ---------------------------------------------------------------------------
// Conversation node definitions
// ---------------------------------------------------------------------------
function chatNodeLike(context, kind, anchorSeq, data) {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat',
    anchorSeq,
    // 0.1.7 起 location 决定分组与折叠（process-groups 的 INDEPENDENT 白名单
    // 不认识伪 kind，带 turn location 的 seat 会被卷进 ChatGroupSeat 折叠组，
    // 祖先 hidden="until-found" 的 content-visibility:hidden CSS 解不掉，chips
    // 整棵隐身且点击穿透——E2E 基线 12/24 全挂在这个死角上）。伪 kind 不参与
    // 回合语义：钉 unresolved 让 rootEntries 直接挂根节点（不进组、不进
    // processMember、永不 hidden），排序仍走 anchorSeq rank 0，与原 turn
    // location 的排序键完全一致（presentationPosition 对非 turn/step 分支
    // 返回 {anchor,rank:0,originalAnchor}）。
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data,
  }
}

/** One small action row per user-sent message (edit / recall). */
const userActionsDefinition = {
  kind: 'retrace-actions',
  target: 'chat',
  match: (event) => (
    event.type === 'user/message'
    && event.surfaceOp === 'append'
    && event.data.source?.kind === 'user'
      ? { id: String(event.data.id), role: 'start' }
      : null
  ),
  start: (_context, match) => {
    const event = match.event
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      content: event.data.content,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNodeLike(context, 'user-actions', context.state.seq, context.state)
  },
}

/**
 * The "original input" reference block for an edit re-send. Anchored just
 * before the message (`seq - 0.5`) so it renders directly ABOVE the new
 * input; the action buttons stay below the bubble in `user-actions`.
 */
const userReferenceDefinition = {
  kind: 'retrace-reference',
  target: 'chat',
  match: (event) => (
    event.type === 'user/message'
    && event.surfaceOp === 'append'
    && event.data.source?.kind === 'user'
      ? { id: `ref:${String(event.data.id)}`, role: 'start' }
      : null
  ),
  start: (_context, match) => {
    const event = match.event
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      content: event.data.content,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNodeLike(context, 'retrace-reference', context.state.seq - 0.5, context.state)
  },
}

function markerOpFromId(id) {
  for (const p of MARKER_PREFIXES) {
    if (id.startsWith(`${p}-recall-`)) return 'recall'
    if (id.startsWith(`${p}-edit-`)) return 'edit'
    if (id.startsWith(`${p}-regenerate-`)) return 'regenerate'
    if (id.startsWith(`${p}-fold-`)) return 'fold'
  }
  return 'edit'
}

/**
 * The recall/edit/regenerate marker node. Renders a notice row and injects CSS
 * that hides every shadowed message row (they stay in the durable log as an
 * audit trail but disappear from the flow, so view and model context agree).
 * Legacy-prefix markers (written under a renamed-away plugin name) render as
 * annotations only: their shadowed ranges are never hidden, so a rename can
 * never make previously visible content disappear.
 */
const recallMarkerDefinition = {
  kind: 'recall-marker',
  target: 'chat',
  match: (event) => {
    if (!isReplacementSurfaceEvent(event)) return null
    // 0.1.7 起 marker 写规范形状 source:{kind:'plugin:retrace'}（V4 admission 拒绝
    // kind:'plugin'）；旧 V3 文件里的 {kind:'plugin',plugin:'retrace'} 由开档迁移
    // 改写，但迁移前的内存事件与历史形状仍需兼容——两种形状都认。
    if (event.type === 'user/message' && (event.data?.source?.kind === 'plugin:retrace' || event.data?.source?.plugin === 'retrace')) return { id: `marker:${event.data.id}`, role: 'start' }
    if (event.type === 'assistant/message') {
      const id = event.data?.message?.id
      if (!isMarkerId(id)) return null
      return { id: `marker:${id}`, role: 'start' }
    }
    // Compaction checkpoints are user/message replaces with the official
    // `plugin: compact` source. They are NOT our markers, but their shadow
    // range tells us which messages were compacted away — used ONLY to hide
    // the edit/recall entries for those messages (compacted rows are handled
    // by the engine itself, so the checkpoint marker renders nothing and
    // never injects hide rules).
    if (event.type === 'user/message' && isCompactCheckpoint(event.data?.source)) {
      return { id: `marker:compact:${event.seq}`, role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    const event = match.event
    const compact = event.type === 'user/message' && isCompactCheckpoint(event.data?.source)
    const id = compact ? '' : String(event.type === 'user/message' ? event.data.id : event.data.message.id)
    const legacy = !compact && isLegacyMarkerId(id)
    return {
      seq: event.seq,
      time: event.time,
      op: compact ? 'compaction' : markerOpFromId(id),
      legacy,
      compact,
      // Legacy/compact markers never hide: their shadowed range is kept for
      // the action-row suppression check (useShadowed) but empty for legacy
      // so no row is hidden and no action row is suppressed for legacy
      // markers (rename must never make visible content disappear).
      // 2026-09-01：优先读 data.shadowedSeqs（host 冗余写入），fallback 顶层
      // sourceEventSeqs——部分客户端事件管道剥离顶层字段导致隐藏失效。
      shadowedSeqs: legacy ? [] : (Array.isArray(event.data?.shadowedSeqs) ? event.data.shadowedSeqs.slice() : (Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.slice() : [])),
      targetSeq: event.data?.editor?.targetSeq,
      text: event.data?.editor?.text ?? event.data?.source?.text,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNodeLike(context, 'recall-marker', context.state.seq, context.state)
  },
}

/** Official compaction checkpoint source: `{kind:'compact-checkpoint'}` (0.1.7+) 或旧形状 `{kind:'plugin', plugin:'compact'}`（0.1.6 及更早，V3 迁移会改写为前者）。 */
function isCompactCheckpoint(source) {
  return Boolean(source) && (source.kind === 'compact-checkpoint'
    || (source.kind === 'plugin' && source.plugin === 'compact'))
}

// ---------------------------------------------------------------------------
// Shared selector helpers
// ---------------------------------------------------------------------------
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** The durable seq of the finalized assistant message with `messageId`. */
function useMessageSeq(useChat, messageId) {
  return useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      if (node.kind === 'assistant-step' && node.data?.finalNode?.messageId === messageId) {
        return node.data.finalNode.seq
      }
    }
    return undefined
  })
}

/**
 * Safety guard: a SINGLE marker that would hide more than this share of the
 * conversation's rows is refused (the marker renders as a notice only, and an
 * explicit hint explains why). Ordinary recalls/edits shadow a few rows and
 * always hide — the guard only ever trips on whole-surface operations such as
 * "edit, start a fresh conversation". History must never silently vanish.
 *
 * Note (0.4.3 regression, fixed): the previous UNION-wide guard degraded EVERY
 * marker (including fresh recalls) once the session's markers collectively
 * covered >40% of the rows — recall/edit silently stopped hiding. The guard is
 * per-marker again; a stacked-edit session still hides each replaced round,
 * and a visible hint reports how much history is hidden in total.
 */
const SHADOW_SAFETY_RATIO = 0.4

/**
 * 短会话豁免阈值（2026-09-01，独立审查问题 B 的 client 侧另一半；
 * 09-01 用户实测调大至 20）：行数 ≤ 本值的会话永不触发 40% 降级——否则
 * 小会话撤回/编辑 2-4 条消息就 >40%，被误判为「大范围操作」降级为不隐藏
 * （用户实测：「已撤回 4 条消息 + 此操作涉及大范围对话…」= 小会话误伤）。
 * 与 host 侧 ROLLBACK_MIN_SURFACE=20（surface 节点）同源：短会话豁免只在
 * 大会话按比例判定。20 行 ≈ 10 轮 ≈ 20 条消息，正常撤回/编辑远小于此。
 */
const SHADOW_MIN_ROWS_FOR_RATIO = 20

/** 撤回两步确认的布防窗口（毫秒）：超时未复点自动解除。 */
const RECALL_CONFIRM_MS = 3000

/** 40% 降级判定（短会话豁免版）：行数足够大才按比例判定。 */
function shadowDegraded(keys, rowCount) {
  return keys !== null && rowCount > SHADOW_MIN_ROWS_FOR_RATIO && keys.length / rowCount > SHADOW_SAFETY_RATIO
}

/**
 * Every chat-node key that should disappear when `shadowedSeqs` are recalled:
 * the shadowed message rows themselves, plus the per-turn action row (copy /
 * feedback / branch) when its finalized assistant reply is among them.
 */
function hiddenKeysFor(shadowedSeqs, nodes) {
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return null
  const hidden = new Set(shadowedSeqs)
  const keys = []
  for (const node of nodes.values()) {
    if (node.kind === 'recall-marker') continue
    if (node.kind === 'turn-tail') {
      // `closing` is the finalized assistant-step *data*; the message seq
      // lives on its `finalNode` (matching how the app reads `closing.finalNode.seq`).
      const closingSeq = node.data?.closing?.finalNode?.seq
      if (typeof closingSeq === 'number' && hidden.has(closingSeq)) keys.push(node.key)
      continue
    }
    if (node.kind === 'tool-call') {
      // Tool rows anchor at the tool/call event seq, which is a log-only
      // event and never a surface node, so it cannot appear in shadowedSeqs.
      // Match the settled result's surface seq (root.seq) instead.
      const resultSeq = node.data?.root?.seq
      if (typeof resultSeq === 'number' && hidden.has(resultSeq)) keys.push(node.key)
      continue
    }
    if (typeof node.anchorSeq === 'number') {
      // Pseudo rows anchor at HALF seqs to order before their message
      // (retrace-reference uses `seq - 0.5`); the shadow set holds whole
      // seqs, so map the anchor back to its integer seq before matching —
      // otherwise the original-input reference survives the message it
      // belongs to (visible residue after an edit).
      const anchored = node.anchorSeq % 1 === 0 ? node.anchorSeq : Math.ceil(node.anchorSeq)
      if (hidden.has(anchored)) keys.push(node.key)
    }
  }
  return keys.length === 0 ? null : keys
}

/**
 * Hide plan (0.4.3 → per-marker): one snapshot pass computes every marker's
 * hidden keys and applies the safety guard to each marker INDEPENDENTLY. A
 * single normal recall/edit hides its replaced round (a few rows ≪ the
 * threshold); only a marker that would hide most of the history by itself
 * (e.g. "start a fresh conversation") degrades to notice-only. The plan also
 * reports the collective ratio so the UI can hint when stacked edits hide a
 * large share of the conversation.
 */
const EMPTY_HIDE_PLAN = Object.freeze({
  hiddenFor: () => null,
  planFor: () => null,
  unionRatio: 0,
  rowCount: 0,
  firstMarkerKey: null,
})

/**
 * Plugin pseudo-node kinds never represent a real conversation row; they must
 * not count toward the safety-ratio denominator (0.4.x review: counting them
 * diluted the 40% guard to ~55-68% of real rows).
 */
const PLUGIN_PSEUDO_KINDS = new Set(['user-actions', 'retrace-reference', 'recall-marker'])

/** Count only REAL conversation rows (excludes the plugin's pseudo nodes). */
function realRowCount(nodes) {
  let count = 0
  for (const node of nodes.values()) {
    if (typeof node.anchorSeq === 'number' && !PLUGIN_PSEUDO_KINDS.has(node.kind)) count += 1
  }
  return count
}

// Module-level memo: the conversation snapshot reference is stable between
// events, so the hide plan (O(nodes) per pass) is computed once per snapshot
// and shared by every marker row — same object reference → no re-render storm
// (0.4.x review: each marker row recomputed the whole table every snapshot).
let hidePlanCacheSnapshot = null
let hidePlanCacheValue = null
function useMarkerHidePlan(useChat) {
  return useChat((snapshot) => {
    if (hidePlanCacheSnapshot === snapshot) return hidePlanCacheValue
    const nodes = snapshot.nodes
    const rowCount = realRowCount(nodes)
    const markers = []
    for (const node of nodes.values()) {
      if (node.kind === 'recall-marker' && !node.data?.compact) markers.push(node)
    }
    if (markers.length === 0) {
      hidePlanCacheSnapshot = snapshot
      hidePlanCacheValue = EMPTY_HIDE_PLAN
      return hidePlanCacheValue
    }
    const plans = new Map()
    const union = new Set()
    for (const marker of markers) {
      const keys = hiddenKeysFor(marker.data?.shadowedSeqs, nodes)
      const degraded = shadowDegraded(keys, rowCount)
      plans.set(marker.key, { keys: degraded ? null : keys, degraded })
      if (keys !== null) for (const key of keys) union.add(key)
    }
    hidePlanCacheSnapshot = snapshot
    hidePlanCacheValue = {
      planFor: (key) => plans.get(key) ?? null,
      hiddenFor: (key) => plans.get(key)?.keys ?? null,
      unionRatio: rowCount > 0 ? union.size / rowCount : 0,
      rowCount,
      firstMarkerKey: markers[0].key,
    }
    return hidePlanCacheValue
  })
}

/**
 * True when the chat row `key` is actually hidden right now — i.e. some
 * marker that is NOT degraded includes it in its hide rules. This mirrors the
 * CSS reality: a degraded marker hides nothing, so rows it shadowed stay
 * visible AND stay operable (their action rows must not vanish).
 */
function rowHiddenByKey(snapshot, rowKey) {
  if (rowKey === undefined || rowKey === null) return false
  const nodes = snapshot.nodes
  const rowCount = realRowCount(nodes)
  for (const node of nodes.values()) {
    if (node.kind !== 'recall-marker' || node.data?.compact) continue // compact markers never hide rows
    const keys = hiddenKeysFor(node.data?.shadowedSeqs, nodes)
    if (keys === null) continue
    if (shadowDegraded(keys, rowCount)) continue // degraded: hides nothing
    if (keys.includes(rowKey)) return true
  }
  return false
}

/** Same as rowHiddenByKey, but resolves the row key from a surface seq. */
function useSeqHidden(useChat, seq) {
  return useChat((snapshot) => {
    if (seq === undefined || seq === null) return false
    for (const node of snapshot.nodes.values()) {
      if (node.kind !== 'recall-marker' && typeof node.anchorSeq === 'number' && node.anchorSeq === seq) {
        return rowHiddenByKey(snapshot, node.key)
      }
    }
    return false
  })
}

/**
 * True when `seq` was shadowed by ANY recall/edit/regenerate/compaction
 * marker — the OPERATION-FEASIBILITY dimension, distinct from visual hiding:
 * a shadowed message can never be edited/recalled again (the host rejects it
 * with target-shadowed), so its action entries must be hidden even when the
 * row itself stays visible (guard-degraded or compacted).
 */
function useShadowed(useChat, seq) {
  return useChat((snapshot) => {
    if (seq === undefined || seq === null) return false
    for (const node of snapshot.nodes.values()) {
      // Include compact markers: compacted messages are also un-editable.
      if (node.kind === 'recall-marker' && Array.isArray(node.data?.shadowedSeqs)
        && node.data.shadowedSeqs.includes(seq)) {
        return true
      }
    }
    return false
  })
}

/** The marker notice disappears once the user keeps typing after the rewind. */
function useMarkerDismissed(useChat, markerSeq, op) {
  return useChat((snapshot) => {
    if (typeof markerSeq !== 'number') return false
    let after = 0
    for (const node of snapshot.nodes.values()) {
      if (node.kind === 'user-actions' && typeof node.data?.seq === 'number' && node.data.seq > markerSeq) {
        after += 1
      }
    }
    // The edit marker's own re-send message follows it automatically; the notice
    // stays until the user sends ANOTHER message after the edit.
    return op === 'edit' ? after >= 2 : after >= 1
  })
}

/**
 * For one user message, the original text of the edit that produced it: the
 * nearest preceding edit marker with no other user message in between (i.e.
 * this message is the automatic re-send after an edit).
 */
function useEditReference(useChat, mySeq) {
  return useChat((snapshot) => {
    if (typeof mySeq !== 'number') return null
    let latestMarkerSeq = -1
    let referenceText = null
    let prevUserSeq = -1
    for (const node of snapshot.nodes.values()) {
      if (node.kind === 'recall-marker' && node.data?.op === 'edit' && typeof node.data.seq === 'number'
        && node.data.seq < mySeq && node.data.seq > latestMarkerSeq) {
        latestMarkerSeq = node.data.seq
        referenceText = typeof node.data.text === 'string' && node.data.text.length > 0 ? node.data.text : null
      }
      if (node.kind === 'user-actions' && typeof node.data?.seq === 'number'
        && node.data.seq < mySeq && node.data.seq > prevUserSeq) {
        prevUserSeq = node.data.seq
      }
    }
    if (latestMarkerSeq === -1 || referenceText === null) return null
    if (prevUserSeq > latestMarkerSeq) return null
    return referenceText
  })
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** 撤回 / 重新生成 strip inside a finalized assistant reply's IconActions row. */
/**
 * The chat-node seat machinery re-renders an entry once with null props while
 * a recall replaces the conversation surface (observed as React #300 +
 * "Cannot destructure property 'node' of null"). Uncaught, the slot core
 * abdicates the entry PERMANENTLY (data-slot-error dead cell until reload) —
 * after one recall every user message lost its edit/recall chips. A hook-free
 * wrapper returning null for degenerate props keeps the entry alive; the inner
 * component mounts and unmounts with real props, so its hook history never
 * sees a propsless render.
 */
function withSeatPropsGuard(Comp, propKey = 'node') {
  return function GuardedSeatEntry(props) {
    if (props === null || props === undefined || props[propKey] === undefined) return null
    return createElement(Comp, props)
  }
}

function AssistantActions({ messageId, sessionId, useChat, t }) {
  const seq = useMessageSeq(useChat, messageId)
  const hidden = useSeqHidden(useChat, seq)
  const shadowed = useShadowed(useChat, seq)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)
  // Hidden (visually) or shadowed (un-editable: recalled/edited/compacted
  // away) messages must not offer recall/regenerate — the host would reject
  // with target-shadowed.
  if (hidden || shadowed || seq === undefined) return null

  const run = (op) => {
    setBusy(true)
    setFailure(null)
    callOp(op, { sessionId, messageId }).then(
      (result) => {
        setBusy(false)
        if (!result || result.ok !== true) {
          const message = result?.error?.message || 'Operation failed; please try again'
          const code = result?.error?.code
          setFailure(code === 'agent-busy' ? t('error.busy') : message)
        }
      },
      (error) => {
        setBusy(false)
        setFailure(error?.message ?? t('error.generic'))
      },
    )
  }

  return createElement('span', { className: 'dsh-rt-strip' }, [
    createElement('button', {
      key: 'recall',
      type: 'button',
      className: 'dsh-rt-icon',
      title: t('action.recallAssistant'),
      'aria-label': t('action.recallAssistant'),
      disabled: busy,
      onClick: () => run('recall'),
    }, '↩'),
    createElement('button', {
      key: 'regenerate',
      type: 'button',
      className: 'dsh-rt-icon',
      title: t('action.regenerate'),
      'aria-label': t('action.regenerate'),
      disabled: busy,
      onClick: () => run('regenerate'),
    }, '↻'),
    failure !== null && createElement('span', { key: 'error', className: 'dsh-rt-error', role: 'status' }, failure),
  ])
}

/** 原输入 reference block, rendered just above the re-sent message. */
function ReferenceRow({ node, useChat, t }) {
  const { seq, messageId } = node.data
  // The reference node anchors at seq-0.5 (above the message) and never
  // appears in any hide rule — judge by the REAL message seq so a shadowed
  // re-send's reference disappears with it (0.4.4 regression: judging by the
  // node key left stale "original input" blocks after a second edit).
  const hidden = useSeqHidden(useChat, seq)
  const markerRef = useEditReference(useChat, seq)
  const referenceText = editReferences.get(messageId) ?? markerRef ?? null
  const config = useConfig()
  if (hidden) return null
  if (referenceText === null || !config.showOriginalInput) return null
  return createElement('div', { className: 'dsh-rt-user-row' }, [
    createElement('details', { className: 'dsh-rt-reference' }, [
      createElement('summary', { title: t('marker.referenceHint') },
        `${t('marker.originalLabel')}：${referenceText.length > 60 ? `${referenceText.slice(0, 60)}…` : referenceText}`),
      createElement('div', { className: 'dsh-rt-reference-text' }, referenceText),
    ]),
  ])
}

/** 编辑 / 撤回 action row under one user message; recall echoes into the composer. */
function UserActionsRow({ node, sessionId, useChat, inputActions, t }) {
  const { seq, messageId, content } = node.data
  // Two independent dimensions: visual hiding (guard-protected, row stays
  // visible when degraded) vs operation feasibility (a shadowed message can
  // never be edited again — the host rejects with target-shadowed). Hide the
  // edit/recall entries when EITHER applies, so compacted or recalled rows
  // that remain visible don't offer operations that would just fail.
  const hidden = useSeqHidden(useChat, seq)
  const shadowed = useShadowed(useChat, seq)
  const [editing, setEditing] = useState(false)
  const [closing, setClosing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef(0)
  const closeTimer = useRef(0)
  const textareaRef = useRef(null)
  useEffect(() => () => {
    clearTimeout(confirmTimer.current)
    clearTimeout(closeTimer.current)
  }, [])
  // NOTE: the hidden/shadowed bail-out moved below, after ALL hooks (v0.4.40).

  const adjustHeight = (el) => {
    const target = el ?? textareaRef.current
    if (!target) return
    target.style.height = 'auto'
    target.style.height = `${Math.min(Math.max(target.scrollHeight, 56), 360)}px`
  }

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
      adjustHeight(el)
      const frame = requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          adjustHeight(textareaRef.current)
        }
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [editing])

  // Bail out only after EVERY hook has run: flipping hidden/shadowed on a
  // mounted entry used to change the hook count mid-sequence → React #300 →
  // the slot entry abdicated permanently (chips of all later messages died).
  if (hidden || shadowed) return null
  const handleDraftChange = (event) => {
    setDraft(event.target.value)
    adjustHeight(event.target)
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      const text = draft.trim()
      if (text.length > 0 && !busy) {
        run('editAndResend', {
          text,
          fromScratch: getConfig().editFromScratch,
        })
      }
    }
  }

  // 撤回防误触：第一次点击只布防（按钮变红要求二次确认），3 秒未复点自动解除。
  const disarm = () => {
    clearTimeout(confirmTimer.current)
    setConfirming(false)
  }
  const openEditor = () => {
    // Chips stay mounted while the editor is open (0.4.39): a re-click must
    // not clobber the in-progress draft — just return to the textarea.
    if (editing) {
      const el = textareaRef.current
      if (el !== null) el.focus()
      return
    }
    disarm()
    clearTimeout(closeTimer.current)
    setClosing(false)
    setDraft(textOf(content))
    setFailure(null)
    setEditing(true)
  }
  const closeEditor = () => {
    disarm()
    setClosing(true)
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      setEditing(false)
      setClosing(false)
      setFailure(null)
    }, 120)
  }
  const settle = (result, op) => {
    setBusy(false)
    if (!result || result.ok !== true) {
      const code = result?.error?.code
      setFailure(code === 'agent-busy' ? t('error.busy') : (result?.error?.message ?? t('error.generic')))
      return
    }
    if (result.value?.markerT1Broken === true) {
      // R2：该 marker 会使 /compact 失效——编辑已生效，但提示离线清理。
      setFailure(t('marker.t1Broken'))
    }
    if (op === 'recall') {
      const echoed = typeof result.value?.text === 'string' && result.value.text.length > 0
        ? result.value.text
        : textOf(content)
      if (echoed && inputActions && typeof inputActions.setDraft === 'function') {
        inputActions.setDraft(echoed)
      }
      return
    }
    if (op === 'editAndResend') {
      if (result.value?.resendMessageId && typeof result.value?.originalText === 'string') {
        editReferences.set(result.value.resendMessageId, result.value.originalText)
      }
      setEditing(false)
      setClosing(false)
    }
  }
  const run = (op, extra = {}) => {
    setBusy(true)
    setFailure(null)
    callOp(op, { sessionId, messageId, ...extra }).then(
      (result) => settle(result, op),
      (error) => {
        setBusy(false)
        setFailure(error?.message ?? t('error.generic'))
      },
    )
  }
  const armRecall = () => {
    if (editing) closeEditor()
    if (confirming) {
      disarm()
      run('recall')
      return
    }
    setConfirming(true)
    confirmTimer.current = setTimeout(() => setConfirming(false), RECALL_CONFIRM_MS)
  }

  // The chips row stays parked on the clock · copy row at ALL times (0.4.39):
  // opening the editor no longer swaps it away. The editor card renders as a
  // SIBLING of the row (outside .dsh-rt-user-row, so the parked transform
  // never drags it) and takes flow space via the CSS :not(:has(.dsh-rt-editor))
  // escape on the zero-height rule. The error rides the parked row in chips
  // state but drops below the editor when one is open.
  return createElement(Fragment, null, [
    createElement('div', { key: 'row', className: 'dsh-rt-user-row' }, [
      createElement('span', { key: 'actions', className: 'dsh-rt-user-actions' }, [
        createElement('button', {
          key: 'edit',
          type: 'button',
          className: 'dsh-rt-ghost',
          title: t('action.edit'),
          disabled: busy,
          onClick: openEditor,
        }, t('action.edit')),
        createElement('button', {
          key: 'recall',
          type: 'button',
          className: confirming ? 'dsh-rt-ghost dsh-rt-ghost-armed' : 'dsh-rt-ghost dsh-rt-ghost-danger',
          title: confirming ? t('action.recallConfirmHint') : t('action.recallUser'),
          disabled: busy,
          onClick: armRecall,
        }, confirming ? t('action.recallConfirm') : t('action.recall')),
      ]),
      // Chips state: the error rides the parked row (visible next to the
      // meta line). Editor state renders it below the card instead.
      !editing && failure !== null && createElement('div', { key: 'error', className: 'dsh-rt-error', role: 'status' }, failure),
    ]),
    editing && createElement('div', { key: 'editor', className: closing ? 'dsh-rt-editor dsh-rt-editor-closing' : 'dsh-rt-editor' }, [
      createElement('textarea', {
        key: 'input',
        ref: textareaRef,
        className: 'dsh-rt-textarea',
        'aria-label': t('action.editAria'),
        placeholder: t('action.editPlaceholder'),
        value: draft,
        onChange: handleDraftChange,
        onKeyDown: handleKeyDown,
      }),
      createElement('div', { key: 'buttons', className: 'dsh-rt-editor-buttons' }, [
        createElement('button', {
          key: 'send',
          type: 'button',
          className: 'dsh-rt-editor-send',
          disabled: busy || draft.trim().length === 0,
          onClick: () => run('editAndResend', {
            text: draft.trim(),
            fromScratch: getConfig().editFromScratch,
          }),
        }, t('action.send')),
        createElement('button', {
          key: 'cancel',
          type: 'button',
          className: 'dsh-rt-editor-cancel',
          disabled: busy,
          onClick: closeEditor,
        }, t('action.cancel')),
      ]),
    ]),
    editing && failure !== null && createElement('div', { key: 'error', className: 'dsh-rt-error', role: 'status' }, failure),
  ])
}

/** The transient notice row: hides shadowed content, dismissed after the user keeps typing. */
function RecallMarkerRow({ node, useChat, t }) {
  const { seq, op, shadowedSeqs, legacy, compact } = node.data
  // Compaction checkpoints render nothing here: their only role is feeding
  // useShadowed so compacted messages lose their edit/recall entries.
  const dismissed = useMarkerDismissed(useChat, seq, op)
  const hidePlan = useMarkerHidePlan(useChat)
  // Compact markers render nothing, but bail out only AFTER the hooks above
  // (same mid-hook-return fix as UserActionsRow — v0.4.40): a marker that
  // turns compact mid-life would otherwise drop two hooks and crash the entry.
  if (compact) return null
  const plan = hidePlan.planFor(node.key)
  const hiddenKeys = legacy || !getConfig().hideShadowed ? null : (plan?.keys ?? null)

  // The hide rules must stay mounted even after the notice is dismissed,
  // otherwise the recalled message would reappear. Legacy markers and the
  // `hideShadowed: off` preference never inject hide rules.
  const css = hiddenKeys === null
    ? null
    : hiddenKeys.map((key) => `[data-chat-anchor-key=${JSON.stringify(key)}]{display:none!important}`).join('')
  const count = Array.isArray(shadowedSeqs) ? shadowedSeqs.length : 0
  const label = op === 'recall'
    ? (count > 1 ? t('marker.recallMany', { count }) : t('marker.recallOne'))
    : op === 'regenerate' ? t('marker.regenerate')
    : op === 'fold' ? t('marker.fold', { count })
    : t('marker.edit')
  // A per-marker safety-guard trip (e.g. "start a fresh conversation") and a
  // collective-hide hint appear once, on the first marker row.
  const degradedHint = !legacy && plan?.degraded === true
    ? createElement('div', { key: 'degraded', className: 'dsh-rt-marker-hint' }, t('marker.degradedHint'))
    : null
  const unionHint = !legacy && hidePlan.firstMarkerKey === node.key && hidePlan.rowCount > SHADOW_MIN_ROWS_FOR_RATIO && hidePlan.unionRatio > SHADOW_SAFETY_RATIO
    ? createElement('div', { key: 'union', className: 'dsh-rt-marker-hint' },
        t('marker.unionHint', { count: Math.round(hidePlan.unionRatio * 100) }))
    : null

  return createElement('div', { className: 'dsh-rt-marker-block', 'data-dismissed': dismissed || undefined }, [
    css !== null && createElement('style', { key: 'hide', dangerouslySetInnerHTML: { __html: css } }),
    !dismissed && createElement('div', { key: 'label', className: 'dsh-rt-marker', role: 'status' }, label),
    !dismissed && degradedHint,
    !dismissed && unionHint,
  ])
}

/** Settings → General: the plugin's two preference toggles. */
function OptionsRow({ t }) {
  const config = useConfig()
  const toggle = (key) => (event) => setConfig({ [key]: event.target.checked })
  const optionRow = (key, labelKey, descKey) => createElement('label', { key, className: 'dsh-rt-option' }, [
    createElement('input', { type: 'checkbox', checked: config[key], onChange: toggle(key) }),
    createElement('span', { className: 'dsh-rt-option-text' }, [
      createElement('span', { className: 'dsh-rt-option-label' }, t(labelKey)),
      createElement('span', { className: 'dsh-rt-option-desc' }, t(descKey)),
    ]),
  ])
  return createElement('div', { className: 'dsh-rt-options' }, [
    createElement('div', { key: 'title', className: 'dsh-rt-options-title' }, t('options.title')),
    createElement('label', { key: 'original', className: 'dsh-rt-option' }, [
      createElement('input', {
        type: 'checkbox',
        checked: config.showOriginalInput,
        onChange: toggle('showOriginalInput'),
      }),
      createElement('span', null, t('options.showOriginalInput')),
    ]),
    createElement('label', { key: 'fresh', className: 'dsh-rt-option' }, [
      createElement('input', {
        type: 'checkbox',
        checked: config.editFromScratch,
        onChange: toggle('editFromScratch'),
      }),
      createElement('span', null, t('options.editFromScratch')),
    ]),
    optionRow('hideShadowed', 'options.hideShadowed', 'options.hideShadowedDesc'),
    optionRow('versioning', 'options.versioning', 'options.versioningDesc'),
    optionRow('git', 'options.git', 'options.gitDesc'),
    createElement('div', { key: 'retention', className: 'dsh-rt-option dsh-rt-option-number' }, [
      createElement('span', { className: 'dsh-rt-option-text' }, [
        createElement('span', { className: 'dsh-rt-option-label' }, t('options.retention')),
        createElement('span', { className: 'dsh-rt-option-desc' }, t('options.retentionDesc')),
      ]),
      createElement('input', {
        type: 'number',
        min: 5,
        max: 500,
        step: 5,
        className: 'dsh-rt-retention-input',
        value: config.retentionLimit,
        onChange: (event) => {
          const value = Math.max(1, Math.min(1000, Number(event.target.value) || 50))
          setConfig({ retentionLimit: value })
        },
      }),
    ]),
  ])
}

// ---------------------------------------------------------------------------
// Styles (plain injected <style>; removed with the plugin)
// ---------------------------------------------------------------------------
const STYLE_ID = 'dsh-retrace-css'
const CSS = `
.dsh-rt-strip{display:inline-flex !important;align-items:center;gap:3px;opacity:1;visibility:visible;vertical-align:middle}
.dsh-rt-icon{width:26px;height:26px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:1px solid transparent;border-radius:7px;display:inline-flex;justify-content:center;align-items:center;padding:0;font-size:13px;line-height:1;transition:all .16s cubic-bezier(0.16,1,0.3,1)}
.dsh-rt-icon:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover-solid) 80%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 60%,transparent);color:var(--dsw-alias-label-primary);transform:translateY(-0.5px)}
.dsh-rt-icon:active:not(:disabled){transform:scale(.92)}
.dsh-rt-icon:disabled{opacity:.35;cursor:default;transform:none}
.dsh-rt-user-row{display:flex;flex-direction:column;align-items:flex-end;gap:4px;margin-top:2px}
.dsh-rt-user-actions{display:inline-flex;align-items:center;gap:6px;vertical-align:middle}
/* 对话页紧凑化：官方 chat.node 槽位把 user-actions 渲染成气泡下方的独立行
   （flowItem），这里把该行收成 0 高、把槽位输出的 chips 行平移进官方
   「时间·复制」行里——官方行整体左移让位（chips 宽 + gap），chips 紧跟复制按钮
   之后，行末右缘仍对齐消息列右缘（气泡右缘正下方），全部留在列内。几何由
   apply() 的 alignChatActionRows 量出并写进 inline transform；收行与悬停显隐
   全走 CSS，React 在 chips ↔ 内联编辑器之间切换时能立刻恢复行高与官方行位置。 */
[data-chat-flow-kind="user-actions"]:has(.dsh-rt-user-row>.dsh-rt-user-actions):not(:has(.dsh-rt-editor)){height:0;min-height:0;margin-top:0 !important;overflow:visible}
[data-chat-flow-kind="user-actions"]:has(.dsh-rt-user-row>.dsh-rt-user-actions) .dsh-rt-user-row{width:fit-content;margin-left:auto;pointer-events:none}
[data-chat-flow-kind="user-actions"] .dsh-rt-user-row>.dsh-rt-user-actions{pointer-events:auto}
/* 思考折叠的坑：harness 的 Turn-process 判别把「锚在用户消息 seq 上」的插件 seat
   也算进 process 组（data-turn-process-member，见 ChatNodeSeat.tsx 的 processMember），
   思考收起时该 seat 被套上 hidden="until-found"，其 UA 规则是
   content-visibility:hidden —— 整棵子树停止绘制，chips 于是凭空消失；但它的
   inline transform 与 getBoundingClientRect 全都原封不动（rect 非零），纯几何
   测量根本察觉不到。这个 seat 里只有我们的操作行、永远没有 process 内容，所以这里
   只解除绘制抑制（hidden 属性保留，harness 的行距/find-in-page 语义不受影响）。 */
[data-chat-flow-kind="user-actions"][data-turn-process-member]{content-visibility:visible !important}
@media (hover:hover){
[data-chat-flow-kind="user-actions"]:has(~:is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"])) .dsh-rt-user-row{opacity:0;transition:opacity 80ms ease}
}
[data-chat-flow-kind="user-actions"]:hover .dsh-rt-user-row,[data-chat-flow-kind="user-actions"]:focus-within .dsh-rt-user-row,[data-chat-flow-kind="user"]:hover+[data-chat-flow-kind="user-actions"] .dsh-rt-user-row,[data-chat-flow-kind="user"]:focus-within+[data-chat-flow-kind="user-actions"] .dsh-rt-user-row,[data-chat-flow-kind="steering"]:hover+[data-chat-flow-kind="user-actions"] .dsh-rt-user-row,[data-chat-flow-kind="steering"]:focus-within+[data-chat-flow-kind="user-actions"] .dsh-rt-user-row,[data-chat-flow-kind="user-actions"]:has(.dsh-rt-ghost-armed) .dsh-rt-user-row,[data-chat-flow-kind="user-actions"]:has(.dsh-rt-editor) .dsh-rt-user-row,[data-chat-flow-kind="user-actions"]:has(.dsh-rt-error) .dsh-rt-user-row{opacity:1}
.dsh-rt-ghost{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 65%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 40%,rgba(255,255,255,.15));border-radius:999px;white-space:nowrap;padding:2px 11px;font-size:12px;line-height:20px;font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.02),inset 0 1px 0 rgba(255,255,255,.15);transition:all .18s cubic-bezier(0.16,1,0.3,1)}
.dsh-rt-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover-solid) 80%,transparent);border-color:var(--dsw-alias-border-l1);transform:translateY(-0.5px);box-shadow:0 2px 6px rgba(0,0,0,.05),inset 0 1px 0 rgba(255,255,255,.25)}
.dsh-rt-ghost:active:not(:disabled){transform:scale(.96)}
.dsh-rt-ghost:disabled{opacity:.5;cursor:default;transform:none}
.dsh-rt-ghost-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-interactive-bg-hover));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 25%,transparent)}
@keyframes dsh-rt-arm-pop{0%{transform:scale(.92)}50%{transform:scale(1.06)}100%{transform:scale(1)}}
@keyframes dsh-rt-armed-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.25)}50%{box-shadow:0 0 0 3px rgba(239,68,68,.12)}}
.dsh-rt-ghost-armed,.dsh-rt-ghost-armed:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);font-weight:600;animation:dsh-rt-arm-pop .22s cubic-bezier(0.34,1.56,0.64,1),dsh-rt-armed-pulse 1.8s infinite ease-in-out .22s}
.dsh-rt-ghost-armed:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent)}
.dsh-rt-chip{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);border:none;border-radius:12px;padding:2px 10px;font-size:12px;line-height:20px}
.dsh-rt-chip:hover:not(:disabled){color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-rt-chip:disabled{opacity:.5;cursor:default}
@keyframes dsh-rt-enter{from{opacity:0;transform:translateY(-6px) scale(.97)}to{opacity:1;transform:none}}
@keyframes dsh-rt-exit{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-4px) scale(.98)}}
.dsh-rt-editor{display:flex;flex-direction:column;gap:10px;width:min(540px,85%);margin-left:auto;margin-top:2px;background:color-mix(in srgb,var(--dsw-alias-bg-elevated) 58%,transparent);backdrop-filter:blur(18px) saturate(180%);-webkit-backdrop-filter:blur(18px) saturate(180%);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 65%,transparent);border-radius:15px;padding:12px 14px 10px;box-shadow:0 6px 20px rgba(0,0,0,.04),0 1px 2px rgba(0,0,0,.02);animation:dsh-rt-enter .2s cubic-bezier(0.16,1,0.3,1) forwards;transition:border-color .22s cubic-bezier(0.16,1,0.3,1),box-shadow .22s cubic-bezier(0.16,1,0.3,1),background .22s cubic-bezier(0.16,1,0.3,1)}
.dsh-rt-editor-closing{animation:dsh-rt-exit .12s cubic-bezier(0.16,1,0.3,1) forwards;pointer-events:none}
.dsh-rt-editor:focus-within{background:color-mix(in srgb,var(--dsw-alias-bg-elevated) 68%,transparent);border-color:color-mix(in srgb,#fb923c 60%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,#fb923c 40%,transparent),0 6px 20px rgba(249,115,22,.04)}
.dsh-rt-textarea{resize:none;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:transparent;border:none;outline:none;padding:2px 0;font:inherit;font-size:14px;line-height:1.55;letter-spacing:.1px;min-height:56px;max-height:360px;overflow-y:auto;transition:height .16s cubic-bezier(0.16,1,0.3,1)}
.dsh-rt-textarea::placeholder{color:var(--dsw-alias-label-caption);opacity:.65}
.dsh-rt-textarea::-webkit-scrollbar{width:4px}
.dsh-rt-textarea::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.dsh-rt-textarea::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-l1)}
.dsh-rt-textarea:focus{box-shadow:none}
.dsh-rt-editor-buttons{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:2px}
.dsh-rt-editor-send{display:inline-flex;align-items:center;justify-content:center;color:#fff;cursor:pointer;background:#fb923c;border:1px solid #f97316;border-radius:999px;padding:4px 16px;font-size:12.5px;line-height:18px;font-weight:500;box-shadow:none;transition:background .15s ease,border-color .15s ease,transform .1s ease,opacity .15s ease}
.dsh-rt-editor-send:hover:not(:disabled){background:#f97316;border-color:#ea580c;transform:translateY(-0.5px)}
.dsh-rt-editor-send:active:not(:disabled){transform:scale(.97)}
.dsh-rt-editor-send:disabled{opacity:.4;cursor:default;transform:none}
.dsh-rt-editor-cancel{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 65%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:4px 14px;font-size:12.5px;line-height:18px;font-weight:500;box-shadow:none;transition:background .15s ease,border-color .15s ease,color .15s ease,transform .1s ease}
.dsh-rt-editor-cancel:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-border-l1);transform:translateY(-0.5px)}
.dsh-rt-editor-cancel:active:not(:disabled){transform:scale(.97)}
.dsh-rt-editor-cancel:disabled{opacity:.4;cursor:default;transform:none}
.dsh-rt-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;max-width:min(540px,85%)}
.dsh-rt-marker-block{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;max-width:var(--dsh-chat-content-width);box-sizing:border-box;margin:14px auto;padding:0;position:relative}
.dsh-rt-marker-block:not([data-dismissed])::before{content:"";position:absolute;left:0;right:0;top:11px;height:1px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent) 20%,color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent) 80%,transparent 100%);pointer-events:none}
.dsh-rt-marker{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-elevated) 85%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 75%,transparent);border-radius:999px;padding:2px 12px;font-size:11px;line-height:16px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.03);letter-spacing:.2px;transition:all .18s ease}
.dsh-rt-marker::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:color-mix(in srgb,#fb923c 75%,transparent);margin-right:6px;flex-shrink:0;transition:all .18s ease}
.dsh-rt-marker:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);box-shadow:0 4px 12px rgba(0,0,0,.05)}
.dsh-rt-marker:hover::before{background:#fb923c;box-shadow:0 0 6px rgba(251,146,60,.5)}
.dsh-rt-marker-hint{position:relative;z-index:1;text-align:center;color:var(--dsw-alias-state-warning-primary);font-size:11px;line-height:16px;margin-top:2px}
.dsh-rt-reference{width:min(540px,85%);box-sizing:border-box;backdrop-filter:blur(18px) saturate(180%);-webkit-backdrop-filter:blur(18px) saturate(180%);background:color-mix(in srgb,var(--dsw-alias-bg-elevated) 58%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 65%,transparent);border-left:3px solid #fb923c;border-radius:12px;padding:5px 12px;box-shadow:0 4px 14px rgba(0,0,0,.03);transition:border-color .18s ease,border-left-color .18s ease,box-shadow .18s ease,background .18s ease}
.dsh-rt-reference:hover{border-color:var(--dsw-alias-border-l1);border-left-color:#f97316;box-shadow:0 6px 18px rgba(0,0,0,.05)}
.dsh-rt-reference summary{color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;font-size:12px;font-weight:500;line-height:22px;list-style:none;display:inline-flex;align-items:center;gap:6px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .15s ease}
.dsh-rt-reference summary::-webkit-details-marker{display:none}
.dsh-rt-reference summary:before{content:"▸";display:inline-block;transition:transform .15s ease,color .15s ease;font-size:10px;color:var(--dsw-alias-label-caption)}
.dsh-rt-reference[open] summary:before{transform:rotate(90deg);color:#fb923c}
.dsh-rt-reference summary:hover{color:var(--dsw-alias-label-primary)}
.dsh-rt-reference summary:hover:before{color:#fb923c}
.dsh-rt-reference-text{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px;padding:6px 0 4px;border-top:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.dsh-rt-options{display:flex;flex-direction:column;gap:8px;padding:2px 0}
.dsh-rt-options-title{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;line-height:20px}
.dsh-rt-option{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer}
.dsh-rt-option-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-rt-option-label{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-rt-option-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.dsh-rt-option-number{align-items:flex-start}
.dsh-rt-retention-input{width:64px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-elevated);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 6px;font:inherit;font-size:13px;outline:none;margin-top:1px}
.dsh-rt-retention-input:focus{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.dsh-rt-option input{accent-color:var(--dsw-alias-state-business-primary)}
/* ---- P1 timeline (conversation view tab) ---- */

.dsh-rt-view{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;flex:1 1 0%;min-height:0;overflow:hidden;padding:12px 16px 0}
.dsh-rt-timeline-head{display:flex;align-items:center;gap:8px;flex:none}
.dsh-rt-timeline-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px;flex:1}
.dsh-rt-timeline-git{display:flex;align-items:center;gap:6px;flex:none;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px}
.dsh-rt-doctor{border-color:var(--dsw-alias-state-warning-primary);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-rt-doctor .dsh-rt-timeline-git-text{color:var(--dsw-alias-state-warning-primary)}
.dsh-rt-timeline-git-text{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-rt-timeline-list{overflow-y:auto;flex:1;min-height:0;position:relative;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}
.dsh-rt-timeline-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:12px 4px;text-align:center}
.dsh-rt-version{position:absolute;left:0;right:0;height:60px;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;border:1px solid transparent;border-radius:10px;padding:6px 8px}
.dsh-rt-version:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dsh-rt-version-kind{flex:none;width:22px;height:22px;display:inline-flex;justify-content:center;align-items:center;border-radius:6px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:1px}
.dsh-rt-version-kind-restore{background:var(--dsw-alias-state-success-bg);color:var(--dsw-alias-state-success-primary)}
.dsh-rt-version-kind-compaction{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-caption)}
.dsh-rt-version-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-rt-version-line{display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap}
.dsh-rt-version-kind-label{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:16px}
.dsh-rt-version-time,.dsh-rt-version-msgs{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-rt-version-files{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis}
.dsh-rt-version-text{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-version-actions{flex:none;display:inline-flex;gap:4px;opacity:0;transition:opacity .1s}
.dsh-rt-version:hover .dsh-rt-version-actions{opacity:1}
.dsh-rt-chip-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-rt-chip-danger:hover{color:var(--dsw-alias-state-error-primary)}
.dsh-rt-modal{position:absolute;inset:0;z-index:130;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;border-radius:12px;background:var(--dsw-specific-menu);padding:10px;box-shadow:var(--dsw-shadow-lv3)}
.dsh-rt-modal-title{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}
.dsh-rt-modal-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}
.dsh-rt-modal-body{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0}
.dsh-rt-modal-line{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-rt-modal-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto}
.dsh-rt-modal-files li{display:flex;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-rt-art-restore{color:var(--dsw-alias-state-success-primary);flex:none}
.dsh-rt-art-delete{color:var(--dsw-alias-state-error-primary);flex:none}
.dsh-rt-art-skip{color:var(--dsw-alias-label-caption);flex:none}
.dsh-rt-art-path{font-family:var(--dsw-font-mono);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-modal-scope{display:flex;flex-direction:column;gap:4px}
.dsh-rt-modal-buttons{display:flex;justify-content:flex-end;gap:8px;flex:none}
.dsh-rt-confirm{background:var(--dsw-alias-state-error-primary)}
.dsh-rt-confirm:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,#000)}
.dsh-rt-modal-json{margin:0;overflow:auto;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-elevated);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;font-family:var(--dsw-font-mono);font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-all}
.dsh-rt-fork-list{overflow-y:auto;flex:1;min-height:0;position:relative}
.dsh-rt-fork-spine-label{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;flex:none}
.dsh-rt-fork-row{position:absolute;left:0;right:0;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px}
.dsh-rt-fork-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-fork-icon{flex:none;width:22px;height:22px;display:inline-flex;justify-content:center;align-items:center;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-rt-fork-boundary .dsh-rt-fork-icon{color:var(--dsw-alias-state-warning-primary)}
.dsh-rt-fork-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-rt-fork-line{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsh-rt-fork-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dsh-rt-fork-seq{font-family:var(--dsw-font-mono);font-size:11px;line-height:18px;color:var(--dsw-alias-label-caption);flex:none}
.dsh-rt-fork-shadowed{font-size:11px;line-height:18px;color:var(--dsw-alias-state-warning-primary);flex:none}
.dsh-rt-fork-text{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-fork-boundary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-elevated)}
.dsh-rt-fork-hist{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;overflow-y:auto;flex:none}
.dsh-rt-fork-hist-row{display:flex;align-items:flex-start;gap:8px;padding:4px 8px;border-radius:8px}
.dsh-rt-fork-hist-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-fork-lineage{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-elevated);border-radius:8px;padding:8px;flex:none}
.dsh-rt-fork-lineage-hop{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsh-rt-fork-lineage-tag{font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);flex:none}
.dsh-rt-lineage-this .dsh-rt-fork-lineage-tag{color:var(--dsw-alias-state-info-primary)}
.dsh-rt-lineage-root .dsh-rt-fork-lineage-tag{color:var(--dsw-alias-state-success-primary)}
.dsh-rt-fork-lineage-id{font-family:var(--dsw-font-mono);font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-fork-lineage-arrow{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);flex:none}
.dsh-rt-fork-lineage-empty{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;flex:none}
.dsh-rt-fork-badge{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-elevated);border-radius:8px;padding:6px 8px;flex:none;min-width:0}
.dsh-rt-fork-badge-tag{font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);flex:none}
.dsh-rt-fork-badge-code{font-family:var(--dsw-font-mono);font-size:12px;font-weight:600;line-height:16px;color:var(--dsw-alias-state-info-primary);flex:none}
.dsh-rt-fork-badge-id{font-family:var(--dsw-font-mono);font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

const JUMP_PAGE_BUDGET = 24

/**
 * Switch to a conversation view tab programmatically.
 *
 * The official API offers no setView to third-party views: `actions` is only
 * injected to entries that declare a `store`, and the chat store is private to
 * ui-conversation — so `actions?.setView?.(...)` silently no-ops for plugins
 * (0.4.2 relied on it; verified against the renderer source 2026-08-26). The
 * only programmatic path is clicking the tab-bar button — the same path a user
 * click takes. Tab buttons render in registration order (priority, then
 * order): chat=0, trajectory=10, retrace=20, retrace-fork=30. A view with an
 * earlier order would shift the indices; verified on the real harness before
 * relying on the positions.
 */
function switchToViewTab(viewId) {
  const ORDER = { chat: 0, trajectory: 1, retrace: 2, 'retrace-fork': 3 }
  const index = ORDER[viewId]
  if (index === undefined) {
    console.warn(`[dsh-retrace] no tab order registered for "${viewId}"`)
    return
  }
  // Only VISIBLE tablists count — hidden tabbars (settings etc.) must not
  // shift the index (0.4.x review: a document-wide query could click the
  // wrong control). The conversation view's tab bar is the visible one.
  const buttons = [...document.querySelectorAll('[role="tablist"]')]
    .filter((tablist) => tablist.getBoundingClientRect().width > 0)
    .flatMap((tablist) => [...tablist.querySelectorAll('[role="tab"]')])
  const button = buttons[index]
  if (!button) {
    console.warn(`[dsh-retrace] tab "${viewId}" (index ${index}) not found in the conversation tab bar`)
    return
  }
  button.click()
}

/** Count chat nodes regardless of store shape (Map or iterator-only). */
function nodeCountOf(nodes) {
  if (!nodes) return 0
  if (typeof nodes.size === 'number') return nodes.size
  return [...nodes.values()].length
}

/** rAF poll for an element that appears after a view switch + render pass. */
function waitForElement(selector, frames) {
  return new Promise((resolve) => {
    let remaining = frames
    const probe = () => {
      const el = document.querySelector(selector)
      if (el !== null) return resolve(el)
      if (remaining-- <= 0) return resolve(null)
      requestAnimationFrame(probe)
    }
    requestAnimationFrame(probe)
  })
}

/** One-shot highlight for the jumped-to row (removes itself). */
function flashKey(key) {
  const id = `dsh-rt-jump-${key.replace(/[^a-z0-9]/gi, '-')}`
  if (document.querySelector(`style[data-plugin-css="${id}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = id
  tag.textContent = `[data-chat-anchor-key=${JSON.stringify(key)}]{animation:dsh-rt-flash 1.6s ease-out 2}@keyframes dsh-rt-flash{0%,100%{background:transparent}30%,70%{background:var(--dsw-alias-state-business-primary)}55%{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}}`
  document.head.appendChild(tag)
  setTimeout(() => tag.remove(), 3400)
}

/**
 * Shared jump (versions + fork views): switch to the chat tab, page up via the
 * session store until the anchor seq is loaded, then scroll the chat row into
 * view once it renders. The view switch unmounts the current view, so the
 * whole flow runs here. The store has no seek-to-seq API — only `loadOlder`
 * (50/page) — so far-away targets are unreachable without thousands of pages;
 * cap the budget.
 */
async function jumpToAnchor(store, anchorSeq) {
  switchToViewTab('chat')
  if (!store || typeof store.loadOlder !== 'function' || typeof store.getSnapshot !== 'function') return
  const keyOfSeq = (seq) => {
    const nodes = store.getSnapshot()?.chat?.nodes
    if (!nodes) return null
    for (const node of nodes.values()) {
      if (typeof node.anchorSeq === 'number' && node.anchorSeq === seq) return node.key
    }
    return null
  }
  let key = keyOfSeq(anchorSeq)
  let pages = 0
  while (key === null && pages < JUMP_PAGE_BUDGET && store.hasMore) {
    // Map/iterator-agnostic node count: `.size` may be absent on the
    // snapshot's node store and `values()` yields an iterator with no
    // `.length` — spread it (0.4.x review: the loop used to break after one
    // page because the count was always undefined).
    const before = nodeCountOf(store.getSnapshot()?.chat?.nodes)
    await store.loadOlder()
    const after = nodeCountOf(store.getSnapshot()?.chat?.nodes)
    pages += 1
    if (after === before) break // page returned nothing
    key = keyOfSeq(anchorSeq)
  }
  if (key === null) {
    // Give the last prepend a tick to propagate into the snapshot first.
    await new Promise((resolve) => setTimeout(resolve, 60))
    key = keyOfSeq(anchorSeq)
  }
  if (key === null) {
    console.warn(`[dsh-retrace] jump target seq ${anchorSeq} not reached within ${JUMP_PAGE_BUDGET} pages`)
    return
  }
  // The chat view is now mounted (tab click above); poll for its rendered row.
  const el = await waitForElement(`[data-chat-anchor-key=${JSON.stringify(key)}]`, 90)
  if (el === null) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flashKey(key)
}

/** Surface node type → icon (fork spine rows). */
const NODE_ICONS = { 'user/message': '👤', 'assistant/message': '🤖', 'tool/result': '🔧' }

/** Surface node type → localized label. */
function nodeTypeLabel(type, t) {
  if (type === 'user/message') return t('fork.node.user')
  if (type === 'assistant/message') return t('fork.node.assistant')
  if (type === 'tool/result') return t('fork.node.tool')
  return type
}

/**
 * Bound a windowed list to the available height.
 *
 * The conversation view area is a flex chain whose middle (`viewArea`,
 * `flex:1 0 auto; min-height:auto`) grows to CONTENT — a virtualized list's
 * tall spacer (N × rowHeight) inflates the whole view to the full list height,
 * so the list never scrolls and the window slice never moves (verified on the
 * real harness 2026-08-26; the official trajectory view avoids this because
 * its virtualized content contributes no tall spacer). Measuring the list
 * height against the viewport and setting it explicitly caps the spacer's
 * contribution — the view then collapses back to the bounded height.
 */
function bindListHeight(listEl) {
  if (!listEl) return () => {}
  const measure = () => {
    const top = listEl.getBoundingClientRect().top
    const height = Math.max(120, window.innerHeight - top - 16)
    if (Math.abs(listEl.clientHeight - height) > 4) {
      // The list is a flex item (flex:1 → flex-basis:0%); a plain height is
      // ignored by the flex layout, so pin it with flex:none.
      listEl.style.flex = 'none'
      listEl.style.height = `${height}px`
    }
  }
  measure()
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
  ro?.observe(document.body)
  window.addEventListener('resize', measure)
  return () => {
    ro?.disconnect()
    window.removeEventListener('resize', measure)
  }
}

function ensureStyle() {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-retrace'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

// ---------------------------------------------------------------------------
// P1 — Version timeline (header action + floating panel)
// ---------------------------------------------------------------------------
// Data sources, per PLAN.md §5.1: the live `session/projection` push frames
// arrive through the `useProjection` standard kit when present (zero polling);
// the HTTP `/versions` route is the fallback (opened on demand + manual
// refresh). Detail reads are lazy `GET /event`; rollback runs
// `POST /rollback/preview` → confirm → `POST /rollback`; the git banner uses
// `GET /git/status` and `POST /git/init`. The list window is a zero-dependency
// fixed-row virtualizer (uniform rows) — @tanstack/react-virtual was evaluated
// but bundling it (~15 KiB) for a list this size is not worth it.

const KIND_ICONS = { recall: '↩', edit: '✎', regenerate: '↻', restore: '⟲', compaction: '▤', replace: '⇄' }

function kindLabel(kind, t) {
  return t(`timeline.kind.${kind}`) || kind
}

function timeLabel(ms) {
  const date = new Date(ms)
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function timelineGet(path) {
  return fetch(`${ROUTE_BASE}${path}`, { headers: retraceConfigHeaders() }).then((res) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
    return res.json()
  })
}

/** Format a file-count badge. */
function fileCountLabel(counts, t) {
  const total = (counts?.created ?? 0) + (counts?.modified ?? 0) + (counts?.deleted ?? 0)
  if (total === 0) return t('timeline.filesNone')
  return t('timeline.files', {
    created: counts.created ?? 0,
    modified: counts.modified ?? 0,
    deleted: counts.deleted ?? 0,
  })
}

/**
 * P1 — Version timeline as an official conversation view tab (PLAN §5.1,
 * 0.4.2 trajectory-leverage): rendered in the `conversation.view` slot (a tab
 * next to 对话/轨迹). The versions data channel stays plugin-owned — the live
 * `session/projection` push frames arrive through
 * `useProjection('retrace/versions')` when present (zero polling), with the
 * HTTP `/versions` route as fallback — because versions are DERIVED data the
 * official event stream does not carry. The view shell, view switching,
 * paging and the trajectory handoff reuse the official mechanisms.
 */
function RetraceView({ sessionId, useProjection, t, actions, store }) {
  const [versions, setVersions] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [git, setGit] = useState(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewScope, setPreviewScope] = useState('both')
  // 语义短码（2026-09-01）：默认空,异步从 host 短码表拿（工作区+序号语义）。
  // 不用 FNV 兜底显示——修复线规则是 op065op016 这类语义码,不是随机 hash。
  const [badge, setBadge] = useState('')
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [doctor, setDoctor] = useState(null)

  // Live push-frame path (projection standard kit) — falls back to HTTP.
  const projected = typeof useProjection === 'function' ? useProjection('retrace/versions') : undefined

  useEffect(() => {
    if (projected && Array.isArray(projected.versions)) setVersions(projected.versions)
  }, [projected])

  const refresh = () => {
    setLoading(true)
    setError(null)
    timelineGet(`/versions?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (!result || result.ok !== true) throw new Error(result?.error?.message ?? 'versions failed')
        setVersions(result.value?.versions ?? [])
      })
      .catch((cause) => setError(cause?.message ?? 'timeline error'))
      .finally(() => setLoading(false))
  }

  const refreshGit = () => {
    if (getConfig().git !== true) return
    timelineGet(`/git/status?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => setGit(result?.ok === true ? result.value : null))
      .catch(() => setGit(null))
  }

  // Mount-time load: projection push frames arrive live when the host mounts
  // the registry; HTTP is the on-demand fallback for minimal compositions.
  useEffect(() => {
    if (projected === undefined) refresh()
    refreshGit()
    // Compression pre-check: flag turn-null markers that would break /compact.
    timelineGet(`/doctor?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => setDoctor(result?.ok === true ? result.value : null))
      .catch(() => setDoctor(null))
    // 写入短码 title（一次：如果标题已含短码则跳过）
    callOp('setBadgeTitle', { sessionId }).catch(() => {})
    // 语义短码（2026-09-01）：host 短码表优先（工作区+序号），FNV 兜底
    callOp('sessionBadge', { sessionId }).then((result) => {
      if (result && result.ok === true && typeof result.value?.badge === 'string') {
        setBadge(result.value.badge)
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Jump: switch to the chat tab (tab-bar click — `actions?.setView?.()` is a
  // silent no-op for store-less third-party views), page up via the session
  // store until the anchor seq is loaded, then scroll the chat row into view.
  // The whole flow runs here because the view switch unmounts this view.
  const jump = (boundarySeq) => jumpToAnchor(store, boundarySeq)

  const requestPreview = (record) => {
    setPreviewScope('both')
    setPreview({ versionId: record.versionId, kind: record.kind, boundarySeq: record.boundarySeq, data: null, error: null })
    callOp('rollback/preview', { sessionId, versionId: record.versionId, scope: 'both' }).then((result) => {
      setPreview((prev) => prev && prev.versionId === record.versionId
        ? { ...prev, data: result?.ok === true ? result.value : null, error: result?.ok === true ? null : result?.error?.message ?? null }
        : prev)
    })
  }

  const confirmRollback = () => {
    if (!preview) return
    setRollbackBusy(true)
    callOp('rollback', { sessionId, versionId: preview.versionId, scope: previewScope }).then((result) => {
      setRollbackBusy(false)
      if (!result || result.ok !== true) {
        setPreview((prev) => prev && { ...prev, error: result?.error?.message ?? 'rollback failed' })
        return
      }
      setPreview(null)
      if (projected === undefined) refresh()
      refreshGit()
    })
  }

  const initGit = () => {
    if (!window.confirm(t('timeline.gitInitConfirm'))) return
    setGitBusy(true)
    callOp('git/init', { sessionId }).then((result) => {
      setGitBusy(false)
      refreshGit()
    })
  }

  // ---- windowed list (uniform rows, zero-dep) ----
  const ROW_H = 64
  const list = versions ?? []
  // 2026-08-30 渲染卡死修复（与 ForkView 同）：带起始索引切片，渲染用索引算 top——
  // 原 `list.indexOf(record)` 是 O(N²)（每可见行线性查找），大会话渲染风暴。
  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_H) - 2)
  const visibleEnd = Math.min(list.length, Math.ceil(scrollTop / ROW_H) + Math.ceil(640 / ROW_H) + 2)
  const visible = list.slice(visibleStart, visibleEnd)

  // Same view-area height trap as the fork list (see bindListHeight).
  useEffect(() => {
    if (list.length === 0) return undefined
    return bindListHeight(document.querySelector('.dsh-rt-view .dsh-rt-timeline-list'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length])

  return createElement('div', { className: 'dsh-rt-view' }, [
    createElement('div', { key: 'head', className: 'dsh-rt-timeline-head' }, [
      createElement('span', { key: 'title', className: 'dsh-rt-timeline-title' }, t('timeline.title')),
      // 会话铭牌（2026-09-01）：所有界面统一展示短码，沟通任务用
      sessionId && createElement('code', { key: 'badge', className: 'dsh-rt-fork-badge-code', title: t('fork.badgeHint') }, `[${badge}]`),
      createElement('button', {
        key: 'refresh',
        type: 'button',
        className: 'dsh-rt-chip',
        onClick: refresh,
      }, t('timeline.refresh')),
    ]),

    doctor && doctor.enabled && doctor.markerCount > 0 && createElement('div', { key: 'doctor', className: 'dsh-rt-timeline-git dsh-rt-doctor' }, [
      createElement('span', { key: 'text', className: 'dsh-rt-timeline-git-text' }, t('timeline.doctorWarn', { count: doctor.markerCount })),
    ]),

    git !== null && git !== undefined && createElement('div', { key: 'git', className: 'dsh-rt-timeline-git' }, [
      git.headHash
        ? [
            createElement('span', { key: 'r', className: 'dsh-rt-timeline-git-text' }, `${t('timeline.gitRepo')} · ${t('timeline.gitHead', { hash: git.headHash.slice(0, 8) })}${git.dirty ? ` · ${t('timeline.gitDirty')}` : ''}`),
          ]
        : createElement('button', {
            key: 'init',
            type: 'button',
            className: 'dsh-rt-chip',
            disabled: gitBusy,
            onClick: initGit,
            title: t('timeline.gitInitDesc'),
          }, t('timeline.gitInit')),
    ]),

    error !== null && createElement('div', { key: 'error', className: 'dsh-rt-error' }, error),
    loading && createElement('div', { key: 'loading', className: 'dsh-rt-timeline-empty' }, t('timeline.loading')),
    !loading && list.length === 0 && createElement('div', { key: 'empty', className: 'dsh-rt-timeline-empty' }, t('timeline.empty')),

    list.length > 0 && createElement('div', {
      key: 'list',
      className: 'dsh-rt-timeline-list',
      onScroll: (event) => setScrollTop(event.target.scrollTop),
    }, [
      createElement('div', { key: 'spacer', style: { height: `${list.length * ROW_H}px`, position: 'relative' } }, [
        visible.map((record, i) => createElement(VersionRow, {
          key: record.versionId,
          record,
          t,
          top: (visibleStart + i) * ROW_H,
          onPreview: () => requestPreview(record),
          onTrajectory: () => switchToViewTab('trajectory'),
          onJump: () => jump(record.boundarySeq),
        })),
      ]),
    ]),

    preview && createElement(PreviewBox, {
      key: 'preview',
      preview,
      scope: previewScope,
      setScope: setPreviewScope,
      busy: rollbackBusy,
      t,
      onConfirm: confirmRollback,
      onCancel: () => setPreview(null),
    }),
  ])
}

/** One version row (uniform height for the windowed list). */
function VersionRow({ record, top, t, onPreview, onTrajectory, onJump }) {
  return createElement('div', { className: 'dsh-rt-version', style: { top: `${top}px` } }, [
    createElement('span', { key: 'kind', className: `dsh-rt-version-kind dsh-rt-version-kind-${record.kind}`, title: kindLabel(record.kind, t) }, KIND_ICONS[record.kind] ?? '•'),
    createElement('div', { key: 'body', className: 'dsh-rt-version-body' }, [
      createElement('div', { key: 'line1', className: 'dsh-rt-version-line' }, [
        createElement('span', { key: 'kind', className: 'dsh-rt-version-kind-label' }, kindLabel(record.kind, t)),
        createElement('span', { key: 'time', className: 'dsh-rt-version-time' }, timeLabel(record.createdAt)),
        createElement('span', { key: 'msgs', className: 'dsh-rt-version-msgs' }, t('timeline.messages', { count: record.messageCount })),
        createElement('span', { key: 'files', className: 'dsh-rt-version-files' }, fileCountLabel(record.fileCounts, t)),
      ]),
      record.markerText
        ? createElement('div', { key: 'text', className: 'dsh-rt-version-text' }, record.markerText.length > 120 ? `${record.markerText.slice(0, 120)}…` : record.markerText)
        : null,
    ]),
    createElement('span', { key: 'actions', className: 'dsh-rt-version-actions' }, [
      createElement('button', { key: 'jump', type: 'button', className: 'dsh-rt-chip', onClick: onJump }, t('timeline.jump')),
      createElement('button', { key: 'trajectory', type: 'button', className: 'dsh-rt-chip', onClick: onTrajectory, title: t('timeline.trajectory') }, t('timeline.trajectory')),
      createElement('button', { key: 'preview', type: 'button', className: 'dsh-rt-chip dsh-rt-chip-danger', onClick: onPreview }, t('timeline.preview')),
    ]),
  ])
}

/** Rollback preview + confirm box (scope selector + artifact actions). */
function PreviewBox({ preview, scope, setScope, busy, t, onConfirm, onCancel }) {
  const data = preview.data
  const scopes = [
    ['context', 'timeline.contextOnly', 'timeline.contextOnlyDesc'],
    ['artifacts', 'timeline.artifactsOnly', 'timeline.artifactsOnlyDesc'],
    ['both', 'timeline.both', 'timeline.bothDesc'],
  ]
  return createElement('div', { className: 'dsh-rt-modal' }, [
    createElement('div', { key: 'title', className: 'dsh-rt-modal-title' }, [
      t('timeline.preview'),
      createElement('span', { key: 'ver', className: 'dsh-rt-modal-sub' }, t('timeline.previewDesc', { version: preview.versionId, kind: kindLabel(preview.kind, t) })),
    ]),
    preview.error && createElement('div', { key: 'err', className: 'dsh-rt-error' }, preview.error),
    data === null && !preview.error && createElement('div', { key: 'wait', className: 'dsh-rt-timeline-empty' }, t('timeline.loading')),
    data && createElement('div', { key: 'body', className: 'dsh-rt-modal-body' }, [
      createElement('div', { key: 'ctx', className: 'dsh-rt-modal-line' },
        data.context?.messages > 0
          ? t('timeline.messagesRemoved', { count: data.context.messages })
          : t('timeline.noChanges')),
      createElement('div', { key: 'art', className: 'dsh-rt-modal-line' }, t('timeline.artifactsList', { count: data.artifacts?.rows?.length ?? 0 })),
      createElement('ul', { key: 'files', className: 'dsh-rt-modal-files' }, (data.artifacts?.rows ?? []).slice(0, 12).map((row) =>
        createElement('li', { key: row.path }, [
          createElement('span', { key: 'a', className: `dsh-rt-art-${row.action}` },
            row.action === 'skip' ? `${t('timeline.artifact.skip')} (${row.reason ?? ''})` : (row.action === 'delete' ? t('timeline.artifact.delete') : t('timeline.artifact.restore'))),
          createElement('span', { key: 'p', className: 'dsh-rt-art-path' }, row.path),
        ]))),
      createElement('div', { key: 'scope', className: 'dsh-rt-modal-scope' }, scopes.map(([value, labelKey, descKey]) =>
        createElement('label', { key: value, className: 'dsh-rt-option' }, [
          createElement('input', { type: 'radio', name: 'rt-scope', checked: scope === value, onChange: () => setScope(value) }),
          createElement('span', { className: 'dsh-rt-option-text' }, [
            createElement('span', { className: 'dsh-rt-option-label' }, t(labelKey)),
            createElement('span', { className: 'dsh-rt-option-desc' }, t(descKey)),
          ]),
        ]))),
    ]),
    createElement('div', { key: 'buttons', className: 'dsh-rt-modal-buttons' }, [
      createElement('button', { key: 'cancel', type: 'button', className: 'dsh-rt-editor-cancel', disabled: busy, onClick: onCancel }, t('timeline.cancel')),
      createElement('button', { key: 'confirm', type: 'button', className: 'dsh-rt-editor-send dsh-rt-confirm', disabled: busy || preview.error !== null, onClick: onConfirm },
        busy ? t('timeline.busy') : t('timeline.confirm')),
    ]),
  ])
}

/**
 * P2.1 — Fork map: the branch-topology view (PLAN §5.2).
 *
 * Data: `retrace/forkmap` projection — live push frames via
 * `useProjection('retrace/forkmap')` (zero polling), HTTP `/forkmap` fallback.
 * Rendering: a spine of current-surface nodes (the CURRENT path — markers sit
 * on it); at each boundary (recall / edit / regenerate / restore — the fork
 * points) a card shows the shadowed (OLD-path) cluster count plus the marker
 * summary, joined from `retrace/versions` by boundarySeq (the fork-map wire
 * stays lean). Node clicks jump to the conversation via the shared
 * `jumpToAnchor` (tab-bar click + loadOlder + anchor scroll).
 *
 * The old-path node details (messages/thinking/tools inside a cluster) belong
 * to P2.2 (branch-intent cards); this skeleton establishes the topology.
 */
function ForkView({ sessionId, useProjection, t, actions, store }) {
  const [fork, setFork] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [lineage, setLineage] = useState(null)
  // 语义短码（2026-09-01）：默认空,异步从 host 短码表拿（工作区+序号语义）。
  // 不用 FNV 兜底显示——修复线规则是 op065op016 这类语义码,不是随机 hash。
  const [badge, setBadge] = useState('')

  // Live push-frame path (projection standard kit) — falls back to HTTP.
  const projected = typeof useProjection === 'function' ? useProjection('retrace/forkmap') : undefined
  // markerText lives in the versions wire; join it by boundarySeq.
  const versions = typeof useProjection === 'function' ? useProjection('retrace/versions') : undefined
  const markerBySeq = new Map((versions?.versions ?? []).map((v) => [v.boundarySeq, v.markerText]))

  useEffect(() => {
    if (projected && Array.isArray(projected.nodes) && Array.isArray(projected.boundaries)) setFork(projected)
  }, [projected])

  const refresh = () => {
    setLoading(true)
    setError(null)
    timelineGet(`/forkmap?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (!result || result.ok !== true) throw new Error(result?.error?.message ?? 'forkmap failed')
        setFork(result.value?.nodes ? result.value : null)
      })
      .catch((cause) => setError(cause?.message ?? 'forkmap error'))
      .finally(() => setLoading(false))
  }

  // Mount-time load: push frames arrive live when the host mounts the
  // registry; HTTP is the on-demand fallback for minimal compositions.
  useEffect(() => {
    if (projected === undefined) refresh()
    // Lineage chain (A4): read-only parent walk; shown as a header card.
    timelineGet(`/lineage?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (result && result.ok === true && Array.isArray(result.value)) setLineage(result.value)
      })
      .catch(() => { /* lineage is a best-effort enrichment */ })
    // 语义短码（2026-09-01）：host 短码表优先（工作区+序号），FNV 兜底
    callOp('sessionBadge', { sessionId }).then((result) => {
      if (result && result.ok === true && typeof result.value?.badge === 'string') {
        setBadge(result.value.badge)
        // 用官方 rename 更新 title（投影立即刷新，侧边栏/标题栏显示 [短码] 名称）
        // rename 会写 user source title → 停自动改名。若 rename 不可用，fallback host setBadgeTitle。
        if (store && typeof store.rename === 'function') {
          const current = typeof store.getTitle === 'function' ? store.getTitle() : null
          const base = (typeof current === 'string' && current.trim()) ? current : sessionId.slice(0, 16)
          const tagged = `[${result.value.badge}] ${base.replace(/^\[[a-z0-9]{6,}\]\s*/, '')}`
          store.rename(tagged).catch(() => callOp('setBadgeTitle', { sessionId }).catch(() => {}))
        } else {
          callOp('setBadgeTitle', { sessionId }).catch(() => {})
        }
      } else {
        callOp('setBadgeTitle', { sessionId }).catch(() => {})
      }
    }).catch(() => {})
    // 批量初始化所有会话标题短码（只跑一次，会话列表侧边栏直接显示）
    if (!window.__dshRetraceBadgeInit) {
      window.__dshRetraceBadgeInit = true
      callOp('initBadgeTitles', {}).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nodes = fork?.nodes ?? []
  const boundaries = fork?.boundaries ?? []
  const boundaryBySeq = new Map(boundaries.map((b) => [b.seq, b]))
  // Boundaries whose marker is no longer on the current surface (a later
  // replace shadowed it — e.g. chained edits of one message) have no spine
  // node; render them in a historical section so every fork point stays
  // visible.
  const spineSeqSet = new Set(nodes.map((n) => n.seq))
  const offSpine = boundaries.filter((b) => !spineSeqSet.has(b.seq))

  // The view-area flex chain grows to content; bound the list height so the
  // virtual spacer doesn't inflate the whole view (see bindListHeight).
  useEffect(() => {
    if (nodes.length === 0) return undefined
    return bindListHeight(document.querySelector('.dsh-rt-view .dsh-rt-fork-list'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length])

  // ---- windowed list (uniform rows, zero-dep; same as the versions view) ----
  // 2026-08-30 渲染卡死修复：visible 改为带起始索引的切片，渲染时直接用索引算
  // top——原实现 `nodes.indexOf(node)` 在每次渲染对每个可见节点做 O(N) 线性查找
  // （2047 节点 × ~15 可见行 = 每次渲染 ~30K 次比较，React 重渲染风暴 → 转圈、
  // Renderer CPU 27.7%，526f1835 打开卡死）。其他会话节点少不触发，仅大会话暴露。
  const ROW_H = 56
  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_H) - 2)
  const visibleEnd = Math.min(nodes.length, Math.ceil(scrollTop / ROW_H) + Math.ceil(640 / ROW_H) + 2)
  const visible = nodes.slice(visibleStart, visibleEnd)

  return createElement('div', { className: 'dsh-rt-view' }, [
    createElement('div', { key: 'head', className: 'dsh-rt-timeline-head' }, [
      createElement('span', { key: 'title', className: 'dsh-rt-timeline-title' }, t('fork.title')),
      createElement('button', {
        key: 'refresh',
        type: 'button',
        className: 'dsh-rt-chip',
        onClick: refresh,
      }, t('fork.refresh')),
    ]),

    // 会话铭牌（2026-08-31）：短码 = 从 session id 确定性导出，永不变（标题会变）。
    sessionId && createElement('div', { key: 'badge', className: 'dsh-rt-fork-badge', title: t('fork.badgeHint') }, [
      createElement('span', { key: 'tag', className: 'dsh-rt-fork-badge-tag' }, t('fork.badge')),
      createElement('code', { key: 'code', className: 'dsh-rt-fork-badge-code' }, `[${badge}]`),
      createElement('span', { key: 'id', className: 'dsh-rt-fork-badge-id' }, sessionId),
      // 编辑名称（2026-09-01）：用户可自定义会话名，自动拼短码 + 固定（停自动改名）
      createElement('button', {
        key: 'rename',
        type: 'button',
        className: 'dsh-rt-chip',
        onClick: () => {
          const name = window.prompt(t('fork.renamePrompt'), '')
          if (name && name.trim()) {
            const tagged = `[${badge}] ${name.trim()}`
            if (store && typeof store.rename === 'function') {
              store.rename(tagged).catch(() => callOp('setUserTitle', { sessionId, title: name.trim() }).catch(() => {}))
            } else {
              callOp('setUserTitle', { sessionId, title: name.trim() }).catch(() => {})
            }
          }
        },
      }, t('fork.rename')),
    ]),

    Array.isArray(lineage) && lineage.length > 1 && createElement('div', { key: 'lineage', className: 'dsh-rt-fork-lineage' }, [
      createElement('div', { key: 'lt', className: 'dsh-rt-fork-spine-label' }, t('fork.lineage')),
      lineage.map((hop, i) => createElement('div', {
        key: hop.id,
        className: `dsh-rt-fork-lineage-hop${i === 0 ? ' dsh-rt-lineage-this' : ''}${i === lineage.length - 1 ? ' dsh-rt-lineage-root' : ''}`,
      }, [
        createElement('span', { key: 'tag', className: 'dsh-rt-fork-lineage-tag' },
          i === 0 ? t('fork.lineageThis') : (i === lineage.length - 1 ? t('fork.lineageRoot') : t('fork.lineageParent'))),
        createElement('code', { key: 'badge', className: 'dsh-rt-fork-badge-code' }, `[${sessionBadge(hop.id)}]`),
        createElement('span', { key: 'id', className: 'dsh-rt-fork-lineage-id' }, hop.id),
        i < lineage.length - 1 && createElement('span', { key: 'arrow', className: 'dsh-rt-fork-lineage-arrow' }, '←'),
      ])),
    ]),
    Array.isArray(lineage) && lineage.length <= 1 && createElement('div', { key: 'lineage-empty', className: 'dsh-rt-fork-lineage-empty' }, t('fork.lineageEmpty')),

    error !== null && createElement('div', { key: 'error', className: 'dsh-rt-error' }, error),
    loading && createElement('div', { key: 'loading', className: 'dsh-rt-timeline-empty' }, t('timeline.loading')),
    !loading && nodes.length === 0 && createElement('div', { key: 'empty', className: 'dsh-rt-timeline-empty' }, t('fork.empty')),

    nodes.length > 0 && createElement('div', { key: 'spine', className: 'dsh-rt-fork-spine-label' }, t('fork.spine')),

    nodes.length > 0 && createElement('div', {
      key: 'list',
      className: 'dsh-rt-fork-list',
      onScroll: (event) => setScrollTop(event.target.scrollTop),
    }, [
      createElement('div', { key: 'spacer', style: { height: `${nodes.length * ROW_H}px`, position: 'relative' } }, [
        visible.map((node, i) => createElement(ForkRow, {
          key: node.seq,
          node,
          boundary: boundaryBySeq.get(node.seq),
          markerText: markerBySeq.get(node.seq),
          t,
          top: (visibleStart + i) * ROW_H,
          onJump: () => jumpToAnchor(store, node.seq),
        })),
      ]),
    ]),

    offSpine.length > 0 && createElement('div', { key: 'hist', className: 'dsh-rt-fork-hist' }, [
      createElement('div', { key: 'title', className: 'dsh-rt-fork-spine-label' }, t('fork.histTitle')),
      offSpine.map((boundary) => createElement(ForkHistRow, {
        key: boundary.seq,
        boundary,
        markerText: markerBySeq.get(boundary.seq),
        t,
        onJump: () => jumpToAnchor(store, boundary.seq),
      })),
    ]),
  ])
}

/** One spine row; boundary rows additionally show the old-path cluster. */
function ForkRow({ node, boundary, markerText, t, top, onJump }) {
  const isBoundary = boundary !== undefined
  const icon = isBoundary ? (KIND_ICONS[boundary.kind] ?? '•') : (NODE_ICONS[node.type] ?? '•')
  const label = isBoundary ? kindLabel(boundary.kind, t) : nodeTypeLabel(node.type, t)
  return createElement('div', {
    className: `dsh-rt-fork-row${isBoundary ? ' dsh-rt-fork-boundary' : ''}`,
    style: { top: `${top}px` },
  }, [
    createElement('span', { key: 'icon', className: 'dsh-rt-fork-icon' }, icon),
    createElement('div', { key: 'body', className: 'dsh-rt-fork-body' }, [
      createElement('div', { key: 'line', className: 'dsh-rt-fork-line' }, [
        createElement('span', { key: 'label', className: 'dsh-rt-fork-label' }, label),
        createElement('span', { key: 'seq', className: 'dsh-rt-fork-seq' }, `#${node.seq}`),
        isBoundary && boundary.replacedSeqs.length > 0 && createElement('span', { key: 'shadowed', className: 'dsh-rt-fork-shadowed' },
          t('fork.shadowed', { count: boundary.replacedSeqs.length })),
      ]),
      isBoundary && markerText && createElement('div', { key: 'text', className: 'dsh-rt-fork-text' },
        markerText.length > 140 ? `${markerText.slice(0, 140)}…` : markerText),
    ]),
    createElement('button', { key: 'jump', type: 'button', className: 'dsh-rt-chip', onClick: onJump }, t('timeline.jump')),
  ])
}

/** A historical fork point whose marker was itself shadowed (not on the spine). */
function ForkHistRow({ boundary, markerText, t, onJump }) {
  return createElement('div', { className: 'dsh-rt-fork-hist-row' }, [
    createElement('span', { key: 'icon', className: 'dsh-rt-fork-icon' }, KIND_ICONS[boundary.kind] ?? '•'),
    createElement('div', { key: 'body', className: 'dsh-rt-fork-body' }, [
      createElement('div', { key: 'line', className: 'dsh-rt-fork-line' }, [
        createElement('span', { key: 'label', className: 'dsh-rt-fork-label' }, kindLabel(boundary.kind, t)),
        createElement('span', { key: 'seq', className: 'dsh-rt-fork-seq' }, `#${boundary.seq}`),
        boundary.replacedSeqs.length > 0 && createElement('span', { key: 'shadowed', className: 'dsh-rt-fork-shadowed' },
          t('fork.shadowed', { count: boundary.replacedSeqs.length })),
      ]),
      markerText && createElement('div', { key: 'text', className: 'dsh-rt-fork-text' },
        markerText.length > 140 ? `${markerText.slice(0, 140)}…` : markerText),
    ]),
    createElement('button', { key: 'jump', type: 'button', className: 'dsh-rt-chip', onClick: onJump }, t('timeline.jump')),
  ])
}


// ---------------------------------------------------------------------------
// Conversation-page compact action row
// ---------------------------------------------------------------------------
// `user-actions` is registered as an official `conversation.chat.node` key, so
// the harness renders it as its OWN flow row right after the user flow row —
// user-actions is a sibling of [data-chat-flow-kind="user"], while the copy
// button sits INSIDE that row (userRow > actions > [clock, button[复制]]).
// The official `extraActions` seat of MessageIconActions exists, but the
// harness's UserMessageNodeView never passes it for user messages (only the
// assistant turn tail does), so there is no React-level seat to move into.
//
// Instead of reparenting the slot's React-owned nodes (which would make React
// call removeChild on the wrong host parent when the row unmounts on
// recall/shadow/session switch — a NotFoundError that kills the view), keep the
// DOM untouched: CSS collapses the flow row to zero height, and this measurer
// only writes an inline translate() onto our own row to park the chips right of
// the official copy button (the copy button must stay the chips' left
// neighbour). That row is right-aligned to the message column edge, so the
// chips live in the empty page gutter just outside the column — never over the
// bubble, the clock or the copy button, and clamped so they stay inside the
// viewport. Geometry is measured, so clock width, branch/usage seats,
// font-size preferences and viewport width all stay aligned; a MutationObserver
// (rAF-debounced) + interval + resize re-applies it after React re-renders.
const CHAT_ACTION_GAP = 8

/**
 * The official IconActions row inside a user flow item (clock + copy, plus the
 * user-actions seat would live here if the harness passed `extraActions`).
 * Located by the copy button's aria-label when it is zh/en (the app ships both),
 * then by structure so a language switch can never strand the chips.
 */
function userFlowActionRow(prev) {
  const labelled = prev.querySelector('button[aria-label="复制"], button[aria-label="复制成功"], button[aria-label="Copy"], button[aria-label="Copied"]')
  if (labelled !== null && labelled.parentElement !== null) return labelled.parentElement
  // user flow item > div[data-slot] > .userRow > [.userStack, actions row]
  const slot = prev.querySelector(':scope > [data-slot]') ?? prev
  const stack = slot.firstElementChild
  const actions = stack === null ? null : stack.lastElementChild
  if (actions === null || actions === stack.firstElementChild) return null
  return actions.querySelector('button') === null ? null : actions
}

/** The official row (clock · copy) a chips row must inline into; null when the row is on its own. */
function chatActionAnchor(row) {
  const flow = row.closest('[data-chat-flow-kind]')
  if (flow === null || flow.getAttribute('data-chat-flow-kind') !== 'user-actions') return null
  // Hidden flow items (find-in-page folding, collapsed turn process) may sit between the two rows.
  let prev = flow.previousElementSibling
  while (prev !== null && prev.hasAttribute('hidden')) prev = prev.previousElementSibling
  const kind = prev === null ? null : prev.getAttribute('data-chat-flow-kind')
  if (kind !== 'user' && kind !== 'steering') return null
  return userFlowActionRow(prev)
}

const chatActionTransform = (shift) => `translate(${shift.dx}px, ${shift.dy}px)`
const chatAnchorTransform = (width) => `translateX(${-(width + CHAT_ACTION_GAP)}px)`

/**
 * Re-park every conversation-page chips row INLINE with the clock · copy row:
 *   clock · copy [gap] edit [gap] recall — one continuous row inside the message
 *   column, its right edge kept on the column edge (right under the bubble's
 *   right rim). The official row is right-aligned to the column edge with zero
 *   room to its right, so making room means shifting the WHOLE official row
 *   left by chips+gap (inline transform only — the node stays React-owned, and
 *   reconciliation never rewrites the style because the components pass no
 *   style prop), then parking the chips right after the shifted copy button.
 *   Pass 1 writes the anchor shifts, so pass 2 already reads post-shift
 *   geometry: no one-frame flash of the chips out in the page gutter.
 *   Zero-size rows (editor swapped in, shadow-hidden seat) keep their previous
 *   shift and release their anchor, returning the official row to its place.
 */
function alignChatActionRows() {
  const rows = document.querySelectorAll('[data-chat-flow-kind="user-actions"] .dsh-rt-user-row')
  const anchors = []
  for (const row of rows) {
    const flow = row.closest('[data-chat-flow-kind]')
    if (flow === null) continue
    const reserved = flow._dshRtAnchor
    const release = () => {
      if (reserved !== undefined) {
        reserved.style.transform = reserved._dshRtPrevTransform ?? ''
        flow._dshRtAnchor = undefined
      }
    }
    // chips ↔ editor swaps: the row goes back in flow, give the room back. The
    // chips-era translate must go with it — a stale dy drags the whole editor
    // card up over the clock · copy row it used to park beside.
    if (row.querySelector('.dsh-rt-user-actions') === null) {
      release()
      if (row._dshRtShift !== undefined) {
        row.style.transform = ''
        row._dshRtShift = undefined
      }
      continue
    }
    const anchor = chatActionAnchor(row)
    if (anchor === null) { release(); continue }
    if (flow._dshRtAnchor !== anchor) {
      release()
      anchor._dshRtPrevTransform = anchor.style.transform
      flow._dshRtAnchor = anchor
    }
    anchors.push({ row, anchor })
    const width = row.getBoundingClientRect().width
    if (width > 0) {
      const t = chatAnchorTransform(width)
      if (anchor.style.transform !== t) anchor.style.transform = t
    }
  }
  const writes = []
  for (const { row, anchor } of anchors) {
    const prevShift = row._dshRtShift
    const own = row.getBoundingClientRect()
    if (own.width === 0 && own.height === 0) continue
    const target = anchor.getBoundingClientRect()
    const dy = Math.round((target.top + target.height / 2 - (own.top - (prevShift?.dy ?? 0) + own.height / 2)) * 100) / 100
    const dx = Math.round((target.right + CHAT_ACTION_GAP - (own.left - (prevShift?.dx ?? 0))) * 100) / 100
    // Trust but verify: re-write when the cached shift matches but the inline
    // transform was dropped, or the geometry really did move.
    if (prevShift !== undefined && prevShift.dx === dx && prevShift.dy === dy
      && row.style.transform === chatActionTransform({ dx, dy })) continue
    writes.push([row, { dx, dy }])
  }
  for (const [row, shift] of writes) {
    row.style.transform = chatActionTransform(shift)
    row._dshRtShift = shift
  }
}

/**
 * Mutation records that can actually move a parked chips row: changes inside
 * our own row (editor swap, error text, armed label), flow rows appearing or
 * disappearing (new message, session switch, seat mount/unmount) and
 * class/style/hidden flips on nodes inside a flow row (reasoning fold, hover
 * mirrors). Everything else — composer keystrokes (React sets textarea.value,
 * no DOM record) and streamed assistant text (grows rows ABOVE the parked
 * ones; the row and its anchor move together in flow, so the relative
 * translate stays correct) — is noise the old observer paid a full rescan for.
 */
const FLOW_ROW_SCOPE = '[data-chat-flow-kind]'
const OUR_ROW_SCOPE = '.dsh-rt-user-row'
const OUR_SUBTREE_SCOPE = `${FLOW_ROW_SCOPE}, ${OUR_ROW_SCOPE}, .dsh-rt-editor`
function isLayoutRelevant(records) {
  for (const record of records) {
    if (record.type === 'childList') {
      if (record.target instanceof Element
        && (record.target.closest(OUR_ROW_SCOPE) !== null || record.target.matches(FLOW_ROW_SCOPE))) return true
      for (const nodes of [record.addedNodes, record.removedNodes]) {
        for (const node of nodes) {
          if (node.nodeType !== 1) continue
          if (node.matches(OUR_SUBTREE_SCOPE) || node.querySelector(OUR_SUBTREE_SCOPE) !== null) return true
        }
      }
    } else if (record.type === 'attributes') {
      if (record.target instanceof Element && record.target.closest(FLOW_ROW_SCOPE) !== null) return true
    } else if (record.type === 'characterData') {
      const parent = record.target.parentElement
      if (parent !== null && parent.closest(OUR_ROW_SCOPE) !== null) return true
    }
  }
  return false
}

/** Install the re-measure loop: DOM mutations (rAF-debounced), a 1.5s safety net and resize. */
function installChatActionAligner(ctx) {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  let scheduled = false
  let disposed = false
  const scan = () => {
    if (!disposed) alignChatActionRows()
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      scan()
    })
  }
  const observer = new MutationObserver((records) => {
    if (isLayoutRelevant(records)) schedule()
  })
  // characterData + attributes are needed for the armed chip's label swap and
  // the reasoning fold's `hidden` toggle; the attributeFilter and
  // isLayoutRelevant above keep composer typing and streamed text from
  // reaching a full rescan. The 1.5s interval backstops what slips through
  // (e.g. the column-width drag handle restyles a non-flow ancestor).
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
    characterData: true,
  })
  const interval = setInterval(scan, 1500)
  window.addEventListener('resize', schedule)
  ctx.effect(() => () => {
    disposed = true
    observer.disconnect()
    clearInterval(interval)
    window.removeEventListener('resize', schedule)
    for (const row of document.querySelectorAll('.dsh-rt-user-row')) {
      row.style.transform = ''
      row._dshRtShift = undefined
    }
    for (const flow of document.querySelectorAll('[data-chat-flow-kind="user-actions"]')) {
      const anchor = flow._dshRtAnchor
      if (anchor !== undefined) {
        anchor.style.transform = anchor._dshRtPrevTransform ?? ''
        flow._dshRtAnchor = undefined
      }
    }
  }, 'dsh-retrace: conversation action row aligner')
}


// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function apply(ctx) {
  const disposeStyle = ensureStyle()
  ctx.effect(() => () => disposeStyle(), 'dsh-retrace: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-retrace: dictionaries')
  const t = ctx.locale.bind(NS)

  const conversationEvents = ctx.uiConversation.events
  if (conversationEvents) {
    // register() returns a disposer that removes the definition from the
    // registry service's context. It MUST be wired into ctx.effect — otherwise
    // the definition survives plugin unload/hot-reload and the next apply
    // throws "already registered" (0.4.x review: the plugin would crash after
    // one toggle in Settings).
    const disposeDefinitions = [
      conversationEvents.register(userActionsDefinition),
      conversationEvents.register(userReferenceDefinition),
      conversationEvents.register(recallMarkerDefinition),
    ]
    ctx.effect(() => () => disposeDefinitions.forEach((dispose) => dispose()), 'dsh-retrace: conversation definitions')
  }

  // 对话页紧凑操作行：把官方槽位渲染的 user-actions 行收进复制按钮那一行。
  installChatActionAligner(ctx)

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'retrace',
    order: 20,
    locale: NS,
  }, withSeatPropsGuard(AssistantActions, 'messageId')))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user-actions',
    locale: NS,
  }, withSeatPropsGuard(UserActionsRow)))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'retrace-reference',
    locale: NS,
  }, withSeatPropsGuard(ReferenceRow)))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'recall-marker',
    locale: NS,
  }, withSeatPropsGuard(RecallMarkerRow)))

  // P0 (0.4.2, trajectory-leverage) — the version timeline as an official
  // conversation view tab (next to 对话/轨迹). The view shell + switching are
  // the official mechanisms; the versions data channel stays plugin-owned
  // (projection push frames → HTTP /versions fallback).
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'retrace',
    order: 20,
    locale: NS,
    label: () => t('view.retrace'),
    inject: (sessionId, actions) => ({
      actions,
      store: ctx.get?.('sessions')?.binding?.(sessionId)?.session,
    }),
  }, RetraceView))

  // P2.1 — the fork-map view as a second official tab (next to 对话/轨迹/版本).
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'retrace-fork',
    order: 30,
    locale: NS,
    label: () => t('view.fork'),
    inject: (sessionId, actions) => ({
      actions,
      store: ctx.get?.('sessions')?.binding?.(sessionId)?.session,
    }),
  }, ForkView))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'retrace',
    order: 30,
    locale: NS,
  }, OptionsRow))
}


