import type { Normalizer } from '../../src/content/normalize.ts'
import type { Media } from '../../src/content/types.ts'

/**
 * Telegram 资源频道的一条消息 → 一张链接卡。
 *
 * **上游给的是一坨**：桌面采集经 a11y 树只能读到控件的 `name`，一条消息的 `name` 就是整段正文
 * 挤成的一行字。顶层字段（`title`/`link`）由 recipe 的 `map` 抽（见 `desktop-recipe.ts` 的
 * `DesktopMap`——**前端各处显示的是顶层 `item.title`**，在这里再抽一次是白抽）；这一层只负责
 * 把同一段正文整理成能看的样子：网盘链接列成卡片、正文只留描述、把体量/标签这些边角料摘掉。
 *
 * 资源频道的消息形态高度一致（活体样本，2026-08-03「夸克云盘影视资源频道」）：
 *
 * ```
 * 夸克云盘影视资源频道
 * 图片, 853×1280
 * 名称：野狗骨头（2026）4K 更至EP12
 *
 * 描述：改编自休屠城同名小说…
 *
 * 夸克：https://pan.quark.cn/s/aacab8de665b
 *
 * 📁 大小：2.5G/集
 * 🏷 标签：#野狗骨头 #宋威龙 #剧情
 * 已收到   20:27 904 浏览次数
 * ```
 *
 * 但**不能假定它一定是这个形态**：同一个频道里混着广告条（只有一行「广告: …」）、频道互推、
 * 纯转发。抽不到就不写那个字段，绝不拿正文头一行冒充标题——那正是"看起来对、其实全错"的那类
 * 输出（`feedback_verify_title_dont_infer_from_tagline`）。
 */

/** 网盘链接 → 人话标签。键是域名片段，按第一个命中取。 */
const NETDISK_LABEL: Array<[RegExp, string]> = [
  [/pan\.quark\.cn/i, '夸克网盘'],
  [/pan\.baidu\.com/i, '百度网盘'],
  [/(www\.)?alipan\.com|aliyundrive\.com/i, '阿里云盘'],
  [/cloud\.189\.cn/i, '天翼云盘'],
  [/drive\.uc\.cn/i, 'UC网盘'],
  [/115\.com/i, '115网盘'],
  [/(www\.)?123pan\.com/i, '123网盘'],
  [/caiyun\.139\.com/i, '移动云盘'],
  [/pan\.xunlei\.com/i, '迅雷云盘'],
  [/mypikpak\.com/i, 'PikPak'],
]

/** 一条消息里出现的所有 http(s) 链接，按出现顺序、去重。 */
function urlsIn(text: string): string[] {
  // 末尾的中英标点不属于 URL——正文里链接常常紧跟着一个句号或右括号
  const raw = text.match(/https?:\/\/[^\s]+/g) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of raw) {
    const clean = u.replace(/[.。，,；;、）)】\]]+$/, '')
    if (seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/** 提取码：「提取码：1111」「密码: abcd」都算，取整条消息里第一个。 */
function extractCode(text: string): string | undefined {
  return text.match(/(?:提取码|密码|访问码)\s*[:：]\s*([0-9a-zA-Z]{3,8})/)?.[1]
}

/** 「描述：…」那一段。到空行或正文结束为止。 */
function description(text: string): string | undefined {
  return text.match(/描述：([\s\S]*?)(?:\n\n|$)/)?.[1]?.trim() || undefined
}

export const telegramNormalizer: Normalizer = (raw) => {
  // 整段正文落在 `content` 上，不是随便挑的名字：搜索那条路（`video/content/` 的解析器层）
  // 按 **item 形状**自动认领，而它认的是 `content` 里有没有下载链接——叫别的名字，digest
  // 解析器就一条都认不出，搜索结果会退化成"只有标题、没有网盘链接"。同一段正文两个消费者
  // （收件箱 presenter + 搜索解析器），字段名必须是它俩都认的那一个。
  const text = String(raw.content ?? raw.description ?? '')
  const code = extractCode(text)
  const media: Media[] = urlsIn(text).map((url) => {
    const label = NETDISK_LABEL.find(([re]) => re.test(url))?.[1]
    // 认不出的域名不瞎安一个"网盘"的名头——它可能是频道互推、投稿页、外链视频
    const title = label ? (code ? `${label} · 提取码 ${code}` : label) : url
    return { kind: 'link', url, title }
  })
  const desc = description(text)
  return {
    archetype: 'link',
    // title 只认 recipe 抽好的那个（顶层字段的唯一来源）；这里不另抽一份，免得两处漂移
    title: raw.title ? String(raw.title) : undefined,
    // 描述抽得到就只留描述——原文尾巴上挂着"已收到 / 904 浏览次数 / 回应: ❤"，那是客户端 UI
    // 的读数，不是内容。抽不到（广告条、纯转发）就退回原文，别把这条消息变成一张空卡。
    text: desc ?? text,
    media,
  }
}
