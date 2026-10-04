import { tmdbJson, type TmdbFetch } from '../adapters/builtin/video-metadata.ts'
import type { LeftEntry } from '../netdisk/sync.ts'

/** TMDb `append_to_response` 的官方上限。超了要分批——静默截断会让后面的季永远配不上文件。 */
const APPEND_MAX = 20

/** 分集剧照用 w300（详情页 16:9 缩略图够用，不取 original——那是海报级尺寸，白费带宽）。 */
const TMDB_STILL_BASE = 'https://image.tmdb.org/t/p/w300'

export interface TmdbEpisodeIndexDeps {
  apiKey: string
  language?: string
  fetch?: TmdbFetch
}

export interface TmdbLeftRef {
  id: string
  media: 'movie' | 'tv'
  title: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `tmdb:<id>` = 电影；`tmdb:<id>:S01E05` = 剧集某集。播放反查是键无关的，认这个形状不用改它。 */
export const movieLeftKey = (id: string): string => `tmdb:${id}`
export const episodeLeftKey = (id: string, season: number, episode: number): string =>
  `tmdb:${id}:S${pad(season)}E${pad(episode)}`

/**
 * 作品的分集索引 → 绑定左侧（`LeftEntry[]`）。
 *
 * 这是 `left.kind:'tmdb'` 的进料口：它让一部作品**不必先成为 Stream** 就能有左侧——权威
 * （TMDb）本来就知道这剧有几集、每集叫什么。
 *
 * 两条硬约束（spike 2026-07-17 实测，见设计文档）：
 *  1. **只在建/同步绑定时调**，绝不进常规详情路径——一部剧的原始载荷 0.8–1.8MB，
 *     每开一次详情页白付 1MB 是唯一会让开销失控的接法。
 *  2. **抓完就投影**。TMDb 每集塞 overview/still_path/crew/guest_stars 且 API 不给字段裁剪：
 *     必须付 1MB 才能拿到想要的 3 个字段。但那 1MB 不用留——对齐只要 季/集号/标题，
 *     投影后 2.4–32KB（压缩 56–342×）。投影不是将就：`epnum` 阶段就是「按集号分桶 + 桶内
 *     标题相似度消歧」，要的正是这两个字段。
 */
export async function tmdbEpisodeIndex(deps: TmdbEpisodeIndexDeps, ref: TmdbLeftRef): Promise<LeftEntry[]> {
  const fetch = deps.fetch ?? (globalThis.fetch as TmdbFetch)
  // 电影是退化情形：一行左侧，无需对齐。不发 /tv 请求——它的 id 在 tv 命名空间里是另一部作品。
  if (ref.media === 'movie') return [{ leftKey: movieLeftKey(ref.id), title: ref.title }]

  const base = await tmdbJson(fetch, `/tv/${encodeURIComponent(ref.id)}`, deps.apiKey, deps.language)
  const seasons = (Array.isArray(base.seasons) ? base.seasons : [])
    .map((s: Record<string, unknown>) => Number(s.season_number))
    // 季 0 = 特别篇/花絮，不是正片集，不进左侧
    .filter((n: number) => Number.isFinite(n) && n > 0)
    .sort((a: number, b: number) => a - b)

  const out: LeftEntry[] = []
  for (let i = 0; i < seasons.length; i += APPEND_MAX) {
    const chunk = seasons.slice(i, i + APPEND_MAX)
    const append = chunk.map((n) => `season/${n}`).join(',')
    const page = await tmdbJson(
      fetch,
      `/tv/${encodeURIComponent(ref.id)}?append_to_response=${encodeURIComponent(append)}`,
      deps.apiKey,
      deps.language,
    )
    for (const n of chunk) {
      const eps = page[`season/${n}`]?.episodes
      if (!Array.isArray(eps)) continue
      for (const e of eps as Array<Record<string, unknown>>) {
        const s = Number(e.season_number ?? n)
        const num = Number(e.episode_number)
        if (!Number.isFinite(num)) continue
        // 投影：对齐要 季/集号/标题；详情页分集卡再带一个剧照 URL + 播出日期（两个短字符串，
        // 不是那 1MB 的 overview/crew/guest_stars）。TMDb 会把已公布但未播出的集也列进
        // episodes[]（air_date 是未来日期）——留着 air_date 就是为了让下游区分「未播出」与
        // 「已播出未匹配」，不然两者在分集树里长得一模一样。still/airDate 缺就不带。
        const still = typeof e.still_path === 'string' && e.still_path ? `${TMDB_STILL_BASE}${e.still_path}` : undefined
        const airDate = typeof e.air_date === 'string' && e.air_date ? e.air_date : undefined
        out.push({ leftKey: episodeLeftKey(ref.id, s, num), title: String(e.name ?? `S${pad(s)}E${pad(num)}`), ...(still ? { still } : {}), ...(airDate ? { airDate } : {}) })
      }
    }
  }
  return out
}
