import { fmtClock } from './audioStage.ts'
import type { TrackTableRow } from './playlistScope.ts'
import type { Item } from './types.ts'

/** 元数据卡里的一行：左边标签、右边值。空值的项**不出现**——留一行「专辑 —」只是噪声。 */
export interface TrackMetaField {
  label: string
  value: string
}

/** 本地时区的 `YYYY-MM-DD HH:MM`。缺失/非法一律空串，调用方据此丢掉那一行。 */
export function fmtDateTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 时间那一行的**标签**。源站给不出发布时间时（网盘目录采进来的条目就是这样——AList 只有
 *  文件名和大小），落库写的是采集时刻，于是 `timestamp === fetched_at`。这时候标「发布时间」
 *  是在把入库时刻冒充成播出时刻，看的人会据此判断这集有多新。 */
function timeLabel(item: Item): string {
  return item.timestamp === item.fetched_at ? '入库时间' : '发布时间'
}

/** 一行曲目的元数据。`sourceItem` 只有分集行有；曲目行（我的喜欢 / 播单里的 track 成员）
 *  没有原始 Item，只给得出行自带的那几项——卡片跟着降级，不报错也不留空行。 */
export function trackMetaFields(row: TrackTableRow): TrackMetaField[] {
  const out: TrackMetaField[] = []
  const author = row.author ?? row.sourceItem?.author
  if (author) out.push({ label: '作者', value: author })
  if (row.album) out.push({ label: '专辑', value: row.album })
  if (row.durationS) out.push({ label: '时长', value: fmtClock(row.durationS) })
  const item = row.sourceItem
  const when = fmtDateTime(item?.timestamp)
  if (item && when) out.push({ label: timeLabel(item), value: when })
  return out
}

/** `歌手：Øfdream` 这种「标签：值」行。标签放宽到 8 个字符——它是给人读的短词，
 *  不是任意前缀；不设上限的话正文里任何带冒号的句子都会被当成一行元数据。 */
const LABELLED_LINE = /^\s*[^：:\s]{1,8}[：:]\s*(.+?)\s*$/

/** 简介。`content.text` 是 normalize 过的正文（换行保留），`body_text` 是没走那条路的兜底。
 *
 *  **上面已经列成字段的那几项，从简介里删掉**：这类音乐源的正文本身就是一段
 *  「歌手：X / 专辑：Y / 发行日期：Z」，照抄进卡片就是同一句话说两遍，把真正只有正文才有的
 *  那一行（这里是发行日期）淹掉。判据是**值相等**，不是标签名相等——标签各源各写法，值不会骗人。 */
export function trackMetaDescription(row: TrackTableRow): string {
  const item = row.sourceItem
  const raw = (item?.content?.text ?? item?.body_text ?? '').trim()
  if (!raw) return ''
  const shown = new Set(trackMetaFields(row).map((f) => f.value))
  return raw
    .split('\n')
    .filter((line) => {
      const value = LABELLED_LINE.exec(line)?.[1]
      return !(value && shown.has(value))
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 标题之外还有东西可讲才挂 info 图标——弹出一张只写着标题的卡片，比没有这个图标更糟。 */
export function hasTrackMeta(row: TrackTableRow): boolean {
  return trackMetaFields(row).length > 0 || !!trackMetaDescription(row) || !!row.sourceUrl
}
