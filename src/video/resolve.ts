/**
 * 「下载中转页引用 → 下载项」的机制。**源码不认识任何下载站**：哪些 URL 是中转页、解开后是什么
 * 类型，由各站的包声明（`package.json#stream.links.patterns` 里 kind `download-page` 那几条，
 * 带 `yields`；装载期校验见 `src/packages/links.ts` 的 `linkPatternProblem`），经认领函数
 * `recognizeLinkSync`（`src/links/recognize.ts`）查。
 *
 * 搜索源常给的不是能直接用的下载链接，而是它自己站上的一个中转页（一季 100+ 行，每行一个页面——
 * 上来就逐条解析是 100+ 次抓取，所以按需解析单行）。这里回答两个必须一起答的问题：
 *
 *  - `downloadPageKind(url)`：这个 URL 是不是某站的中转页、解开后会是什么类型？
 *    ——解析器（paired.ts）用它给行打 `needsResolve` 标；
 *  - `resolveDownloads(url)`：真的去解开它，回 DownloadOption[]。
 *    ——download-resolve Provider 行的下载页成员就是它。
 *
 * **两个函数吃同一个认领结果**：分家漂移的症状是前端给出「解析」按钮而后端 400 拒（或反过来：
 * 能解析的行没有按钮），两边单看都正常。加一个下载站 = 那个站的包在 `links.patterns` 加一行，
 * 不碰解析器、不碰端点、不碰这里。
 *
 * **download-page 兼作 SSRF 白名单**：`resolveDownloads` 只抓命中某条 download-page 的 URL，而每条
 * 在装载期已被要求整串锚定（`^https…$`）、主机段只指名本包声明过的字面域名、没有越界通配。
 */
import type { NetdiskKind } from './content/types.ts'
import { recognizeLinkSync } from '../links/recognize.ts'
import type { DownloadYield } from '../packages/links.ts'

/** download-resolve Provider 行的成员返回契约（行级文档见
 *  `src/providers/system/download-resolve.ts`）。`type` 对齐 SourceType 联合 + 'http'
 *  （普通直链）。 */
export interface DownloadOption {
  url: string
  type: 'magnet' | 'ed2k' | 'quark' | 'baidu' | 'aliyun' | 'http'
  password?: string
  name?: string
}

/** 这条 URL 命中的 download-page 声明解开后是什么；不是中转页 → null。 */
function claimOf(url: string): DownloadYield | null {
  const r = recognizeLinkSync(url)
  return r?.kind === 'download-page' ? (r.yields ?? 'unknown') : null
}

/**
 * 这个 URL 是不是已知下载站的中转页？是 → 解开后的类型（'unknown' = 是中转页但类型要
 * 解开才知道，如网盘中转页）；不是 → null。
 */
export function downloadPageKind(url: string): NetdiskKind | null {
  return claimOf(url)
}

/**
 * 解开一个中转页。抛 'unsupported url' = 没有包认领它是中转页，或它的类型还没有通用解法
 * （Provider 行语义：decline，梯子落到下一档成员；端点报 400）。今天只有 `magnet` 有通用解法：
 * 抓页面、取第一条 `magnet:` 链接。
 */
export async function resolveDownloads(url: string): Promise<DownloadOption[]> {
  if (claimOf(url) !== 'magnet') throw new Error('unsupported url')
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  const html = await res.text()
  const m = html.match(/magnet:\?[^"'\s<]+/)
  if (!m) throw new Error('no magnet found')
  return [{ url: m[0], type: 'magnet' }]
}
