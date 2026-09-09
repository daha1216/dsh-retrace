/**
 * dsh-retrace — lib/fold-summary.js
 *
 * 三段式窗口批2:确定摘要生成(非 LLM)——从折叠块事件提取结构化摘要。
 *
 * 规格依据(三段式窗口管理-设计规格-20260909 §二/A2 + 附节外部反馈):
 * - 确定摘要 = 结构化提取,模板固定,同输入同输出(非 LLM 波动);
 * - 字段:时间戳/轮次范围/结论字段(动作序列+产物)/备份路径(展开定位 = seq 区间);
 * - 增量归档:摘要进 marker content(替代折叠块进模型上下文),日志完整可展开;
 * - 用户原文:尾输入逐字保留(续聊锚点);全量原文靠展开(日志 append-only)。
 *
 * 纯函数零依赖(可测);从通用事件提取,与平台无关。
 */

/** 从文本内容块提取可见文本。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** 格式化 epoch ms → YYYY-MM-DD HH:MM(本地)。固定格式保证确定性。 */
function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '?'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 从折叠块事件生成确定摘要(纯函数)。
 * @param {Array} events - 折叠块区间内的全量事件(含 turn/step/消息/tool;seq 需连续完整,
 *   或调用方从全量日志切片 [startSeq..endSeq] 含边界事件)。
 * @param {{start:number, end:number}} range - 折叠块 seq 区间。
 * @returns {string} 固定模板摘要文本。
 */
export function buildFoldSummary(events, range = {}) {
  const start = Number(range?.start)
  const end = Number(range?.end)
  const users = []
  const actions = []
  const seenActions = new Set()
  const times = []
  let toolResults = 0
  for (const ev of events) {
    if (!ev) continue
    const t = ev.time
    if (Number.isFinite(t) && t > 0) times.push(t)
    const type = ev.type
    if (type === 'user/message' && ev.data?.source?.kind === 'user') {
      const text = textOf(ev.data?.content).trim()
      if (text) users.push(text)
    } else if (type === 'tool/call') {
      const args = typeof ev.data?.arguments === 'string' ? JSON.parse(ev.data.arguments) : ev.data?.arguments
      const command = typeof args?.command === 'string' ? args.command.trim() : ''
      if (command) {
        const key = command
        if (!seenActions.has(key)) {
          seenActions.add(key)
          actions.push(command)
        }
      }
    } else if (type === 'tool/result') {
      toolResults += 1
    }
  }
  const timeLo = times.length ? fmtTime(Math.min(...times)) : '?'
  const timeHi = times.length ? fmtTime(Math.max(...times)) : '?'
  const tailInput = users.length ? users[users.length - 1] : ''
  const actionLine = actions.length > 0
    ? actions.slice(0, 12).join('; ') + (actions.length > 12 ? `; …(+${actions.length - 12})` : '')
    : '(无工具调用)'
  // 固定模板(确定性:同输入同输出)
  const lines = [
    '【完成块 · 已折叠】',
    `时间: ${timeLo} ~ ${timeHi}`,
    `区间: seq ${Number.isInteger(start) ? start : '?'}..${Number.isInteger(end) ? end : '?'}(日志完整,展开可回填)`,
    `轮次: ${users.length} 条用户输入`,
    `动作: ${actionLine}`,
    `工具结果: ${toolResults} 次`,
  ]
  if (tailInput) {
    lines.push(`尾输入: "${tailInput.length > 400 ? tailInput.slice(0, 400) + '…' : tailInput}"`)
  }
  return lines.join('\n')
}
