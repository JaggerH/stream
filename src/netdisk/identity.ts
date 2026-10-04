// 共享认集层（spec 2026-07-25-shared-episode-identity）：文件名 → 集身份。
// 通用清洗内建（不含任何节目名），本剧规则（titleStrip/epNumRegex）作参数——来自绑定的
// MatchSpec 数据（见 match-spec.ts identityRulesFromSpec）。消费者：match-spec.ts 的常量、
// 归档器 buildPlan 的分组键。前身是 reconcile/identity.ts（节目专名曾硬编码在此，已废）。

/**
 * 音频+视频扩展名并集。两个用处：剥扩展名拿干净标题；**判"这是不是一个媒体文件"**——整理的扫描层
 * 用它把字幕/封面/说明档挡在流水线外（`reconcile/service.ts` scanFiles）。所以往里加扩展名要当心：
 * 加错了不只是标题多剥一截，是让一类文件进池被搬被删；漏了则是一类真媒体文件被整理无视。
 */
export const EXT = /\.(mp3|m4a|ogg|flac|wav|aac|opus|wma|ape|mkv|mp4|ts|m2ts|avi|mov|m4v|wmv|flv|webm|iso)$/i
const WATERMARK = /【[^】]*】/g
const PAREN_NOISE = /[\[（(]\s*(公众号|微信|整理|免费分享)[^\])）]*[\])）]/g
/**
 * 与旧 reconcile PUNCT 逐字相同——decisions 表的豁免 key 由它决定，动一个字符 key 就漂。
 *
 * 导出是给 `match-spec.ts` 的比较形（`tidy`）用：两处问的是同一个问题「标点不算内容差异」，
 * 各写一份的表现是归档器认得出同一集、匹配器认不出（活体星卡梦少女：TMDb 写
 * `桃子小芸，友情危机！（上）`、文件写 `桃子小芸 友情危机 上`，相似度被标点压到阈值以下）。
 */
export const PUNCT = /[\s.,，!！?？、:：;；()（）《》"'\-—_]/g

export interface IdentityRules { titleStrip: string[]; epNumRegex: string }
export interface EpisodeIdentity { key: string; num: number | null }

/**
 * makeIdentity 提取集号前跑的那一段清洗（basename → 扩展名 → 水印 → 括号噪音 → trim →
 * 调用方 titleStrip）单拎出来给要「按本 show 规则拿到干净标题」的调用方复用——凡是要跟集标题
 * 比对的地方都得吃同一份 per-show 规则，不能一个走这里、一个走前端 displayTitle 的通用启发式
 * （spec 2026-07-25 shared-episode-identity 的教训）。**不剥标点、不小写**——那是 makeIdentity
 * 为了"生成稳定 key"多做的一步；这里保留原始标点/大小写，由调用方按自己的口径处理。
 */
export function makeTitleClean(rules: { titleStrip: string[] }): (name: string) => string {
  const strips = rules.titleStrip.map((s) => new RegExp(s))
  return (name) => {
    let s = (name.split('/').pop() ?? name).replace(EXT, '')
    s = s.replace(WATERMARK, '').replace(PAREN_NOISE, '').trim()
    for (const re of strips) s = s.replace(re, '')
    return s
  }
}

export function makeIdentity(rules: IdentityRules): (name: string) => EpisodeIdentity {
  const clean = makeTitleClean(rules)
  const numRe = new RegExp(rules.epNumRegex)
  return (name) => {
    let s = clean(name)
    const m = numRe.exec(s)
    s = s.replace(/[楽樂]/g, '乐').replace(PUNCT, '').toLowerCase()
    return { key: s, num: m ? Number(m[1]) : null }
  }
}
