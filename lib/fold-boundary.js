/**
 * dsh-retrace — lib/fold-boundary.js
 *
 * 三段式窗口批3:折叠块边界裁定(位置轴基础版)。
 *
 * 规格(三段式 §二/A1 + 附一):
 * - 块边界 = 语义完成(轮 reason.kind=completed 天然单位;多轮交付 = 显式编组 = 调用方给 endSeq)
 *   为主 + **固定轮数上限兜底**(MAX_ROUNDS=50:超长任务强制切,防边界漂移);
 * - 折叠 end 必须是 surface 节点(官方 replace 位置段要求);
 * - 价值分层(附二,迭代方向):位置轴基础版;fold marker 的 editor.fold 字段可扩展保真级别口子。
 *
 * 纯函数零依赖(可测);从通用事件提取。
 */

/** 单块最多 50 轮(超长任务强制切,防边界漂移)。 */
export const FOLD_MAX_ROUNDS = 50

/** user 输入(真实用户,非注入 context)。 */
function isUserInput(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/** surface 节点候选(官方 foldSurface 只折叠这些)。 */
function isSurfaceNode(event) {
  return event?.type === 'user/message' || event?.type === 'assistant/message' || event?.type === 'tool/result'
}

/**
 * 从某起始点裁定折叠块边界(位置轴基础版)。
 * @param {Array} events - 全量事件(按 seq 序)。
 * @param {number} startSeq - 折叠起始点(任意节点 seq;回退到其所在轮首 user)。
 * @param {{rounds?:number, maxRounds?:number}} [opts] - rounds=折叠轮数(默认 1 = 单轮
 *   语义完成块;多轮交付 = 调用方给 rounds/endSeq),maxRounds=兜底上限(50)。
 * @returns {{start:number, end:number, rounds:number, reason:'completed'|'max-rounds'|'tail'}|null}
 *   start = 轮首 user seq;end = 第 N 轮(≤maxRounds)轮尾的 surface 节点;
 *   rounds = 折叠轮数;reason = 结束原因。无 user 输入返回 null。
 */
export function foldBoundaryFrom(events, startSeq, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return null
  const want = Number.isInteger(opts.rounds) && opts.rounds > 0 ? opts.rounds : 1
  const maxRounds = Number.isInteger(opts.maxRounds) && opts.maxRounds > 0 ? opts.maxRounds : FOLD_MAX_ROUNDS
  const foldRounds = Math.min(want, maxRounds) // 上限兜底
  // 1) 全部 user 输入位置
  const userIdx = []
  for (let i = 0; i < events.length; i++) {
    if (events[i] && isUserInput(events[i])) userIdx.push(i)
  }
  if (userIdx.length === 0) return null
  // 2) 起始点所在轮(最后一个 userIdx ≤ startSeq)
  let roundStart = -1
  let startPos = -1
  for (let p = 0; p < userIdx.length; p++) {
    if (userIdx[p] <= startSeq) { roundStart = userIdx[p]; startPos = p } else break
  }
  if (roundStart === -1 || startPos === -1) return null
  // 3) 折叠轮数:起始轮起 foldRounds 轮(≤maxRounds 兜底)
  const lastPos = Math.min(startPos + foldRounds - 1, userIdx.length - 1)
  const nextUser = userIdx[lastPos + 1]
  const rawEnd = nextUser !== undefined ? nextUser - 1 : events.length - 1
  // 4) end 回退到 surface 节点(轮尾可能是 step/end/turn/end 等非 surface)
  let end = rawEnd
  while (end > roundStart && !isSurfaceNode(events[end])) end -= 1
  if (end < roundStart) return null
  const rounds = lastPos - startPos + 1
  const reason = nextUser === undefined ? 'tail' : (rounds >= maxRounds && want >= maxRounds ? 'max-rounds' : 'completed')
  return { start: roundStart, end, rounds, reason }
}
