export interface ChannelLabel {
  /** primary line — the channel name */
  title: string
  /** secondary line — the parenthetical description, shown smaller/muted (empty if none) */
  subtitle: string
}

/** Split a channel label like "抖音 — 我的收藏（说明）。" into a primary title and a
 *  secondary subtitle: everything before the first paren is the title, the parenthetical
 *  is the subtitle. Falls back to the whole string (trailing period stripped) when there
 *  are no parens — so plain labels (Timeline, 搜索 “…”) stay as a single title. */
export function splitChannelLabel(label: string): ChannelLabel {
  const m = label.match(/^\s*(.+?)\s*[（(]\s*([\s\S]*?)\s*[)）]\s*[。.]?\s*$/)
  if (m) return { title: m[1], subtitle: m[2] }
  return { title: label.replace(/\s*[。.]\s*$/, '').trim(), subtitle: '' }
}
