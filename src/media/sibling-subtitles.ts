// 网盘同目录外挂字幕（sibling .srt/.ass/.ssa/.vtt）：发现 + 转 WebVTT。纯函数、零网络——
// 谁的文件列表、字节从哪来是路由层的事（netdisk-subtitle-list / netdisk-subtitle）。
//
// 为什么 srt/ass 都手写转换、不喂 ffmpeg（TODO 原方案建议 ass 走 ffmpeg 通道）：中文压制组的
// 外挂字幕常见 GBK/GB18030 编码，ffmpeg 按 UTF-8 读会整片乱码且不报错；手写转换让编码回退
// （decodeSubtitleText）先行，顺带免掉这条路径对 ffmpeg 的依赖。样式取舍与内嵌轨抽取一致：
// 只保文本+时间轴（spec 2026-07-22-netdisk-subtitle-audio-extraction-design §4）。

/** 一条发现的外挂字幕。`id` 是并轨后的 track 标识（`file:<相对路径>`，与内嵌轨的
 *  `embed:<streamIndex>` 同一命名空间），前端只透传不解析。 */
export interface SiblingSubtitle {
  id: string
  lang?: string
  title: string
}

const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt)$/i
/** 大于这个尺寸的"字幕"当垃圾跳过（真字幕几十 KB 量级；防错标的视频/压缩包混进来）。 */
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024

/** 语言后缀 → (lang, 显示名)。后缀取 basename 去掉视频 stem 与扩展名、再剥分隔符后的剩余。 */
function langOf(suffix: string): { lang?: string; title: string } {
  const s = suffix.toLowerCase()
  if (/^(chs|sc|gb|zh|zh-?hans|简|简体|简中|简体中文)$/.test(s)) return { lang: 'chi', title: '简体中文（外挂）' }
  if (/^(cht|tc|big5|zh-?hant|繁|繁体|繁體|繁中|繁体中文|繁體中文)$/.test(s)) return { lang: 'chi', title: '繁體中文（外挂）' }
  if (/^(en|eng|english)$/.test(s)) return { lang: 'eng', title: 'English（外挂）' }
  if (!suffix) return { title: '外挂字幕' }
  return { title: `${suffix}（外挂）` }
}

/**
 * 从（递归列出的）同目录文件清单里挑出属于这个视频的外挂字幕：basename 以视频 stem 为前缀
 * （大小写不敏感；Subs/ 之类子目录也认——递归清单给的是相对路径，basename 才是匹配对象）。
 */
export function matchSiblingSubtitles(
  files: { name: string; size: number }[],
  videoFile: string,
): SiblingSubtitle[] {
  const stem = videoFile.replace(/\.[^.]+$/, '')
  const stemLower = stem.toLowerCase()
  const out: SiblingSubtitle[] = []
  for (const file of files) {
    if (!SUBTITLE_EXT.test(file.name) || file.size > MAX_SUBTITLE_BYTES) continue
    const base = file.name.split('/').pop()!
    if (!base.toLowerCase().startsWith(stemLower)) continue
    const suffix = base.slice(stem.length).replace(SUBTITLE_EXT, '').replace(/^[\s._-]+|[\s._-]+$/g, '')
    out.push({ id: `file:${file.name}`, ...langOf(suffix) })
  }
  return out
}

/** 字节 → 文本：严格 UTF-8 优先，失败回退 gb18030（中文压制组外挂字幕的常见编码）；剥 BOM。 */
export function decodeSubtitleText(bytes: Buffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('gb18030').decode(bytes)
  }
  return text.replace(/^﻿/, '')
}

/** SRT → WebVTT：加头 + 时间轴逗号换点。只动 `-->` 行，cue 文本里的逗号原样保留；
 *  序号行是合法的 VTT cue id，无需剥除。 */
export function srtToVtt(text: string): string {
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(/^﻿/, '')
    .split('\n')
    .map((line) => (line.includes('-->') ? line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') : line))
    .join('\n')
  return `WEBVTT\n\n${body.trimStart()}`
}

/** ASS `H:MM:SS.cc`（厘秒）→ VTT `HH:MM:SS.mmm`。 */
function assTime(t: string): string | null {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t.trim())
  if (!m) return null
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4]}0`
}

/**
 * 丢掉 ASS 绘图模式段落。`{\p<n>}`（n≥1）不是样式覆写，是**绘图开关**：它之后到 `{\p0}`
 * （或该 Dialogue 行结束）之间的内容是矢量路径数据（`m x y l x y …`、`b` 贝塞尔、`s` 样条），
 * 不是对白。必须在剥花括号**之前**丢掉——否则剥完花括号那串坐标就成了「字幕」被播放器画到屏幕上
 * （2026-07-27 实测：迅雷刮到的 .ass 一条轨里 86/372 个 cue 是坐标）。同一行可多次开关。
 *
 * `\p` 只在覆写块内部认，且要求紧跟数字（`\s*\d+`），所以 `\pos(…)`、`\pbo…` 这些同样以 `\p`
 * 开头的普通标签不会被误认；同块多标签（`{\an8\p1}`）以块内最后一个 `\p` 为准。
 */
function stripAssDrawings(raw: string): string {
  const block = /\{[^}]*\}/g
  let out = ''
  let drawing = false
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = block.exec(raw))) {
    if (!drawing) out += raw.slice(cursor, m.index)
    const tags = [...m[0].matchAll(/\\p\s*(\d+(?:\.\d+)?)/g)]
    if (tags.length) drawing = Number(tags[tags.length - 1][1]) >= 1
    out += m[0] // 覆写块本身原样留下，交给后面统一剥除
    cursor = m.index + m[0].length
  }
  if (!drawing) out += raw.slice(cursor)
  return out
}

/** ASS/SSA → WebVTT：只吃 [Events] 的 Dialogue 行——按 Format 定位 Start/End/Text 字段，
 *  先丢绘图段（`\p`，见 stripAssDrawings），再剥 `{\...}` 样式覆写、`\N`/`\n` 换行还原。
 *  定位/卡拉 OK 等表现层全丢，与取舍一致。 */
export function assToVtt(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n')
  let fields: string[] = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text']
  const cues: string[] = []
  for (const line of lines) {
    const fmt = /^Format:\s*(.+)$/.exec(line)
    if (fmt) {
      fields = fmt[1].split(',').map((f) => f.trim())
      continue
    }
    const dlg = /^Dialogue:\s*(.+)$/.exec(line)
    if (!dlg) continue
    // Text 是最后一个字段且自身可含逗号——按字段数-1 限制切分，余下整段归 Text。
    const parts = dlg[1].split(',')
    const head = parts.slice(0, fields.length - 1)
    const rawText = parts.slice(fields.length - 1).join(',')
    const start = assTime(head[fields.indexOf('Start')] ?? '')
    const end = assTime(head[fields.indexOf('End')] ?? '')
    if (!start || !end) continue
    const cueText = stripAssDrawings(rawText)
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .trim()
    if (!cueText) continue
    cues.push(`${start} --> ${end}\n${cueText}`)
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/** 外挂字幕字节 → WebVTT 文本，按扩展名分派；.vtt 原样透传（已是目标格式）。 */
export function siblingToVtt(bytes: Buffer, relPath: string): string {
  const text = decodeSubtitleText(bytes)
  const ext = relPath.toLowerCase().match(SUBTITLE_EXT)?.[1]
  if (ext === 'vtt') return text
  if (ext === 'ass' || ext === 'ssa') return assToVtt(text)
  return srtToVtt(text)
}
