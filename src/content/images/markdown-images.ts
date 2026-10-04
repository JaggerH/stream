/** 正文 markdown 里图片的读与写。
 *
 *  为什么统一在 markdown 上做：`article` 分支有两档抓取（Defuddle 产 HTML、Firecrawl 原生产
 *  markdown）。两种载体各写一遍图片解析是纯重复，所以分支的产出统一成 markdown，
 *  这里只认 `![alt](url)` 一种形态。 */

export interface MarkdownImage {
  alt: string
  url: string
}

/** 图片语法：行内 `![alt](url)`，可带一个可选的 `"title"`。url 允许**一层**成对括号
 *  （CommonMark 本身允许 url 里出现平衡括号，例如维基百科的 `Foo_(disambiguation).jpg`）——
 *  url 由「非括号非空白字符」或「一对平衡括号包住的非括号非空白字符」交替构成；
 *  两层及以上嵌套括号、未配对括号、空白仍然不支持，也不支持 `<...>` 包裹或转义右括号的写法。 */
const IMAGE_RE = /!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g

export function listMarkdownImages(markdown: string): MarkdownImage[] {
  const out: MarkdownImage[] = []
  for (const m of markdown.matchAll(IMAGE_RE)) out.push({ alt: m[1], url: m[2] })
  return out
}

/** 把批注插在图片所在**那一行的行尾**，原图保留。
 *
 *  为什么不插在正则匹配结束处（旧实现的做法）：一张图的匹配结束处可能在一行的中间——
 *  行内图后面还跟着正文，或者图片本身是嵌套链接 `[![logo](u)](link)` 的一部分。在那里
 *  硬插入 `\n> ...` 会把后面的正文吞进引用块、或把外层链接语法从中间劈开。批注永远不能
 *  让 markdown 比原来更差，所以统一挪到行尾——不管图片在行首、行中还是被链接包着。
 *
 *  `notes` 按**出现位置**对位，不按 URL 去重——同一张图在文中出现两次是两个独立位置，
 *  各自的上下文不同，硬合并会把第二处的批注吞掉。同一行有多张图时，各自的批注按
 *  出现顺序攒到该行行尾，顺序不能乱——这是 notes 按位置对位这条契约的直接推论。 */
export function annotateMarkdownImages(markdown: string, notes: Array<string | null>): string {
  const notesByLine = new Map<number, string[]>()
  let i = 0
  let hasAny = false
  for (const m of markdown.matchAll(IMAGE_RE)) {
    const note = notes[i++]
    if (!note) continue
    hasAny = true
    // 多行 OCR 结果**每一行**都要带引用前缀：只给第一行加，第二行就脱离了引用块，
    // 读起来像是正文自己的一段，分不清哪些字是图里的。
    const quoted = note.split('\n').map((line) => `> ${line}`).join('\n')
    // 用匹配**结束位置**算行号，不能用起点：alt 部分 `[^\]]*` 和 title 前的 `\s+`
    // 都能吃换行，匹配本身可以跨行。按起点算会把"起点所在行"落在图片语法内部，
    // 批注插进去就把 `![...]` 劈成两半——参见本文件同名测试。
    const lineIdx = countNewlinesBefore(markdown, m.index + m[0].length)
    const forLine = notesByLine.get(lineIdx)
    if (forLine) forLine.push(quoted)
    else notesByLine.set(lineIdx, [quoted])
  }
  if (!hasAny) return markdown

  return markdown
    .split('\n')
    .map((line, idx) => {
      const forLine = notesByLine.get(idx)
      return forLine ? [line, ...forLine].join('\n') : line
    })
    .join('\n')
}

function countNewlinesBefore(text: string, index: number): number {
  return text.slice(0, index).split('\n').length - 1
}
