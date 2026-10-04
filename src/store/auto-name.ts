import type { StreamRecord } from './types.ts'

/** After a successful harvest, compute the auto-name update for a Stream, or null (no-op).
 *  Applies only when options.labelAuto is set and the feed title is non-empty; clears the
 *  flag so a later harvest never overwrites the (now-final) label, and a user rename — which
 *  clears labelAuto — is preserved. */
export function backfillLabel(
  record: StreamRecord, title: string,
): { label: string; options: Record<string, unknown> } | null {
  const trimmed = title.trim()
  if (!trimmed) return null
  if (!record.options?.labelAuto) return null
  const { labelAuto: _drop, ...options } = record.options as Record<string, unknown>
  return { label: trimmed, options }
}

/**
 * 兜底的「这条流叫什么」——adapter 没报 feed title 时，从本轮采到的 raw items 里推断。
 *
 * 为什么需要它：`AdapterFetchResult.title` 是可选的，而 8 个 adapter 里只有 RSSHub 那个真的
 * 填了它。其余（拟人采集 replay、douyin、builtin…）全返回裸数组，于是 `labelAuto` 永远清不掉、
 * 名字永远停在 `xhs:xhs-home` 这种占位串。改一处让全部 adapter（含以后新增的）一起受益，
 * 好过让每份 recipe 各自声明一遍——那个缺陷会以同样的形状在下一份 recipe 上复发。
 *
 * 判据故意收得很紧，因为它自带筛选：一个账号/合集的流全批同一个作者（命中），首页 feed 和
 * 搜索结果人各不同（不命中，而它们本来就不该叫某个作者的名字）。**宁可不填**——`labelAuto`
 * 只生效一次，填错的名字会被永久写死，比占位名更烦人。
 *
 * 两条硬边界：至少 2 条（单条一致是废话，搜索源恰好只回一条时会被误命名）、100% 一致
 * （不设"多数即可"）。`AdapterFetchResult.title` 优先级更高，这里只在它缺席时兜底。
 */
export function inferFeedTitle(rawItems: readonly unknown[]): string | undefined {
  if (rawItems.length < 2) return undefined
  let agreed: string | undefined
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') return undefined
    const author = (raw as { author?: unknown }).author
    if (typeof author !== 'string') return undefined
    const name = author.trim()
    if (!name) return undefined
    if (agreed === undefined) agreed = name
    else if (agreed !== name) return undefined
  }
  return agreed
}
