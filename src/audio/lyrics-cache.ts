import type { LyricsCacheEntry } from './archive.ts'

/**
 * 一份 key → 歌词结果的缓存（形状与 `AudioArchive.getLyricsCache/putLyricsCache` 一致）。
 *
 * **缓存归调用方，不归源。** 「同一个 key 别重复问」是宿主的关切，与哪个源答上的无关；放在
 * 源里就要给每个歌词源各配一份，而 `PluginContext` 又不该为它多一格
 * （spec 2026-09-18-facility-knowledge-stage2-design §2.3）。
 * 命中永久、未命中 7 天的 TTL 仍归 `AudioArchive`——这里只是读写它。
 */
export interface LyricsCache {
  getLyricsCache(key: string): LyricsCacheEntry | null
  putLyricsCache(key: string, entry: LyricsCacheEntry): void
}

/** 一次解析的回执形状（`ResolveEngine.resolve` 的返回）。命中缓存时 `source` 是 `lyrics-cache`。 */
export interface LyricsResolution {
  source: string
  items: unknown[]
}

/**
 * 歌词解析的缓存壳。**两条调用路共用它**——HTTP 的 `GET /api/resolutions?type=lyrics`
 * 与 MCP 的 `resolve` 工具。各写一份的代价是其中一条静默地没有缓存：它不报错、不慢到
 * 显眼，只是每次播放都去打一次上游，而两条路的单测都照常绿。
 *
 * 三条判据，每一条都对着一种"把非判决冻成判决"的坏法：
 *  - `cache` 缺席 → 直接跑梯子（测试与没配缓存的装配都走这条）。
 *  - 结果为 `null`（梯子一条都没答上，多半是没配源）→ **不写**。写进去就把一次配置缺失
 *    冻成 7 天的"查无此歌"。
 *  - `items[0].matched` 不是 boolean（源没给判决）→ **不写**。miss（`matched:false`）
 *    要写——那是源真给出的判决，7 天内别再问同一首。
 *
 * key 按 `trim()` 归一化一次，**缓存和梯子用的是同一个**。两边不一致的话，写回时用的键和
 * 源真正查的那个字符串就不是一回事——`" x"` 和 `"x"` 会各自占一格、互相命不中，而两条路
 * 单看都正常。
 */
export async function withLyricsCache(
  cache: LyricsCache | undefined,
  key: string,
  resolve: (key: string) => Promise<LyricsResolution | null>,
): Promise<LyricsResolution | null> {
  const cacheKey = key.trim()
  const cached = cache?.getLyricsCache(cacheKey)
  if (cached) return { source: 'lyrics-cache', items: [cached] }
  const result = await resolve(cacheKey)
  const verdict = result?.items[0] as { matched?: boolean } | undefined
  if (cache && verdict && typeof verdict.matched === 'boolean') {
    cache.putLyricsCache(cacheKey, verdict as LyricsCacheEntry)
  }
  return result
}
