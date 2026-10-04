// 字幕「最终落地的语言类型」——从**内容**判，不从文件名。文件名的简/繁/英标记不可信，中文剧名
// 的搜刮结果压根没有标记（`进击的巨人 (01).ass`），只有内容能说清这条字幕放出来是中文还是英文、
// 简体还是繁體。判据朴素：数 CJK / 拉丁词 / 繁体独有字，够用于「挑一条中文字幕」这个兜底诉求。

export type SubLangKind = 'simp' | 'trad' | 'eng' | 'simp-eng' | 'trad-eng' | 'unknown'

/** 繁体独有字（各自的简体是另一个字形）。命中即判繁——简体正文里不会出现这些。
 *  取高频常用的一批就够把繁体压制组的字幕挑出来，不求穷尽。 */
const TRAD_ONLY =
  '們這說時對沒後來國會過進學樣麼現實應該頭買賣讓動錢東見覺話麗愛廠關開門問間陽陰隊階際隨險嗎媽罵嗎當黨屬歲豐點瘋'
/** 简体独有字（对应繁体是另一字形）。用来在简繁都少时给个方向。 */
const SIMP_ONLY =
  '们这说时对没后来国会过进学样么现实应该头买卖让动钱东见觉话丽爱厂关开门问间阳阴队阶际随险吗妈骂当党属岁丰点疯'

/** 判一段（VTT 化后的）字幕文本的语言类型。 */
export function detectSubtitleLang(vttText: string): SubLangKind {
  // 只看正文：剥掉 WEBVTT 头、时间轴行、纯序号行——它们带数字/箭头，会污染拉丁词统计。
  const body = vttText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() && l !== 'WEBVTT' && !l.includes('-->') && !/^\d+$/.test(l.trim()))
    .join('\n')

  const cjk = (body.match(/[一-鿿]/g) ?? []).length
  const engLetters = (body.match(/[A-Za-z]/g) ?? []).length
  const engWords = (body.match(/[A-Za-z]{2,}/g) ?? []).length

  const hasCjk = cjk >= 8 // 少数几个汉字可能是 staff 表/水印，抬高门槛防误判

  if (!hasCjk) {
    // 没有中文：够多的英文词才算英文轨（真英文轨成百上千个词），否则判不出。
    return engWords >= 12 ? 'eng' : 'unknown'
  }

  // 有中文。双语要求英文**占比可观**（≥CJK 的四分之一）——绝对门槛会把中文里零星的英文借词
  // （OK / WiFi / 片头 staff 名）误判成双语；双语轨里近半的行是英文，比例判据才稳。
  const bilingual = engLetters >= 8 && engLetters >= cjk * 0.25
  const isTrad = countAny(body, TRAD_ONLY) > countAny(body, SIMP_ONLY) // 繁体独有字更多 → 繁；否则简
  if (bilingual) return isTrad ? 'trad-eng' : 'simp-eng'
  return isTrad ? 'trad' : 'simp'
}

/** VTT 里到底有没有对白——一条时间轴（`-->`）后面跟着非空文本行才算。迅雷偶尔返回只含内嵌
 *  字体、没有 `[Events]` 的空壳 .ass，转出来是「WEBVTT\n\n」空文件，播放器选中它就是「没加载」。
 *  列表阶段抓内容探测语言时顺手用它把这种死轨滤掉。 */
export function vttHasCues(vttText: string): boolean {
  const lines = vttText.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('-->') && (lines[i + 1]?.trim() ?? '') !== '') return true
  }
  return false
}

/** 弹幕伪装成 .ass：B站/播放器把弹幕导成 ass，每条 Dialogue 用 `\move`（从右往左滚）或 `\pos`
 *  （定位）动画标签在画面上飞，不是字幕。assToVtt 剥掉标签后只剩满屏评论文本，当字幕显示就是乱码。
 *  判据：大量 Dialogue 行带 `\move`。活体量过——弹幕 91% 带 `\move`，真字幕 0%（进击的巨人
 *  S01E02 vs S04E28），阈值放 0.3 一刀两断、不误伤偶用 `\pos` 做 OP/ED 特效的正常字幕。 */
export function isLikelyDanmaku(text: string): boolean {
  const dialogues = text.split(/\r?\n/).filter((l) => /^Dialogue:/i.test(l))
  if (dialogues.length < 30) return false // 太少不判：正常短字幕也可能偶用定位
  const moving = dialogues.filter((l) => l.includes('\\move(')).length
  return moving / dialogues.length > 0.3
}

function countAny(text: string, charset: string): number {
  let n = 0
  for (const ch of text) if (charset.includes(ch)) n++
  return n
}

/** 语言类型 → 菜单里显示的中文标签。 */
export function langDisplayName(kind: SubLangKind): string {
  switch (kind) {
    case 'simp':
      return '简体中文'
    case 'trad':
      return '繁體中文'
    case 'eng':
      return '英文'
    case 'simp-eng':
      return '简体中英'
    case 'trad-eng':
      return '繁體中英'
    case 'unknown':
      return '未知'
  }
}

/** 播放器 track 的粗粒度 lang 属性（BCP-ish：中文一律 chi，英文 eng）。 */
export function langCode(kind: SubLangKind): string | undefined {
  if (kind === 'eng') return 'eng'
  if (kind === 'unknown') return undefined
  return 'chi'
}
