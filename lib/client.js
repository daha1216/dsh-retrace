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
export const inject = ['slots', 'locale', 'uiConversation', 'conversation']

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
  // 撤回不是「删掉一条」，而是把这条及其之后的内容整体隐藏：chips 的 title 与
  // 二次确认必须说清范围，否则用户以为只影响当前这一条。
  'action.recallScopeHint': '撤回会把这条消息及其之后的全部内容从对话中隐藏（可用版本记录恢复）。',
  'action.recallScopeHintAssistant': '撤回会把这条回复及其之后的全部内容从对话中隐藏（可用版本记录恢复）。',
  'action.recallConfirmScope': '撤回并隐藏此消息及之后？',
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
  'marker.collapse': '收起折叠块',
  'marker.originalLabel': '原输入',
  'marker.referenceHint': '点击展开查看原提问（仅作对照，不会进入模型上下文）',
  'marker.degradedHint': '此操作涉及大范围对话，为保护历史未隐藏内容（日志完好）。',
  'marker.unionHint': '已累积隐藏约 {count}% 的历史消息；可在 设置→撤回 关闭「按标记隐藏」查看完整历史。',
  'marker.t1Broken': '编辑已生效；此标记会使本会话的 /compact 失效。离线清理：关闭会话后运行 dsh-log-contract fix --drop-turnnull（编辑外观会回退为原始内容）。',
  'options.title': '消息编辑插件',
  'options.showOriginalInput': '显示原来的消息',
  'options.editFromScratch': '编辑时从新对话开始',
  'options.hideShadowed': '自动隐藏被替换的旧消息',
  'options.hideShadowedDesc': '开启后，被撤回、修改或重新生成替换掉的旧消息会自动收起，对话保持整洁；关闭则所有消息都显示。放心用：一次要隐藏超过对话 40% 的内容时会自动放弃隐藏。',
  'options.versioning': '记录修改版本',
  'options.versioningDesc': '开启后，每次撤回或修改都会把当时的对话和改过的文件存一份底，随时可以恢复；关闭则撤回照常能用，只是不留底（最省空间）。',
  'options.git': '用 git 保存修改',
  'options.gitDesc': '开启后，在 git 管理的项目里用 git 存底和恢复（绝不自动提交、不动你的分支）；关闭则用插件自带的备份存在本机，效果一样。',
  'options.retention': '最多保留几个版本',
  'options.retentionDesc': '存底太多占地方，这里限制最多留几份，超出的自动清掉最旧的；你的操作记录会一直保留。',
  'settings.tab': '撤回',
  'settings.title': '撤回与版本',
  'settings.intro': '配置消息撤回、编辑重发与版本快照的行为。设置即时生效。',
  'settings.groupBehavior': '撤回与编辑',
  'settings.groupVersioning': '版本与快照',
  'options.showOriginalInputDesc': '撤回或修改消息后，在原地保留一条原来内容的对照，方便查看改了什么。',
  'options.editFromScratchDesc': '开启后，编辑消息会当作全新的对话发送，之前的内容不再发给模型；关闭则只替换这一条消息（默认关闭）。',
  'settings.stepDown': '减少保留数',
  'settings.stepUp': '增加保留数',
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
  'timeline.artifact.failed': '失败',
  'timeline.confirm': '确认回退',
  'timeline.cancel': '取消',
  'timeline.busy': '回退中…',
  'timeline.detail': '详情',
  'timeline.trajectory': '轨迹台账',
  'timeline.jump': '跳转',
  'timeline.undoDone': '已回退到 {version}',
  'timeline.undoDonePartial': '已回退到 {version}：对话部分不可撤销，只有产物能撤回。',
  'timeline.undoAction': '撤销回退',
  'timeline.undoActionArtifacts': '撤销产物回退',
  'timeline.undoHint': '撤销窗口 30 分钟，仅可用一次。',
  'timeline.undoExpired': '撤销窗口已过，原始内容不再保留。',
  'timeline.undoFailed': '撤销失败：{message}',
  'timeline.undoDismiss': '关闭',
  'time.justNow': '刚刚',
  'time.minutesAgo': '{count} 分钟前',
  'time.hoursAgo': '{count} 小时前',
  'time.yesterday': '昨天 {time}',
  'time.daysAgo': '{count} 天前',
  'timeline.jumpFailed': '该版本在较远的过去（超出自动加载预算），无法直接定位。请向上滚动加载更早消息后重试；或用「详情」查看该版本当时的事件原文。',
  'timeline.doctorWarn': '该会话含 {count} 个编辑/撤回标记，压缩（/compact）前请先清理（token meter 兼容）。',
  'timeline.gitRepo': 'git 仓库',
  'timeline.gitHead': 'HEAD {hash}',
  'timeline.gitDirty': '工作区有未提交改动',
  'timeline.gitDirtyWarn': '工作区有未提交改动：回退产物会覆盖它们，请先提交或丢弃后再试。',
  'timeline.resurrectWarn': '该版本有 {count} 条消息当前会话已不再显示，上下文无法回退；只能回退产物，或改用检查点分支。',
  'timeline.restoreDisabled': '此构建已停用回退：产物恢复与上下文恢复尚未通过安全校验，历史记录仍可查看。',
  'timeline.restoreScopeBlocked': '该范围已停用',
  'timeline.partialFailures': '部分动作未完成（{count} 项失败或跳过），详情见下方。',
  'timeline.flushWarning': '会话写入未持久化：{message}',
  'timeline.gitInit': '启用 git 版本管理',
  'timeline.gitInitDesc': '在工作区执行 git init（仅添加 .gitignore 与一个基线提交），版本回退将优先使用 git。',
  'timeline.gitInitConfirm': '确定要初始化 git 吗？',
  'error.generic': '操作失败，请重试',
  'error.busy': '请先停止当前回复再操作',
  'error.planExpired': '预览已过期或已执行，请重新预览',
  'error.restoreUnsupported': '该版本包含当前会话已不再显示的消息，替换标记无法恢复它们；请改用检查点分支',
  'error.capabilityDisabled': '该操作在当前版本中已停用',
  'error.dirty': '工作区有未提交改动，请先提交或丢弃后再回退产物',
  'error.followupFailed': '新消息发送失败；原轮已被隐藏，可在时间线用版本记录恢复',
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
  'fork.renamePrompt': '输入会话名称（短码只做展示，不会写进标题）：',
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
  'action.recallScopeHint': 'Recall hides this message and everything after it (a version record can restore it).',
  'action.recallScopeHintAssistant': 'Recall hides this reply and everything after it (a version record can restore it).',
  'action.recallConfirmScope': 'Recall and hide this message and everything after?',
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
  'marker.collapse': 'Collapse folded block',
  'marker.originalLabel': 'Original input',
  'marker.referenceHint': 'Click to expand the original input (reference only, never sent to the model)',
  'marker.degradedHint': 'This operation spans a large part of the conversation; content stays visible to protect your history (the log is intact).',
  'marker.unionHint': 'About {count}% of the history is hidden in total; disable "Hide shadowed messages" in Settings → Recall to review the full history.',
  'marker.t1Broken': 'Edit applied; this marker will break /compact for this session. Offline clean-up: close the session and run dsh-log-contract fix --drop-turnnull (the edit reverts to the original content).',
  'options.title': 'Message editor plugin',
  'options.showOriginalInput': 'Show the original message',
  'options.editFromScratch': 'Start a fresh chat when editing',
  'options.hideShadowed': 'Hide replaced messages',
  'options.hideShadowedDesc': 'On: messages replaced by a recall, edit, or regenerate are tucked away to keep the chat tidy. Off: everything stays visible. Safety net: hiding more than 40% of a conversation is skipped automatically.',
  'options.versioning': 'Keep version history',
  'options.versioningDesc': 'On: every recall or edit saves a copy of the conversation and the files it touched, so you can restore them anytime. Off: recall still works, nothing is saved (lightest).',
  'options.git': 'Save changes with git',
  'options.gitDesc': 'On: in git-managed projects, use git to save and restore (never auto-commits, never touches your branches). Off: the plugin keeps its own backups on this machine — same effect.',
  'options.retention': 'Versions to keep',
  'options.retentionDesc': 'Saves add up; cap how many versions to keep and older ones are cleaned automatically. Your operation history is always kept.',
  'settings.tab': 'Recall',
  'settings.title': 'Recall & versioning',
  'settings.intro': 'Configure message recall, edit-and-resend, and version snapshots. Changes apply immediately.',
  'settings.groupBehavior': 'Recall & editing',
  'settings.groupVersioning': 'Versioning & snapshots',
  'options.showOriginalInputDesc': 'After a recall or edit, keep a copy of what the message said before, so you can see what changed.',
  'options.editFromScratchDesc': 'On: an edited message is sent as a brand-new conversation; earlier messages are not sent to the model. Off: only that one message is replaced (default off).',
  'settings.stepDown': 'Decrease retention limit',
  'settings.stepUp': 'Increase retention limit',
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
  'timeline.artifact.failed': 'failed',
  'timeline.confirm': 'Confirm rollback',
  'timeline.cancel': 'Cancel',
  'timeline.busy': 'Rolling back…',
  'timeline.detail': 'Details',
  'timeline.trajectory': 'Trajectory',
  'timeline.jump': 'Jump',
  'timeline.undoDone': 'Rolled back to {version}',
  'timeline.undoDonePartial': 'Rolled back to {version}: the conversation part cannot be undone, only the files can.',
  'timeline.undoAction': 'Undo rollback',
  'timeline.undoActionArtifacts': 'Undo file changes',
  'timeline.undoHint': 'The undo window is 30 minutes and works once.',
  'timeline.undoExpired': 'The undo window closed; the original content is gone.',
  'timeline.undoFailed': 'Undo failed: {message}',
  'timeline.undoDismiss': 'Dismiss',
  'time.justNow': 'just now',
  'time.minutesAgo': '{count} min ago',
  'time.hoursAgo': '{count} h ago',
  'time.yesterday': 'yesterday {time}',
  'time.daysAgo': '{count} d ago',
  'timeline.jumpFailed': 'This version lies too far back (beyond the auto-load budget) to locate directly. Scroll up to load earlier messages, or use Details to read the original event text of this version.',
  'timeline.doctorWarn': 'This session has {count} edit/recall markers; clean them before /compact (token-meter compatibility).',
  'timeline.gitRepo': 'git repository',
  'timeline.gitHead': 'HEAD {hash}',
  'timeline.gitDirty': 'working tree has uncommitted changes',
  'timeline.gitDirtyWarn': 'The working tree has uncommitted changes; rolling back artifacts would overwrite them. Commit or discard them first.',
  'timeline.resurrectWarn': 'This version had {count} message(s) the session no longer shows, so its context cannot be restored. Roll back artifacts only, or use a checkpoint branch.',
  'timeline.restoreDisabled': 'Rollback is disabled in this build: artifact and context restore have not passed the safety checks yet. History stays readable.',
  'timeline.restoreScopeBlocked': 'disabled in this build',
  'timeline.partialFailures': 'Some actions did not complete ({count} failed or skipped); see the list below.',
  'timeline.flushWarning': 'Session write was not persisted: {message}',
  'timeline.gitInit': 'Enable git versioning',
  'timeline.gitInitDesc': 'Runs git init in the workspace (adds a minimal .gitignore and a baseline commit); rollback will prefer git.',
  'timeline.gitInitConfirm': 'Initialize git in this workspace?',
  'error.generic': 'Operation failed; please try again',
  'error.busy': 'Stop the current reply before recalling or editing',
  'error.planExpired': 'This preview expired or was already used; preview again',
  'error.restoreUnsupported': 'This version had messages the session no longer shows; a replacement marker cannot restore them. Use a checkpoint branch instead',
  'error.capabilityDisabled': 'This operation is disabled in the current build',
  'error.dirty': 'The workspace has uncommitted changes; commit or discard them before restoring artifacts',
  'error.followupFailed': 'The new message could not be sent; the previous turn is now hidden — restore it from the version list',
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
  'fork.renamePrompt': 'Enter a session name (the short code is display-only and is never written into the title):',
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

