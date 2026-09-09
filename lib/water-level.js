/**
 * dsh-retrace — lib/water-level.js
 *
 * 三段式窗口批4:会话水位测量 + 折叠处置建议(与三段式折叠集成)。
 *
 * 规格依据(会话水位体检与处置-设计规格 v1 + 三段式 §三/四 + 附一):
 * - 中文校正口径:ASCII ≈ chars/4,BMP 中文 ≈ chars×0.94(经验系数,D5 实测),
 *   混合分段加权;输出标"校正估算(系数 0.94,可配)",不冒充精确;
 * - 档位:🟢<60% 健康 / 🟡60-85% 黄线(该主动折叠)/ 🔴>85% 硬红(0.8 前必须已折);
 * - 处置建议 = 给正解:折叠哪个完成块 + 收益(shadowedTokenCount 估算),全中文;
 * - 折叠候选 = 中部最老完成块(头部之后首个 completed 轮,fold-boundary rounds=1,
 *   默认单轮;多轮编组由调用方扩展);
 * - 红线 0.8×窗口前必须已主动折叠(官方 head-anchored 会折头部=缓存全断)。
 *
 * 纯函数零依赖(可测);事件从文件读(调用方 adapter)。
 */

/** 上下文窗口默认(与官方 compaction-basic 一致的 1M)。 */
export const DEFAULT_WINDOW = 1048576
/** 中文经验系数(字符→token,D5 实测,非精确)。 */
export const DEFAULT_CJK_RATE = 0.94
/** ASCII 系数(官方 chars/4)。 */
export const ASCII_RATE = 0.25
/** 黄线起点(0.6×窗口 = 该准备主动折叠)。 */
export const YELLOW_RATIO = 0.6
/** 红线(0.8×窗口前必须已折;官方自动压缩阈值 0.8)。 */
export const RED_RATIO = 0.8
/** 硬红报警(0.9,check 规则用)。 */
export const HARD_RED_RATIO = 0.9

/** 判断 BMP 中文/CJK 字符(含扩展区高位代理对需单独处理;基础面够用)。 */
function isCjk(ch) {
  const c = ch.charCodeAt(0)
  return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)
}

/** 文本按 CJK/非 CJK 分段加权估算 token(中文 ×0.94,其他 ×0.25)。 */
export function estimateMixedTokens(text, cjkRate = DEFAULT_CJK_RATE) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (isCjk(ch)) cjk += 1
    else other += 1
  }
  return Math.round(cjk * cjkRate + other * ASCII_RATE)
}

/** 消息可见文本(user/assistant)。 */
function messageText(ev) {
  if (!ev) return ''
  if (ev.type === 'user/message') {
    return Array.isArray(ev.data?.content)
      ? ev.data.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : ''
  }
  if (ev.type === 'assistant/message') {
    return Array.isArray(ev.data?.message?.content)
      ? ev.data.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : ''
  }
  return ''
}

/**
 * 测量会话水位(中文校正口径)。
 * @param {Array} events - 全量事件。
 * @param {{window?:number, cjkRate?:number, surfaceOnly?:boolean}} [opts]
 * @returns {{officialTokens:number, cjkTokens:number, remaining:number, pct:number,
 *   band:'green'|'yellow'|'red', window:number}}
 *   surfaceOnly=false(默认全量消息估算——水位看模型上下文,surface 节点文本足够,
 *   但简化先全量消息;批4 基础版全量,精确 surface 后补)。
 */
export function measureWaterLevel(events, opts = {}) {
  const window = Number.isFinite(opts.window) && opts.window > 0 ? opts.window : DEFAULT_WINDOW
  const cjkRate = Number.isFinite(opts.cjkRate) && opts.cjkRate > 0 ? opts.cjkRate : DEFAULT_CJK_RATE
  let cjkTokens = 0
  let officialTokens = 0
  if (Array.isArray(events)) {
    for (const ev of events) {
      const text = messageText(ev)
      if (!text) continue
      cjkTokens += estimateMixedTokens(text, cjkRate)
      officialTokens += Math.round(text.length * ASCII_RATE) // 官方 ≈ chars/4
    }
  }
  const pct = window > 0 ? cjkTokens / window : 0
  const band = pct >= RED_RATIO ? 'red' : pct >= YELLOW_RATIO ? 'yellow' : 'green'
  return {
    officialTokens,
    cjkTokens,
    remaining: Math.max(0, window - cjkTokens),
    pct,
    band,
    window,
  }
}

/** 估算某 seq 区间的消息 token(折叠收益用)。 */
export function estimateRangeTokens(events, shadowedSeqs, cjkRate = DEFAULT_CJK_RATE) {
  if (!Array.isArray(events) || !Array.isArray(shadowedSeqs)) return 0
  const bySeq = new Map(events.map((e) => [e?.seq, e]))
  let total = 0
  for (const seq of shadowedSeqs) {
    const ev = bySeq.get(seq)
    const text = messageText(ev)
    if (text) total += estimateMixedTokens(text, cjkRate)
  }
  return total
}
