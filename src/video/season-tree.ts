/**
 * 分集树：把「季/集号编码进 leftKey 的一串条目」摊成「按季分组、季内按集号升序」的树，供影视
 * 详情页的分季 tab + 分集列表渲染。
 *
 * 数据源两种，形状都归一到 `EpisodeRow`（见 `app.ts` 的组装）：
 *  - 已绑：`MappingSet.entries` —— leftKey/leftTitle 反解 + rightFile/status 给出 `playable`。零请求。
 *  - 未绑（仅剧集）：`tmdbEpisodeIndex` 投影缓存 —— 同样的 leftKey 形状，`playable` 恒 false。
 *
 * 这里只做「反解 + 分组 + 排序」，不认识 TMDb、不认识网盘。`buildSeasons` 是纯函数。
 */

export interface EpisodeRow {
  leftKey: string
  title: string
  playable: boolean
  /** 分集剧照 URL（TMDb still，w300）；缺则前端回落 Film 占位图。 */
  still?: string
  /** TMDb 播出日期（ISO date）；缺则前端不判「未播出」。 */
  airDate?: string
}

export interface SeasonEpisode {
  season: number
  episode: number
  title: string
  leftKey: string
  playable: boolean
  still?: string
  airDate?: string
}

export interface SeasonGroup {
  season: number
  episodes: SeasonEpisode[]
}

/** leftKey `tmdb:<id>:S01E05` → `{season:1, episode:5}`。电影键 `tmdb:<id>`、异常键 → null（跳过）。 */
export function parseEpisodeLeftKey(leftKey: string): { season: number; episode: number } | null {
  const m = /:S(\d{1,4})E(\d{1,4})$/i.exec(leftKey)
  if (!m) return null
  const season = Number(m[1])
  const episode = Number(m[2])
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null
  return { season, episode }
}

/**
 * 组装分集树。
 *
 *  - `media !== 'tv'` → undefined：电影退化、综艺/无 canonical 走不到这里，详情页据此维持扁平 grid。
 *  - 反解失败的行跳过（不硬塞进某一季）。
 *  - 全部反解失败 / 无行 → undefined（不显示空树）。
 */
export function buildSeasons(media: 'movie' | 'tv' | null | undefined, rows: EpisodeRow[]): SeasonGroup[] | undefined {
  if (media !== 'tv') return undefined
  const bySeason = new Map<number, SeasonEpisode[]>()
  for (const row of rows) {
    const parsed = parseEpisodeLeftKey(row.leftKey)
    if (!parsed) continue
    const list = bySeason.get(parsed.season) ?? []
    list.push({ season: parsed.season, episode: parsed.episode, title: row.title, leftKey: row.leftKey, playable: row.playable, ...(row.still ? { still: row.still } : {}), ...(row.airDate ? { airDate: row.airDate } : {}) })
    bySeason.set(parsed.season, list)
  }
  if (bySeason.size === 0) return undefined
  return [...bySeason.keys()]
    .sort((a, b) => a - b)
    .map((season) => ({
      season,
      episodes: bySeason.get(season)!.slice().sort((a, b) => a.episode - b.episode),
    }))
}