/**
 * Read a JSON response body. Error responses carry `{ ok: false, error }` with a
 * real HTTP status, so surface the host's message instead of a bare status code
 * (the old code threw "HTTP 404" and hid the reason).
 */
function readJsonResponse(res) {
  return res.text().then((text) => {
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (res.status < 200 || res.status >= 300) {
      const error = new Error(body?.error?.message ?? `HTTP ${res.status}`)
      error.code = body?.error?.code
      error.status = res.status
      throw error
    }
    return body
  })
}

/**
 * Server error codes that have a stable user-facing wording. Anything else falls
 * back to the host message, then to the generic string.
 */
const ERROR_MESSAGE_KEYS = {
  'plan-required': 'error.planExpired',
  'plan-expired': 'error.planExpired',
  'plan-used': 'error.planExpired',
  'plan-mismatch': 'error.planExpired',
  'plan-stale': 'error.planExpired',
  'restore-unsupported': 'error.restoreUnsupported',
  'capability-disabled': 'error.capabilityDisabled',
  'working-tree-dirty': 'error.dirty',
  'followup-failed': 'error.followupFailed',
}

function errorText(t, error) {
  const key = error?.code ? ERROR_MESSAGE_KEYS[error.code] : null
  if (key) return t(key)
  return error?.message ?? t('error.generic')
}

function callOp(op, payload) {
  if (typeof wire === 'function') return wire(op, payload)
  return fetch(`${ROUTE_BASE}/${op}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-retrace-client': CLIENT_HEADER_VALUE,
      ...retraceConfigHeaders(),
    },
    body: JSON.stringify(payload),
  }).then((res) => readJsonResponse(res))
}

/** The localStorage plugin config, carried to the Host on every request
 * (PLAN §4.6: the host honors it per request and does not persist it). */
// Identifies requests made by this plugin's own UI: a browser page on another
// origin cannot set a custom header without a preflight, which the host refuses.
const CLIENT_HEADER_VALUE = 'web'

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
/** Values are whole messages; keep the newest N so a long-lived tab cannot grow forever. */
const EDIT_REFERENCE_LIMIT = 200

function rememberEditReference(messageId, text) {
  if (typeof messageId !== 'string' || messageId.length === 0) return
  editReferences.delete(messageId)
  editReferences.set(messageId, text)
  while (editReferences.size > EDIT_REFERENCE_LIMIT) {
    editReferences.delete(editReferences.keys().next().value)
  }
}

/** apply() 注入的服务句柄：conversation.createDrafts 造草稿附件；uiConversation.imageUrl 取图片字节。 */
let imageDraftsApi = null
let imageConversationApi = null

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
  // Re-read before merging: another tab may have written since this module
  // loaded, and a whole-object write would silently drop its change.
  configCache = { ...readConfig(), ...patch }
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

// Keep settings in sync across tabs: without this the other tab keeps its
// stale in-memory copy until a full reload.
//
// 2026-10-27：曾尝试用 window 单例键去重（防 HMR 重载叠加监听器），但旧实例的
// 闭包只会更新旧模块的 configCache/configListeners，新模块反而收不到跨标签更新；
// 因此保留“每实例一个监听器”的原语义（HMR 仅开发期，叠加一个函数可忽略）。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== CONFIG_KEY && !LEGACY_CONFIG_KEYS.includes(event.key)) return
    configCache = readConfig()
    for (const listener of configListeners) listener(configCache)
  })
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

/** Per-snapshot index: finalized messageId → seq (one scan, shared by every row). */
const messageSeqIndexCache = new WeakMap()
function messageSeqIndex(nodes) {
  let index = messageSeqIndexCache.get(nodes)
  if (index) return index
  index = new Map()
  for (const node of nodes.values()) {
    if (node.kind !== 'assistant-step') continue
    const finalNode = node.data?.finalNode
    if (finalNode && typeof finalNode.messageId === 'string' && typeof finalNode.seq === 'number' && !index.has(finalNode.messageId)) {
      index.set(finalNode.messageId, finalNode.seq)
    }
  }
  messageSeqIndexCache.set(nodes, index)
  return index
}

/** The durable seq of the finalized assistant message with `messageId`. */
function useMessageSeq(useChat, messageId) {
  return useChat((snapshot) => messageSeqIndex(snapshot.nodes).get(messageId))
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
 * One pass over the nodes serving every marker: a marker used to rescan the
 * whole node map to resolve its shadowed seqs, so N markers cost O(N × nodes)
 * per snapshot (2k rows × 200 markers ≈ 4.4e5 visits). The index is built once
 * per node map and every marker resolves in O(shadowed seqs).
 */
const nodeSeqIndexCache = new WeakMap()
function nodeSeqIndex(nodes) {
  let index = nodeSeqIndexCache.get(nodes)
  if (index) return index
  const keyByAnchor = new Map()
  const turnTailBySeq = new Map()
  const toolCallBySeq = new Map()
  const push = (map, seq, key) => {
    const list = map.get(seq)
    if (list === undefined) map.set(seq, [key])
    else list.push(key)
  }
  for (const node of nodes.values()) {
    if (node.kind === 'recall-marker') continue
    if (node.kind === 'turn-tail') {
      // `closing` is the finalized assistant-step data; its seq lives on finalNode.
      const seq = node.data?.closing?.finalNode?.seq
      if (typeof seq === 'number') push(turnTailBySeq, seq, node.key)
      continue
    }
    if (node.kind === 'tool-call') {
      // Tool rows anchor at the log-only tool/call seq; match the settled
      // result's surface seq instead.
      const seq = node.data?.root?.seq
      if (typeof seq === 'number') push(toolCallBySeq, seq, node.key)
      continue
    }
    if (typeof node.anchorSeq === 'number') {
      // Pseudo rows anchor at HALF seqs to order before their message
      // (retrace-reference uses `seq - 0.5`); the shadow set holds whole seqs.
      const anchored = node.anchorSeq % 1 === 0 ? node.anchorSeq : Math.ceil(node.anchorSeq)
      if (!keyByAnchor.has(anchored)) keyByAnchor.set(anchored, node.key)
    }
  }
  index = { keyByAnchor, turnTailBySeq, toolCallBySeq }
  nodeSeqIndexCache.set(nodes, index)
  return index
}

/**
 * Every chat-node key that should disappear when `shadowedSeqs` are recalled:
 * the shadowed message rows themselves, plus the per-turn action row (copy /
 * feedback / branch) when its finalized assistant reply is among them.
 */
function hiddenKeysFor(shadowedSeqs, nodes) {
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return null
  const index = nodeSeqIndex(nodes)
  const keys = new Set()
  for (const seq of shadowedSeqs) {
    const anchored = index.keyByAnchor.get(seq)
    if (anchored !== undefined) keys.add(anchored)
    const tails = index.turnTailBySeq.get(seq)
    if (tails !== undefined) for (const key of tails) keys.add(key)
    const toolCalls = index.toolCallBySeq.get(seq)
    if (toolCalls !== undefined) for (const key of toolCalls) keys.add(key)
  }
  return keys.size === 0 ? null : [...keys]
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
 * One pass over the snapshot serves every per-row marker hook below: each row
 * used to rescan all nodes and recompute every marker's hidden keys, which made
 * large sessions O(rows × nodes) per render. The snapshot is stable between
 * events, so the index is cached by its nodes map.
 */
const markerIndexCache = new WeakMap()
function markerIndexFor(snapshot) {
  const nodes = snapshot.nodes
  let index = markerIndexCache.get(nodes)
  if (index) return index
  const rowCount = realRowCount(nodes)
  const hiddenKeys = new Set()
  const shadowedSeqs = new Set()
  const rowKeyBySeq = new Map()
  const userSeqs = []
  const editMarkers = []
  for (const node of nodes.values()) {
    if (node.kind === 'recall-marker') {
      const seqs = Array.isArray(node.data?.shadowedSeqs) ? node.data.shadowedSeqs : []
      // Compacted messages are un-editable too, so they count as shadowed.
      for (const seq of seqs) shadowedSeqs.add(seq)
      if (node.data?.op === 'edit' && typeof node.data?.seq === 'number') {
        editMarkers.push({
          seq: node.data.seq,
          text: typeof node.data.text === 'string' && node.data.text.length > 0 ? node.data.text : null,
        })
      }
      if (node.data?.compact) continue // compact markers never hide rows
      const keys = hiddenKeysFor(seqs, nodes)
      if (keys === null || shadowDegraded(keys, rowCount)) continue
      for (const key of keys) hiddenKeys.add(key)
      continue
    }
    if (typeof node.anchorSeq === 'number' && !rowKeyBySeq.has(node.anchorSeq)) rowKeyBySeq.set(node.anchorSeq, node.key)
    if (node.kind === 'user-actions' && typeof node.data?.seq === 'number') userSeqs.push(node.data.seq)
  }
  userSeqs.sort((a, b) => a - b)
  editMarkers.sort((a, b) => a.seq - b.seq)
  index = { hiddenKeys, shadowedSeqs, rowKeyBySeq, userSeqs, editMarkers }
  markerIndexCache.set(nodes, index)
  return index
}

/**
 * True when the chat row `key` is actually hidden right now — i.e. some
 * marker that is NOT degraded includes it in its hide rules. This mirrors the
 * CSS reality: a degraded marker hides nothing, so rows it shadowed stay
 * visible AND stay operable (their action rows must not vanish).
 */
function rowHiddenByKey(snapshot, rowKey) {
  if (rowKey === undefined || rowKey === null) return false
  return markerIndexFor(snapshot).hiddenKeys.has(rowKey)
}

/** Same as rowHiddenByKey, but resolves the row key from a surface seq. */
function useSeqHidden(useChat, seq) {
  return useChat((snapshot) => {
    if (seq === undefined || seq === null) return false
    const index = markerIndexFor(snapshot)
    const rowKey = index.rowKeyBySeq.get(seq)
    return rowKey !== undefined && index.hiddenKeys.has(rowKey)
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
    return markerIndexFor(snapshot).shadowedSeqs.has(seq)
  })
}

/** The marker notice disappears once the user keeps typing after the rewind. */
function useMarkerDismissed(useChat, markerSeq, op) {
  return useChat((snapshot) => {
    if (typeof markerSeq !== 'number') return false
    const { userSeqs } = markerIndexFor(snapshot)
    let after = 0
    for (let i = userSeqs.length - 1; i >= 0 && userSeqs[i] > markerSeq; i -= 1) after += 1
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
    const { userSeqs, editMarkers } = markerIndexFor(snapshot)
    let latest = null
    for (let i = editMarkers.length - 1; i >= 0; i -= 1) {
      if (editMarkers[i].seq < mySeq) {
        latest = editMarkers[i]
        break
      }
    }
    if (latest === null || latest.text === null) return null
    let prevUserSeq = -1
    for (let i = userSeqs.length - 1; i >= 0; i -= 1) {
      if (userSeqs[i] < mySeq) {
        prevUserSeq = userSeqs[i]
        break
      }
    }
    return prevUserSeq > latest.seq ? null : latest.text
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
  // 撤回整条回复不可逆且影响面大：与用户消息撤回一致，第一次点击只布防，
  // 3 秒内再点才执行（armed 时按钮变红 + 文案提示）。
  const [armed, setArmed] = useState(false)
  const armTimer = useRef(0)
  useEffect(() => () => clearTimeout(armTimer.current), [])
  // Hidden (visually) or shadowed (un-editable: recalled/edited/compacted
  // away) messages must not offer recall/regenerate — the host would reject
  // with target-shadowed.
  if (hidden || shadowed || seq === undefined) return null

  const run = (op) => {
    setBusy(true)
    setFailure(null)
    setArmed(false)
    clearTimeout(armTimer.current)
    callOp(op, { sessionId, messageId }).then(
      (result) => {
        setBusy(false)
        if (!result || result.ok !== true) {
          const message = result?.error?.message || t('error.generic')
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

  const armRecall = () => {
    if (armed) {
      run('recall')
      return
    }
    setArmed(true)
    clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => setArmed(false), RECALL_CONFIRM_MS)
  }

  return createElement('span', { className: 'dsh-rt-strip' }, [
    createElement('button', {
      key: 'recall',
      type: 'button',
      className: armed ? 'dsh-rt-icon dsh-rt-icon-armed' : 'dsh-rt-icon',
      title: armed ? t('action.recallConfirmScope') : t('action.recallScopeHintAssistant'),
      'aria-label': armed ? t('action.recallConfirmScope') : t('action.recallAssistant'),
      disabled: busy,
      onClick: armRecall,
    }, armed ? t('action.recallConfirm') : '↩'),
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

/** 撤回回显补充：把被撤回消息里的图片块恢复成输入框附件。
    持久化消息里的图片是 attachment 引用块（{type:'image', attachment:{attachmentId:'sha256:…',
    mediaType, name, bytes}}，没有内联 base64），发送时附件也已从草稿注册表退役。
    所以路径是：uiConversation.imageUrl(sessionId, attachment) 拿会话授权 URL →
    fetch 字节 → 重建浏览器 File → conversation.createDrafts 造新草稿 →
    inputActions.addAttachments 挂进输入框。旧形状（base64 data / uri）留作兜底。
    任何一步失败都静默放弃——最坏退回「只回显文本」的旧行为。 */
async function restoreImagesToComposer(sessionId, content, inputActions, options = {}) {
  if (imageDraftsApi === null || typeof imageDraftsApi.createDrafts !== 'function') return
  if (imageConversationApi === null || typeof imageConversationApi.imageUrl !== 'function') return
  if (!inputActions || typeof inputActions.addAttachments !== 'function') return
  if (typeof File !== 'function') return
  const files = []
  for (const block of content) {
    if (!block || block.type !== 'image') continue
    const att = block.attachment && typeof block.attachment === 'object' ? block.attachment : null
    const name = (att !== null && typeof att.name === 'string' && att.name !== '' ? att.name : null)
      ?? (typeof block.name === 'string' && block.name !== '' ? block.name : null)
    const mime = (att !== null && typeof att.mediaType === 'string' && att.mediaType !== '' ? att.mediaType : null)
      ?? (typeof block.mimeType === 'string' && block.mimeType !== '' ? block.mimeType : null)
      ?? (typeof block.mediaType === 'string' && block.mediaType !== '' ? block.mediaType : null)
      ?? 'image/png'
    let bytes = null
    if (att !== null && typeof att.attachmentId === 'string' && att.attachmentId !== '') {
      try {
        const url = await imageConversationApi.imageUrl(sessionId, att)
        if (typeof url === 'string' && url !== '') {
          const res = await fetch(url)
          if (res.ok) bytes = new Uint8Array(await res.arrayBuffer())
        }
      } catch { bytes = null }
    }
    if (bytes === null && typeof block.data === 'string' && block.data.length > 0 && typeof atob === 'function') {
      try {
        const bin = atob(block.data)
        bytes = new Uint8Array(bin.length)
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k)
      } catch { bytes = null }
    }
    if (bytes === null && typeof block.uri === 'string' && block.uri !== '') {
      try {
        const res = await fetch(block.uri)
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer())
      } catch { bytes = null }
    }
    if (bytes === null) continue
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'png'
    files.push(new File([bytes], name ?? 'recalled-image.' + ext, { type: mime }))
  }
  if (files.length === 0) return
  // 挂载发生在若干次 await 之后：这期间用户可能已经把回显文本发了出去，
  // 这批附件就会落到下一个草稿上。调用方给的 stillCurrent() 用来确认草稿
  // 还是回显时那一份，不是就放弃挂载（最坏退回纯文本回显）。
  if (typeof options.stillCurrent === 'function' && !options.stillCurrent()) return
  try {
    const drafts = imageDraftsApi.createDrafts(sessionId, files)
    if (Array.isArray(drafts) && drafts.length > 0) inputActions.addAttachments(drafts.map((draft) => draft.id))
  } catch { /* 静默：退回纯文本回显 */ }
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
    // IME 组字期间的 Enter/Escape 属于输入法，不能当作提交/关闭（中文/日文输入
    // 最后一步确认会误触发送）。keyCode 229 是部分浏览器的兼容信号。
    if (event.isComposing || event.keyCode === 229) return
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
        // 不覆盖用户正在写的草稿：主输入框非空时把撤回原文追加到末尾（换行分隔），
        // 空草稿才直接回填（原行为）。
        let existing = ''
        try {
          existing = typeof inputActions.getDraft === 'function' ? String(inputActions.getDraft() ?? '') : ''
        } catch { existing = '' }
        if (existing.trim().length === 0) inputActions.setDraft(echoed)
        else if (!existing.includes(echoed)) inputActions.setDraft(`${existing}\n${echoed}`)
      }
      if (Array.isArray(content) && content.some((block) => block && block.type === 'image')) {
        // 图片块随文本一起回显；失败静默退回纯文本回显（与旧行为一致）。
        // stillCurrent：草稿里还留着这次回显的文本才算同一份草稿。
        restoreImagesToComposer(sessionId, content, inputActions, {
          stillCurrent: () => {
            try {
              if (typeof inputActions.getDraft !== 'function') return true
              return String(inputActions.getDraft() ?? '').includes(echoed)
            } catch { return true }
          },
        })
      }
      return
    }
    if (op === 'editAndResend') {
      if (result.value?.resendMessageId && typeof result.value?.originalText === 'string') {
        rememberEditReference(result.value.resendMessageId, result.value.originalText)
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
          title: confirming ? t('action.recallConfirmScope') : t('action.recallScopeHint'),
          disabled: busy,
          onClick: armRecall,
          'aria-label': confirming ? t('action.recallConfirmScope') : t('action.recallScopeHint'),
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
function RecallMarkerRow({ node, sessionId, useChat, t }) {
  const { seq, op, shadowedSeqs, legacy, compact } = node.data
  // Compaction checkpoints render nothing here: their only role is feeding
  // useShadowed so compacted messages lose their edit/recall entries.
  const dismissed = useMarkerDismissed(useChat, seq, op)
  const hidePlan = useMarkerHidePlan(useChat)
  // Fold markers advertise "expandable"; without this state the promise had no
  // control at all (the /unfold route existed but was unreachable from the UI).
  const [unfolded, setUnfolded] = useState(null)
  const [unfoldBusy, setUnfoldBusy] = useState(false)
  const [unfoldError, setUnfoldError] = useState(null)
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

  // Expansion is a read-only op (the marker keeps the model context folded);
  // a missing sessionId (older seat props) simply hides the control.
  const canUnfold = op === 'fold' && !legacy && typeof sessionId === 'string' && sessionId.length > 0
  const toggleUnfold = () => {
    if (unfoldBusy || !canUnfold) return
    if (unfolded !== null) {
      setUnfolded(null)
      return
    }
    setUnfoldBusy(true)
    setUnfoldError(null)
    callOp('unfold', { sessionId, markerSeq: seq }).then((result) => {
      if (!result || result.ok !== true) throw new Error(result?.error?.message ?? t('error.generic'))
      setUnfolded(Array.isArray(result.value?.rows) ? result.value.rows : [])
      setUnfoldBusy(false)
    }).catch((cause) => {
      setUnfoldBusy(false)
      setUnfoldError(errorText(t, cause))
    })
  }
  // Bounded preview: a fold can cover hundreds of nodes, and each row here is
  // real DOM. 50 rows × 2000 chars keeps the modal responsive.
  const unfoldedView = unfolded === null ? null : createElement('div', { key: 'unfolded', className: 'dsh-rt-unfold' },
    unfolded.slice(0, 50).map((row) => createElement('div', { key: `u${row.seq}`, className: 'dsh-rt-unfold-row' }, [
      createElement('span', { key: 'meta', className: 'dsh-rt-unfold-meta' }, `#${row.seq} · ${row.type}`),
      createElement('pre', { key: 'text', className: 'dsh-rt-unfold-text' }, typeof row.text === 'string'
        ? (row.text.length > 2000 ? `${row.text.slice(0, 2000)}…` : row.text)
        : ''),
    ])))

  return createElement('div', { className: 'dsh-rt-marker-block', 'data-dismissed': dismissed || undefined }, [
    css !== null && createElement('style', { key: 'hide', dangerouslySetInnerHTML: { __html: css } }),
    !dismissed && createElement('div', { key: 'label', className: 'dsh-rt-marker', role: 'status' }, label),
    !dismissed && degradedHint,
    !dismissed && unionHint,
    !dismissed && canUnfold && createElement('button', {
      key: 'unfold',
      type: 'button',
      className: 'dsh-rt-chip dsh-rt-unfold-btn',
      disabled: unfoldBusy || undefined,
      onClick: toggleUnfold,
    }, unfolded === null ? t('marker.unfold') : t('marker.collapse')),
    !dismissed && unfoldedView,
    !dismissed && unfoldError !== null && createElement('div', { key: 'unfold-error', className: 'dsh-rt-error', role: 'status' }, unfoldError),
  ])
}

/** Settings → 撤回 section（settings.section 座位）：一行一开关的宿主风格行组件。
    整行 label 包裹按钮（可点文字切换）；开关无 hook，禁用态由父级按 versioning 联动给出。 */
function SettingSwitch({ checked, disabled, onChange, label, desc }) {
  return createElement('label', { className: 'dsh-rt-set-row' + (disabled ? ' dsh-rt-set-row-dim' : '') }, [
    createElement('span', { className: 'dsh-rt-set-copy' }, [
      createElement('span', { className: 'dsh-rt-set-label' }, label),
      desc ? createElement('span', { className: 'dsh-rt-set-desc' }, desc) : null,
    ]),
    createElement('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': label,
      disabled: disabled || undefined,
      className: 'dsh-rt-set-switch' + (checked ? ' is-on' : ''),
      onClick: () => onChange(!checked),
    }, createElement('span', { className: 'dsh-rt-set-knob', 'aria-hidden': true })),
  ])
}

/** Settings → 撤回 section：分组卡片（撤回与编辑 / 版本与快照）。
    useConfig 是唯一 hook 且置顶——本组件无早退路径，遵守 seat 硬规则。
    versioning 关闭时 git 与保留数联动降级（置灰禁用，配置值保留不丢）。 */
function RetraceSettings({ t }) {
  const config = useConfig()
  const toggle = (key) => (value) => setConfig({ [key]: value })
  const versioningOff = config.versioning === false
  const retention = config.retentionLimit ?? 50
  return createElement('div', { className: 'dsh-rt-set' }, [
    createElement('header', { key: 'head', className: 'dsh-rt-set-head' }, [
      createElement('h2', { key: 'title', className: 'dsh-rt-set-title' }, t('settings.title')),
      createElement('p', { key: 'intro', className: 'dsh-rt-set-intro' }, t('settings.intro')),
    ]),
    createElement('section', { key: 'behavior', className: 'dsh-rt-set-card' }, [
      createElement('h3', { key: 't1', className: 'dsh-rt-set-card-title' }, t('settings.groupBehavior')),
      createElement(SettingSwitch, { key: 'orig', checked: config.showOriginalInput !== false, onChange: toggle('showOriginalInput'), label: t('options.showOriginalInput'), desc: t('options.showOriginalInputDesc') }),
      createElement(SettingSwitch, { key: 'fresh', checked: config.editFromScratch === true, onChange: toggle('editFromScratch'), label: t('options.editFromScratch'), desc: t('options.editFromScratchDesc') }),
      createElement(SettingSwitch, { key: 'hide', checked: config.hideShadowed !== false, onChange: toggle('hideShadowed'), label: t('options.hideShadowed'), desc: t('options.hideShadowedDesc') }),
    ]),
    createElement('section', { key: 'versioning', className: 'dsh-rt-set-card' }, [
      createElement('h3', { key: 't2', className: 'dsh-rt-set-card-title' }, t('settings.groupVersioning')),
      createElement(SettingSwitch, { key: 'ver', checked: config.versioning !== false, onChange: toggle('versioning'), label: t('options.versioning'), desc: t('options.versioningDesc') }),
      createElement(SettingSwitch, { key: 'git', checked: config.git !== false, disabled: versioningOff, onChange: toggle('git'), label: t('options.git'), desc: t('options.gitDesc') }),
      createElement('div', { key: 'retention', className: 'dsh-rt-set-row' + (versioningOff ? ' dsh-rt-set-row-dim' : '') }, [
        createElement('span', { className: 'dsh-rt-set-copy' }, [
          createElement('span', { className: 'dsh-rt-set-label' }, t('options.retention')),
          createElement('span', { className: 'dsh-rt-set-desc' }, t('options.retentionDesc')),
        ]),
        createElement('span', { className: 'dsh-rt-set-stepper' }, [
          createElement('button', { type: 'button', className: 'dsh-rt-set-step-btn', 'aria-label': t('settings.stepDown'), disabled: versioningOff || retention <= 5 || undefined, onClick: () => setConfig({ retentionLimit: Math.max(5, retention - 5) }) }, '−'),
          createElement('input', { type: 'number', min: 5, max: 500, step: 5, className: 'dsh-rt-set-number', disabled: versioningOff || undefined, value: retention, onChange: (event) => { const value = Math.max(1, Math.min(1000, Number(event.target.value) || 50)); setConfig({ retentionLimit: value }) } }),
          createElement('button', { type: 'button', className: 'dsh-rt-set-step-btn', 'aria-label': t('settings.stepUp'), disabled: versioningOff || retention >= 500 || undefined, onClick: () => setConfig({ retentionLimit: Math.min(500, retention + 5) }) }, '+'),
        ]),
      ]),
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
.dsh-rt-icon-armed,.dsh-rt-icon-armed:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);font-size:11px;padding:0 6px;width:auto;animation:dsh-rt-arm-pop .22s cubic-bezier(0.34,1.56,0.64,1)}
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
.dsh-rt-editor{display:flex;flex-direction:column;gap:10px;width:min(540px,85%);margin-left:auto;margin-top:2px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 58%,transparent);backdrop-filter:blur(18px) saturate(180%);-webkit-backdrop-filter:blur(18px) saturate(180%);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 65%,transparent);border-radius:15px;padding:12px 14px 10px;box-shadow:var(--dsw-shadow-lv2,0 6px 20px rgba(0,0,0,.04),0 1px 2px rgba(0,0,0,.02));animation:dsh-rt-enter .2s cubic-bezier(0.16,1,0.3,1) forwards;transition:border-color .22s cubic-bezier(0.16,1,0.3,1),box-shadow .22s cubic-bezier(0.16,1,0.3,1),background .22s cubic-bezier(0.16,1,0.3,1)}
.dsh-rt-editor-closing{animation:dsh-rt-exit .12s cubic-bezier(0.16,1,0.3,1) forwards;pointer-events:none}
.dsh-rt-editor:focus-within{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 68%,transparent);border-color:color-mix(in srgb,#fb923c 60%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,#fb923c 40%,transparent),0 6px 20px rgba(249,115,22,.04)}
.dsh-rt-textarea{resize:none;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:transparent;border:none;outline:none;padding:2px 0;font:inherit;font-size:14px;line-height:1.55;letter-spacing:.1px;min-height:56px;max-height:360px;overflow-y:auto;transition:height .16s cubic-bezier(0.16,1,0.3,1)}
.dsh-rt-textarea::placeholder{color:var(--dsw-alias-label-caption);opacity:.65}
.dsh-rt-textarea::-webkit-scrollbar{width:4px}
.dsh-rt-textarea::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.dsh-rt-textarea::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-l1)}
.dsh-rt-textarea:focus{box-shadow:none}
.dsh-rt-editor-buttons{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:2px}
.dsh-rt-editor-send{display:inline-flex;align-items:center;justify-content:center;color:#20160b;cursor:pointer;background:#fb923c;border:1px solid #f97316;border-radius:999px;padding:4px 16px;font-size:12.5px;line-height:18px;font-weight:500;box-shadow:none;transition:background .15s ease,border-color .15s ease,transform .1s ease,opacity .15s ease}
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
.dsh-rt-marker{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 85%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 75%,transparent);border-radius:999px;padding:2px 12px;font-size:11px;line-height:16px;font-weight:500;box-shadow:var(--dsw-shadow-lv1,0 2px 8px rgba(0,0,0,.03));letter-spacing:.2px;transition:all .18s ease}
.dsh-rt-marker::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:color-mix(in srgb,#fb923c 75%,transparent);margin-right:6px;flex-shrink:0;transition:all .18s ease}
.dsh-rt-marker:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.05))}
.dsh-rt-marker:hover::before{background:#fb923c;box-shadow:0 0 6px rgba(251,146,60,.5)}
.dsh-rt-marker-hint{position:relative;z-index:1;text-align:center;color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:16px;margin-top:2px}
.dsh-rt-unfold-btn{position:relative;z-index:1;margin-top:4px}
.dsh-rt-unfold{position:relative;z-index:1;margin:6px auto 0;width:min(720px,92%);max-height:340px;overflow:auto;border-left:2px solid color-mix(in srgb,#fb923c 45%,transparent);padding:2px 0 2px 10px;text-align:left}
.dsh-rt-unfold-row{margin:6px 0}
.dsh-rt-unfold-meta{display:block;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.dsh-rt-unfold-text{margin:2px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-family:inherit}
.dsh-rt-reference{width:min(540px,85%);box-sizing:border-box;backdrop-filter:blur(18px) saturate(180%);-webkit-backdrop-filter:blur(18px) saturate(180%);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 58%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 65%,transparent);border-left:3px solid #fb923c;border-radius:12px;padding:5px 12px;box-shadow:var(--dsw-shadow-lv1,0 4px 14px rgba(0,0,0,.03));transition:border-color .18s ease,border-left-color .18s ease,box-shadow .18s ease,background .18s ease}
.dsh-rt-reference:hover{border-color:var(--dsw-alias-border-l1);border-left-color:#f97316;box-shadow:var(--dsw-shadow-lv2,0 6px 18px rgba(0,0,0,.05))}
.dsh-rt-reference summary{color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;font-size:12px;font-weight:500;line-height:22px;list-style:none;display:inline-flex;align-items:center;gap:6px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .15s ease}
.dsh-rt-reference summary::-webkit-details-marker{display:none}
.dsh-rt-reference summary:before{content:"▸";display:inline-block;transition:transform .15s ease,color .15s ease;font-size:10px;color:var(--dsw-alias-label-caption)}
.dsh-rt-reference[open] summary:before{transform:rotate(90deg);color:#fb923c}
.dsh-rt-reference summary:hover{color:var(--dsw-alias-label-primary)}
.dsh-rt-reference summary:hover:before{color:#fb923c}
.dsh-rt-reference-text{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px;padding:6px 0 4px;border-top:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
/* 设置页「撤回」分区（settings.section）：分组卡片 + 宿主风格开关（v0.4.45 起，替代原挤在 通用 里的一列 checkbox，.dsh-rt-option* 旧类已删除） */
.dsh-rt-set{display:flex;flex-direction:column;gap:14px;padding:4px 2px;max-width:680px}
.dsh-rt-set-head{display:flex;flex-direction:column;gap:4px;padding:0 2px}
.dsh-rt-set-title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:24px}
.dsh-rt-set-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-rt-set-card{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill,transparent);padding:2px 14px}
.dsh-rt-set-card-title{margin:12px 0 4px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:600;letter-spacing:.03em}
.dsh-rt-set-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px 0}
.dsh-rt-set-row + .dsh-rt-set-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-rt-set-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-rt-set-label{color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px}
.dsh-rt-set-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.dsh-rt-set-row-dim{opacity:.55}
.dsh-rt-set-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s ease}
.dsh-rt-set-switch:hover:not(:disabled){filter:brightness(.97)}
.dsh-rt-set-switch:disabled{cursor:not-allowed;opacity:.45}
.dsh-rt-set-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-rt-set-switch.is-on{background:var(--dsw-alias-button-primary-fill)}
.dsh-rt-set-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:var(--dsw-shadow-lv1,0 1px 4px rgba(0,0,0,.2));transition:transform .17s cubic-bezier(.22,1,.36,1)}
.dsh-rt-set-switch.is-on .dsh-rt-set-knob{background:var(--dsw-alias-label-primary-foreground,#0f1115);transform:translateX(16px)}
.dsh-rt-set-stepper{display:inline-flex;align-items:center;gap:6px;flex:none}
.dsh-rt-set-step-btn{width:26px;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer}
.dsh-rt-set-step-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-rt-set-step-btn:disabled{opacity:.4;cursor:default}
.dsh-rt-set-number{width:64px;text-align:center;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;padding:4px 6px;font:inherit;font-size:13px;outline:none}
.dsh-rt-set-number:disabled{opacity:.5}
.dsh-rt-set-number:focus{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
/* ---- P1 timeline (conversation view tab) ---- */

.dsh-rt-view{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;flex:1 1 0%;min-height:0;overflow:hidden;padding:12px 16px 0}
.dsh-rt-timeline-head{display:flex;align-items:center;gap:8px;flex:none}
.dsh-rt-timeline-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px;flex:1}
.dsh-rt-timeline-git{display:flex;align-items:center;gap:6px;flex:none;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px}
.dsh-rt-doctor{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-rt-doctor .dsh-rt-timeline-git-text{color:var(--dsw-alias-state-warn-primary)}
.dsh-rt-timeline-git-text{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-rt-timeline-list{overflow-y:auto;flex:1;min-height:0;position:relative;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}
.dsh-rt-timeline-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:12px 4px;text-align:center}
.dsh-rt-version{position:absolute;left:0;right:0;height:60px;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;border:1px solid transparent;border-radius:10px;padding:6px 8px}
.dsh-rt-version:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dsh-rt-version-kind{flex:none;width:22px;height:22px;display:inline-flex;justify-content:center;align-items:center;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:1px}
.dsh-rt-version-kind-restore{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.dsh-rt-version-kind-compaction{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-caption)}
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
.dsh-rt-chip-icon{padding:0 6px;min-width:24px;justify-content:center;line-height:20px}
.dsh-rt-undo{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dsh-rt-undo-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.dsh-rt-art-path{font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-modal-scope{display:flex;flex-direction:column;gap:4px}
.dsh-rt-modal-buttons{display:flex;justify-content:flex-end;gap:8px;flex:none}
.dsh-rt-confirm{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-rt-confirm:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,#000)}
.dsh-rt-modal-json{margin:0;overflow:auto;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-all}
.dsh-rt-fork-list{overflow-y:auto;flex:1;min-height:0;position:relative}
.dsh-rt-fork-spine-label{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;flex:none}
.dsh-rt-fork-row{position:absolute;left:0;right:0;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px}
.dsh-rt-fork-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-fork-icon{flex:none;width:22px;height:22px;display:inline-flex;justify-content:center;align-items:center;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-rt-fork-boundary .dsh-rt-fork-icon{color:var(--dsw-alias-state-warn-primary)}
.dsh-rt-fork-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-rt-fork-line{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsh-rt-fork-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dsh-rt-fork-seq{font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-caption);flex:none}
.dsh-rt-fork-shadowed{font-size:11px;line-height:18px;color:var(--dsw-alias-state-warn-primary);flex:none}
.dsh-rt-fork-text{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-fork-boundary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dsh-rt-fork-hist{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;overflow-y:auto;flex:none}
.dsh-rt-fork-hist-row{display:flex;align-items:flex-start;gap:8px;padding:4px 8px;border-radius:8px}
.dsh-rt-fork-hist-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-fork-lineage{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px;flex:none}
.dsh-rt-fork-lineage-hop{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsh-rt-fork-lineage-tag{font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);flex:none}
.dsh-rt-lineage-this .dsh-rt-fork-lineage-tag{color:var(--dsw-alias-state-business-primary)}
.dsh-rt-lineage-root .dsh-rt-fork-lineage-tag{color:var(--dsw-alias-state-success-primary)}
.dsh-rt-fork-lineage-id{font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-fork-lineage-arrow{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);flex:none}
.dsh-rt-fork-lineage-empty{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;flex:none}
.dsh-rt-fork-badge{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 8px;flex:none;min-width:0}
.dsh-rt-fork-badge-tag{font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary);flex:none}
.dsh-rt-fork-badge-code{font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px;font-weight:600;line-height:16px;color:var(--dsw-alias-state-business-primary);flex:none}
.dsh-rt-fork-badge-id{font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 回退范围单选：0.4.45 设置页重构时删掉了旧 .dsh-rt-option* 类，预览弹层仍在用，
   补回弹层内的单选样式（与设置页无关，只作用于 .dsh-rt-modal-scope）。 */
.dsh-rt-modal-scope .dsh-rt-option{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;cursor:pointer}
.dsh-rt-modal-scope .dsh-rt-option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-modal-scope .dsh-rt-option input{margin:3px 0 0;accent-color:var(--dsw-alias-state-business-primary);flex:none}
.dsh-rt-option-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-rt-option-label{color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px}
.dsh-rt-option-desc{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}
.dsh-rt-modal-scope .dsh-rt-option:has(input:checked){border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent)}
/* 版本行动作只在 hover 显示，键盘用户需要 focus 也能看到。 */
.dsh-rt-version:focus-within .dsh-rt-version-actions{opacity:1}
@media (prefers-reduced-motion:reduce){
  .dsh-rt-icon,.dsh-rt-ghost,.dsh-rt-chip,.dsh-rt-editor,.dsh-rt-editor-send,.dsh-rt-editor-cancel,.dsh-rt-marker,.dsh-rt-reference,.dsh-rt-set-switch,.dsh-rt-set-knob{transition:none !important}
  .dsh-rt-ghost-armed,.dsh-rt-icon-armed{animation:none !important}
  .dsh-rt-editor,.dsh-rt-editor-closing{animation:none !important}
}
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
  if (!store || typeof store.getSnapshot !== 'function') return
  // The current host keeps the chat nodes on the snapshot root and exposes
  // `loadThrough`; `snapshot.chat.nodes` was the older shape (it made every
  // jump silently give up after the page budget).
  const nodesOf = () => {
    const snapshot = store.getSnapshot()
    return snapshot?.nodes ?? snapshot?.chat?.nodes ?? null
  }
  const keyOfSeq = (seq) => {
    const nodes = nodesOf()
    if (!nodes) return null
    for (const node of nodes.values()) {
      if (typeof node.anchorSeq === 'number' && node.anchorSeq === seq) return node.key
    }
    return null
  }
  let key = keyOfSeq(anchorSeq)
  if (key === null && typeof store.loadThrough === 'function') {
    // Seek directly when the store can page up to a seq; a store that rejects
    // the argument simply falls through to the loadOlder loop below.
    try { await store.loadThrough(anchorSeq) } catch { /* older store */ }
    key = keyOfSeq(anchorSeq)
  }
  let pages = 0
  while (key === null && typeof store.loadOlder === 'function' && pages < JUMP_PAGE_BUDGET && store.hasMore) {
    // Map/iterator-agnostic node count: `.size` may be absent on the
    // snapshot's node store and `values()` yields an iterator with no
    // `.length` — spread it (0.4.x review: the loop used to break after one
    // page because the count was always undefined).
    const before = nodeCountOf(nodesOf())
    await store.loadOlder()
    const after = nodeCountOf(nodesOf())
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

/** Full timestamp for tooltips: a bare "10-25 13:04" leaves the year ambiguous. */
function timeAbsolute(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Relative label for the row body ("3 分钟前"): the absolute stamp stays in the
 * tooltip, so the line reads as a moment in the conversation, not a log dump.
 */
function timeRelative(ms, t) {
  const delta = Date.now() - ms
  if (!Number.isFinite(delta)) return timeLabel(ms)
  if (delta < 60_000) return t('time.justNow')
  if (delta < 3_600_000) return t('time.minutesAgo', { count: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('time.hoursAgo', { count: Math.floor(delta / 3_600_000) })
  const clock = timeLabel(ms).split(' ')[1]
  if (delta < 172_800_000) return t('time.yesterday', { time: clock })
  if (delta < 30 * 86_400_000) return t('time.daysAgo', { count: Math.floor(delta / 86_400_000) })
  return timeLabel(ms)
}

function timelineGet(path) {
  return fetch(`${ROUTE_BASE}${path}`, {
    headers: { 'x-retrace-client': CLIENT_HEADER_VALUE, ...retraceConfigHeaders() },
  }).then((res) => readJsonResponse(res))
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
  // A finished artifact rollback leaves one undo behind: the toast is the only
  // place the user can reach it, so it survives until dismissed or used.
  const [undoOffer, setUndoOffer] = useState(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [doctor, setDoctor] = useState(null)
  // Host-enforced capability gates (GET /capabilities). The timeline only reads
  // them to explain *why* an action is unavailable; the host refuses anyway.
  const [caps, setCaps] = useState(null)

  // Live push-frame path (projection standard kit) — falls back to HTTP.
  const projected = typeof useProjection === 'function' ? useProjection('retrace/versions') : undefined

  useEffect(() => {
    if (projected && Array.isArray(projected.versions)) setVersions(projected.versions)
  }, [projected])

  // The view is remounted on tab switches, but an in-flight HTTP response from
  // the previous session must never overwrite this one's state.
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const refresh = () => {
    setLoading(true)
    setError(null)
    timelineGet(`/versions?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (sessionRef.current !== sessionId) return
        if (!result || result.ok !== true) throw new Error(result?.error?.message ?? t('error.generic'))
        setVersions(result.value?.versions ?? [])
      })
      .catch((cause) => {
        if (sessionRef.current === sessionId) setError(cause?.message ?? t('error.generic'))
      })
      .finally(() => {
        if (sessionRef.current === sessionId) setLoading(false)
      })
  }

  const refreshGit = () => {
    if (getConfig().git !== true) return
    timelineGet(`/git/status?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (sessionRef.current === sessionId) setGit(result?.ok === true ? result.value : null)
      })
      .catch(() => {
        if (sessionRef.current === sessionId) setGit(null)
      })
  }

  // Mount-time load: projection push frames arrive live when the host mounts
  // the registry; HTTP is the on-demand fallback for minimal compositions.
  useEffect(() => {
    let cancelled = false
    setBadge('')
    if (projected === undefined) refresh()
    refreshGit()
    // Compression pre-check: flag turn-null markers that would break /compact.
    timelineGet(`/doctor?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (!cancelled) setDoctor(result?.ok === true ? result.value : null)
      })
      .catch(() => {
        if (!cancelled) setDoctor(null)
      })
    // Capability gates: read-only history is always available; restore paths
    // report themselves off until the repair plan re-enables them.
    timelineGet('/capabilities')
      .then((result) => {
        if (!cancelled) setCaps(result?.ok === true ? result.value : null)
      })
      .catch(() => {
        if (!cancelled) setCaps(null)
      })
    // Browsing must never write: the short code is display-only (it used to be
    // pinned into the session title on mount, which renamed sessions nobody
    // asked to rename).
    // 语义短码（2026-09-01）：host 短码表优先（工作区+序号），FNV 兜底
    callOp('sessionBadge', { sessionId }).then((result) => {
      if (!cancelled && result && result.ok === true && typeof result.value?.badge === 'string') {
        setBadge(result.value.badge)
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Jump: switch to the chat tab (tab-bar click — `actions?.setView?.()` is a
  // silent no-op for store-less third-party views), page up via the session
  // store until the anchor seq is loaded, then scroll the chat row into view.
  // The whole flow runs here because the view switch unmounts this view.
  const jump = (boundarySeq) => jumpToAnchor(store, boundarySeq)

  /** Scope → whether this build may run it (host re-checks; this is UX only). */
  const scopeAllowed = (value) => {
    if (caps === null) return true // unknown: let the host answer
    if (value === 'context') return caps.contextRestore === true
    if (value === 'artifacts') return caps.artifactRestore === true
    return caps.contextRestore === true && caps.artifactRestore === true
  }
  const restoreEnabled = scopeAllowed('context') || scopeAllowed('artifacts')

  const requestPreview = (record) => {
    setPreviewScope('both')
    setPreview({ versionId: record.versionId, kind: record.kind, boundarySeq: record.boundarySeq, data: null, error: null, outcome: null, planId: null })
    callOp('rollback/preview', { sessionId, versionId: record.versionId, scope: 'both' }).then((result) => {
      setPreview((prev) => prev && prev.versionId === record.versionId
        ? {
            ...prev,
            data: result?.ok === true ? result.value : null,
            error: result?.ok === true ? null : (result?.error?.message ?? t('error.generic')),
            planId: result?.ok === true ? (result.value?.planId ?? null) : null,
          }
        : prev)
    }).catch((cause) => {
      // 网络/HTTP 失败也要落到预览弹层的 error，否则弹层永远停在 loading。
      setPreview((prev) => prev && prev.versionId === record.versionId
        ? { ...prev, data: null, error: errorText(t, cause), planId: null }
        : prev)
    })
  }

  const confirmRollback = () => {
    if (!preview) return
    if (preview.data === null) return // never execute against a preview that has not loaded
    setRollbackBusy(true)
    callOp('rollback', { sessionId, versionId: preview.versionId, scope: previewScope, planId: preview.planId }).then((result) => {
      setRollbackBusy(false)
      if (!result || result.ok !== true) {
        setPreview((prev) => prev && { ...prev, error: errorText(t, result?.error) })
        return
      }
      const value = result.value ?? {}
      const failed = (value.artifacts ?? []).filter((row) => row.status === 'failed' || row.status === 'skipped')
      // A partially applied rollback is not a success: keep the dialog open so
      // the per-file result and any persistence warning stay visible.
      if (failed.length > 0 || value.flushWarning) {
        setPreview((prev) => prev && { ...prev, error: null, outcome: { failed, flushWarning: value.flushWarning ?? null } })
        if (projected === undefined) refresh()
        refreshGit()
        return
      }
      setPreview(null)
      if (value.undoId) {
        setUndoOffer({
          undoId: value.undoId,
          versionId: value.versionId ?? preview.versionId,
          // A 'both' rollback also rewound the conversation, which no undo can
          // put back: the toast must not claim otherwise.
          contextRolled: previewScope === 'context' || previewScope === 'both',
          expiresInMs: value.undoExpiresInMs ?? null,
        })
      }
      if (projected === undefined) refresh()
      refreshGit()
    }).catch((cause) => {
      // 失败必须复位 busy，否则确认按钮永久禁用。
      setRollbackBusy(false)
      setPreview((prev) => prev && { ...prev, error: errorText(t, cause) })
    })
  }

  /** Put back what the last artifact rollback overwrote (single use). */
  const runUndo = () => {
    if (!undoOffer) return
    setUndoBusy(true)
    callOp('rollback/undo', { sessionId, undoId: undoOffer.undoId }).then((result) => {
      setUndoBusy(false)
      if (!result || result.ok !== true) {
        const code = result?.error?.code
        const message = code === 'undo-expired' || code === 'undo-not-found'
          ? t('timeline.undoExpired')
          : errorText(t, result?.error)
        setUndoOffer((prev) => prev && { ...prev, error: message })
        return
      }
      const value = result.value ?? {}
      const failed = (value.artifacts ?? []).filter((row) => row.status === 'failed' || row.status === 'skipped')
      // A partial undo is not a success: keep the offer so the per-file result
      // and the retry path stay visible (the host keeps the ticket).
      if (failed.length > 0 || value.partial === true) {
        const detail = failed.map((row) => row.path).slice(0, 3).join(', ')
        setUndoOffer((prev) => prev && {
          ...prev,
          error: detail ? t('timeline.undoFailed', { message: detail }) : t('error.generic'),
        })
        if (projected === undefined) refresh()
        refreshGit()
        return
      }
      setUndoOffer(null)
      if (projected === undefined) refresh()
      refreshGit()
    }).catch((cause) => {
      setUndoBusy(false)
      setUndoOffer((prev) => prev && { ...prev, error: t('timeline.undoFailed', { message: errorText(t, cause) }) })
    })
  }

  const initGit = () => {
    if (!window.confirm(t('timeline.gitInitConfirm'))) return
    setGitBusy(true)
    callOp('git/init', { sessionId, confirm: true }).then((result) => {
      setGitBusy(false)
      // An HTTP 200 envelope may still carry `ok:false` (host-side failure);
      // silently refreshing hid every init failure.
      if (!result || result.ok !== true) throw new Error(result?.error?.message ?? t('error.generic'))
      refreshGit()
    }).catch((cause) => {
      setGitBusy(false)
      setError(errorText(t, cause))
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
      // 会话铭牌（2026-09-01）：所有界面统一展示短码，沟通任务用；
      // 短码异步到达，空串时不渲染「[]」占位（发布模式没有 harness 桥时尤其明显）。
      sessionId && badge !== '' && createElement('code', { key: 'badge', className: 'dsh-rt-fork-badge-code', title: t('fork.badgeHint') }, `[${badge}]`),
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
          restoreEnabled,
          onPreview: () => requestPreview(record),
          onTrajectory: () => switchToViewTab('trajectory'),
          onJump: () => jump(record.boundarySeq),
        })),
      ]),
    ]),

    // The undo toast sits above the modal layer: after a rollback the dialog is
    // gone, so this is the only affordance left for putting the files back.
    undoOffer && createElement('div', { key: 'undo', className: 'dsh-rt-undo', role: 'status' }, [
      createElement('span', { key: 'text', className: 'dsh-rt-undo-text' }, undoOffer.error
        ?? (undoOffer.contextRolled
          ? t('timeline.undoDonePartial', { version: undoOffer.versionId })
          : t('timeline.undoDone', { version: undoOffer.versionId }))),
      undoOffer.error
        ? createElement('button', { key: 'dismiss', type: 'button', className: 'dsh-rt-chip', onClick: () => setUndoOffer(null) }, t('timeline.undoDismiss'))
        : createElement('button', { key: 'undo', type: 'button', className: 'dsh-rt-chip', disabled: undoBusy, title: t('timeline.undoHint'), onClick: runUndo }, undoOffer.contextRolled ? t('timeline.undoActionArtifacts') : t('timeline.undoAction')),
      !undoOffer.error && createElement('button', {
        key: 'close',
        type: 'button',
        className: 'dsh-rt-chip dsh-rt-chip-icon',
        title: t('timeline.undoDismiss'),
        'aria-label': t('timeline.undoDismiss'),
        onClick: () => setUndoOffer(null),
      }, '✕'),
    ]),

    preview && createElement(PreviewBox, {
      key: 'preview',
      preview,
      scope: previewScope,
      setScope: setPreviewScope,
      busy: rollbackBusy,
      t,
      scopeAllowed,
      onConfirm: confirmRollback,
      onCancel: () => setPreview(null),
    }),
  ])
}

/** One version row (uniform height for the windowed list). */
function VersionRow({ record, top, t, restoreEnabled, onPreview, onTrajectory, onJump }) {
  const stamp = timeAbsolute(record.createdAt)
  return createElement('div', { className: 'dsh-rt-version', style: { top: `${top}px` }, title: `${record.versionId} · ${stamp}` }, [
    createElement('span', { key: 'kind', className: `dsh-rt-version-kind dsh-rt-version-kind-${record.kind}`, title: kindLabel(record.kind, t) }, KIND_ICONS[record.kind] ?? '•'),
    createElement('div', { key: 'body', className: 'dsh-rt-version-body' }, [
      createElement('div', { key: 'line1', className: 'dsh-rt-version-line' }, [
        createElement('span', { key: 'kind', className: 'dsh-rt-version-kind-label' }, kindLabel(record.kind, t)),
        // Relative time reads as "when in the conversation"; the exact stamp
        // lives in the tooltip so the row stays scannable.
        createElement('span', { key: 'time', className: 'dsh-rt-version-time', title: stamp }, timeRelative(record.createdAt, t)),
        createElement('span', { key: 'msgs', className: 'dsh-rt-version-msgs' }, t('timeline.messages', { count: record.messageCount })),
        createElement('span', { key: 'files', className: 'dsh-rt-version-files' }, fileCountLabel(record.fileCounts, t)),
      ]),
      record.markerText
        ? createElement('div', { key: 'text', className: 'dsh-rt-version-text' }, record.markerText.length > 120 ? `${record.markerText.slice(0, 120)}…` : record.markerText)
        : null,
    ]),
    createElement('span', { key: 'actions', className: 'dsh-rt-version-actions' }, [
      // Secondary actions are icon-only: three text chips on hover crowded the
      // row and made the destructive button easy to miss.
      createElement('button', {
        key: 'jump',
        type: 'button',
        className: 'dsh-rt-chip dsh-rt-chip-icon',
        onClick: onJump,
        title: t('timeline.jump'),
        'aria-label': t('timeline.jump'),
      }, '⌖'),
      createElement('button', {
        key: 'trajectory',
        type: 'button',
        className: 'dsh-rt-chip dsh-rt-chip-icon',
        onClick: onTrajectory,
        title: t('timeline.trajectory'),
        'aria-label': t('timeline.trajectory'),
      }, '☰'),
      createElement('button', { key: 'preview', type: 'button', className: 'dsh-rt-chip dsh-rt-chip-danger', disabled: !restoreEnabled, title: restoreEnabled ? t('timeline.previewDesc', { version: record.versionId, kind: kindLabel(record.kind, t) }) : t('timeline.restoreDisabled'), onClick: onPreview }, t('timeline.preview')),
    ]),
  ])
}

/** Rollback preview + confirm box (scope selector + artifact actions). */
function PreviewBox({ preview, scope, setScope, busy, t, onConfirm, onCancel, scopeAllowed }) {
  const data = preview.data
  const cancelRef = useRef(null)
  // 弹层是模态的：挂载时把焦点移到「取消」上（默认动作不是破坏性的确认），
  // 卸载时还给原元素，键盘/读屏用户不会掉回页面顶部。
  useEffect(() => {
    const previous = typeof document !== 'undefined' ? document.activeElement : null
    if (cancelRef.current && typeof cancelRef.current.focus === 'function') cancelRef.current.focus()
    return () => {
      if (previous && typeof previous.focus === 'function') previous.focus()
    }
  }, [])
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (!busy) onCancel()
  }
  // 工作区有未提交改动时，git 回退（git checkout -- <paths>）会静默覆盖它们。
  // 预览里明示并禁用确认；后端也会以 working-tree-dirty 拒绝执行。
  const dirty = data?.artifacts?.git?.dirty === true
  const blocked = !scopeAllowed(scope)
  // A preview that has not loaded (or failed) must never be executable, and the
  // host only accepts the single-use ticket the preview issued.
  const ready = data !== null && preview.error === null && Boolean(preview.planId)
  // A replacement marker hides messages, it cannot bring hidden ones back.
  const resurrect = data?.context?.resurrect ?? 0
  const notRestorable = data?.context?.restorable === false
  const scopes = [
    ['context', 'timeline.contextOnly', 'timeline.contextOnlyDesc'],
    ['artifacts', 'timeline.artifactsOnly', 'timeline.artifactsOnlyDesc'],
    ['both', 'timeline.both', 'timeline.bothDesc'],
  ]
  return createElement('div', {
    className: 'dsh-rt-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('timeline.preview'),
    tabIndex: -1,
    onKeyDown,
  }, [
    createElement('div', { key: 'title', className: 'dsh-rt-modal-title' }, [
      t('timeline.preview'),
      createElement('span', { key: 'ver', className: 'dsh-rt-modal-sub' }, t('timeline.previewDesc', { version: preview.versionId, kind: kindLabel(preview.kind, t) })),
    ]),
    preview.error && createElement('div', { key: 'err', className: 'dsh-rt-error' }, preview.error),
    preview.outcome?.flushWarning && createElement('div', { key: 'flush', className: 'dsh-rt-error' }, t('timeline.flushWarning', { message: preview.outcome.flushWarning })),
    preview.outcome && preview.outcome.failed.length > 0 && createElement('div', { key: 'partial', className: 'dsh-rt-error' }, t('timeline.partialFailures', { count: preview.outcome.failed.length })),
    preview.outcome && preview.outcome.failed.length > 0 && createElement('ul', { key: 'partial-files', className: 'dsh-rt-modal-files' }, preview.outcome.failed.slice(0, 12).map((row) =>
      createElement('li', { key: row.path }, [
        createElement('span', { key: 'a', className: `dsh-rt-art-${row.status}` }, row.status === 'failed' ? t('timeline.artifact.failed') : t('timeline.artifact.skip')),
        createElement('span', { key: 'p', className: 'dsh-rt-art-path' }, row.path),
      ]))),
    data === null && !preview.error && createElement('div', { key: 'wait', className: 'dsh-rt-timeline-empty' }, t('timeline.loading')),
    data && createElement('div', { key: 'body', className: 'dsh-rt-modal-body' }, [
      createElement('div', { key: 'ctx', className: 'dsh-rt-modal-line' },
        data.context?.messages > 0
          ? t('timeline.messagesRemoved', { count: data.context.messages })
          : t('timeline.noChanges')),
      createElement('div', { key: 'art', className: 'dsh-rt-modal-line' }, t('timeline.artifactsList', { count: data.artifacts?.rows?.length ?? 0 })),
      dirty && scope !== 'context' && createElement('div', { key: 'dirty', className: 'dsh-rt-error' }, t('timeline.gitDirtyWarn')),
      notRestorable && scope !== 'artifacts' && createElement('div', { key: 'resurrect', className: 'dsh-rt-error' }, t('timeline.resurrectWarn', { count: resurrect })),
      createElement('ul', { key: 'files', className: 'dsh-rt-modal-files' }, (data.artifacts?.rows ?? []).slice(0, 12).map((row) =>
        createElement('li', { key: row.path }, [
          createElement('span', { key: 'a', className: `dsh-rt-art-${row.action}` },
            row.action === 'skip' ? `${t('timeline.artifact.skip')} (${row.reason ?? ''})` : (row.action === 'delete' ? t('timeline.artifact.delete') : t('timeline.artifact.restore'))),
          createElement('span', { key: 'p', className: 'dsh-rt-art-path' }, row.path),
        ]))),
      createElement('div', { key: 'scope', className: 'dsh-rt-modal-scope' }, scopes.map(([value, labelKey, descKey]) => {
        const allowed = scopeAllowed(value)
        return createElement('label', { key: value, className: 'dsh-rt-option' }, [
          createElement('input', { type: 'radio', name: 'rt-scope', checked: scope === value, disabled: !allowed, onChange: () => setScope(value) }),
          createElement('span', { className: 'dsh-rt-option-text' }, [
            createElement('span', { className: 'dsh-rt-option-label' }, allowed ? t(labelKey) : `${t(labelKey)} — ${t('timeline.restoreScopeBlocked')}`),
            createElement('span', { className: 'dsh-rt-option-desc' }, t(descKey)),
          ]),
        ])
      })),
    ]),
    createElement('div', { key: 'buttons', className: 'dsh-rt-modal-buttons' }, [
      createElement('button', { key: 'cancel', ref: cancelRef, type: 'button', className: 'dsh-rt-editor-cancel', disabled: busy, onClick: onCancel }, t('timeline.cancel')),
      createElement('button', { key: 'confirm', type: 'button', className: 'dsh-rt-editor-send dsh-rt-confirm', disabled: busy || !ready || (dirty && scope !== 'context') || (notRestorable && scope !== 'artifacts') || blocked, onClick: onConfirm },
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

  // The view is remounted on tab switches, but an in-flight HTTP response from
  // the previous session must never overwrite this one's state.
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const refresh = () => {
    setLoading(true)
    setError(null)
    timelineGet(`/forkmap?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (sessionRef.current !== sessionId) return
        if (!result || result.ok !== true) throw new Error(result?.error?.message ?? t('error.generic'))
        setFork(result.value?.nodes ? result.value : null)
      })
      .catch((cause) => {
        if (sessionRef.current === sessionId) setError(cause?.message ?? t('error.generic'))
      })
      .finally(() => {
        if (sessionRef.current === sessionId) setLoading(false)
      })
  }

  // Mount-time load: push frames arrive live when the host mounts the
  // registry; HTTP is the on-demand fallback for minimal compositions.
  useEffect(() => {
    let cancelled = false
    setBadge('')
    if (projected === undefined) refresh()
    // Lineage chain (A4): read-only parent walk; shown as a header card.
    timelineGet(`/lineage?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (!cancelled && result && result.ok === true && Array.isArray(result.value)) setLineage(result.value)
      })
      .catch(() => { /* lineage is a best-effort enrichment */ })
    // 语义短码（2026-09-01）：host 短码表优先（工作区+序号），FNV 兜底。
    // 只读展示：浏览视图不再把短码写进标题（0.4.56 起标题只由用户操作改）。
    callOp('sessionBadge', { sessionId }).then((result) => {
      if (cancelled) return
      if (result && result.ok === true && typeof result.value?.badge === 'string') {
        setBadge(result.value.badge)
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

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
      badge !== '' && createElement('code', { key: 'code', className: 'dsh-rt-fork-badge-code' }, `[${badge}]`),
      createElement('span', { key: 'id', className: 'dsh-rt-fork-badge-id' }, sessionId),
      // 编辑名称（2026-09-01）：用户可自定义会话名；短码只做展示，不写进标题。
      createElement('button', {
        key: 'rename',
        type: 'button',
        className: 'dsh-rt-chip',
        onClick: () => {
          const name = window.prompt(t('fork.renamePrompt'), '')
          if (name && name.trim()) {
            const clean = name.trim().replace(/^\[[a-z0-9]{6,}\]\s*/i, '')
            if (store && typeof store.rename === 'function') {
              store.rename(clean).catch(() => callOp('setUserTitle', { sessionId, title: clean }).catch(() => {}))
            } else {
              callOp('setUserTitle', { sessionId, title: clean }).catch(() => {})
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
  }
  // Phase B — anchor shifts. Moving the clock · copy row left is itself a
  // layout write, so it lands before the measurement pass below; the writes
  // are collected first so reads never interleave with writes.
  const widthWrites = []
  for (const { row, anchor } of anchors) {
    const width = row.getBoundingClientRect().width
    if (width > 0) {
      const t = chatAnchorTransform(width)
      if (anchor.style.transform !== t) widthWrites.push([anchor, t])
    }
  }
  for (const [anchor, t] of widthWrites) anchor.style.transform = t
  // Phase C — one geometry read pass over rows and anchors. Coordinates keep
  // a 0.1px resolution: 0.01px precision only fed sub-pixel churn.
  const geo = []
  for (const { row, anchor } of anchors) {
    const prevShift = row._dshRtShift
    const own = row.getBoundingClientRect()
    if (own.width === 0 && own.height === 0) continue
    const target = anchor.getBoundingClientRect()
    const dy = Math.round((target.top + target.height / 2 - (own.top - (prevShift?.dy ?? 0) + own.height / 2)) * 10) / 10
    const dx = Math.round((target.right + CHAT_ACTION_GAP - (own.left - (prevShift?.dx ?? 0))) * 10) / 10
    geo.push({ row, dx, dy })
  }
  // Phase D — the write pass. Sub-pixel drift is ignored: the measured
  // midpoint wobbles by fractions of a pixel while text streams, and
  // re-applying that wobble as a transform on every observer tick is the
  // visible jitter. 0.5px is below what the eye can catch at chat sizes.
  const rowWrites = []
  for (const { row, dx, dy } of geo) {
    const prevShift = row._dshRtShift
    // Trust but verify: re-write when the shift moved past the dead zone, or
    // the cached shift matches but the inline transform was dropped.
    if (prevShift !== undefined
      && Math.abs(prevShift.dx - dx) < 0.5 && Math.abs(prevShift.dy - dy) < 0.5
      && row.style.transform === chatActionTransform(prevShift)) continue
    rowWrites.push([row, { dx, dy }])
  }
  for (const [row, shift] of rowWrites) {
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
    // Our own transform writes surface here as style records on elements we
    // tagged; re-scanning on them is the measure→write→observe feedback loop
    // that jitters the whole page while text streams.
    for (const record of records) {
      if (record.type === 'attributes' && record.attributeName === 'style'
        && record.target instanceof Element
        && (record.target._dshRtShift !== undefined || record.target._dshRtPrevTransform !== undefined)
        && (record.target.style.transform === '' || record.target.style.transform.startsWith('translate'))) continue
      if (isLayoutRelevant([record])) { schedule(); break }
    }
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
  const interval = setInterval(scan, 5000)
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
  imageDraftsApi = ctx.get('conversation')
  imageConversationApi = ctx.uiConversation
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

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'retrace-settings',
    order: 86,
    locale: NS,
    label: () => t('settings.tab'),
    inject: () => ({})
  }, RetraceSettings))
}


