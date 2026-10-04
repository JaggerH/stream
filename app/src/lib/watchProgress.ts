import type { TFunction } from 'i18next'

/**
 * Derive a work's identity from an episode/movie playback key (the `leftKey` fed to
 * `/api/media/videos/resolve?key=`, e.g. `tmdb:261391:S03E02`, or a movie's leftKey with no
 * episode segment, e.g. `tmdb:261391`). This is the ONLY place that owns the "first two
 * colon-separated segments are the work, the third is the episode label" rule — the server-side
 * watch-progress feature (继续观看) groups rows by `workKey` so a series' many episode keys
 * collapse onto one shelf tile; get this wrong and every episode of a series shows up as its own
 * "work". Segments past the third are ignored (rather than folded into epLabel) so an opaque id
 * that happens to contain a colon of its own can never widen workKey past its intended two parts.
 */
export function workKeyParts(key: string): { workKey: string; epLabel?: string } {
  const parts = key.split(':')
  if (parts.length < 3) return { workKey: key }
  return { workKey: parts.slice(0, 2).join(':'), epLabel: parts[2] }
}

/**
 * Video-specific clock format for 「继续观看」 subtitles — deliberately NOT `fmtClock`
 * (`./audioStage.ts`), which is written for songs (`分:秒`, minutes never roll into hours; a
 * two-hour film at 1:05:05 would render as `65:05`). Video runtimes routinely cross an hour, so
 * ≥1h switches to `h:mm:ss` (minutes zero-padded once there's an hour part); under an hour stays
 * `m:ss` (seconds always zero-padded).
 */
export function fmtVideoClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const total = Math.floor(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

/** One card on the 「继续观看」shelf — a pure projection of a server `WatchProgressRow` (already
 *  deduped per work, filtered to unfinished, and sorted newest-first by the server; this function
 *  does no re-filtering/re-sorting of its own, just renders each row straight). */
export interface ContinueWatchingCard {
  key: string
  title: string
  poster?: string
  subtitle: string
  percent: number
}

/**
 * 续播 URL —— 服务端 `/api/media/videos/resolve` 认两种参数,`?key=<leftKey>` 和
 * `?id=<inboxItemId>`(后端把它补成 `item:<id>` 再去 netdisk lookup,见 src/http/app.ts 的
 * `/api/media/videos/resolve`)。「继续观看」的 `row.key` 两种来源都有:网盘绑定的集/电影,
 * `key` 本来就是 leftKey;`WorkDetail` 的本地季 tab / 扁平 grid 播放的集,`key` 是不透明的 inbox
 * item id —— 那条路径专门打了 `workKeyOverride: 'stream:<streamId>'` 标记(见 MovieChannel.tsx
 * buildServerProgress 头注),所以 `workKey` 以 `'stream:'` 开头就是"这一行的 key 其实是 item
 * id"的信号。选错参数 = 服务端拿 leftKey 语义去 lookup 一个 item id(或反过来),直接 404、
 * 卡片点了播不出来。这是唯一算这条规则的地方——调用点不许自己再判一次。
 */
export function resumeUrlFor(row: { key: string; workKey: string }): string {
  const param = row.workKey.startsWith('stream:') ? 'id' : 'key'
  return `/api/media/videos/resolve?${param}=${encodeURIComponent(row.key)}`
}

/**
 * `t` follows the `sourceLabel`(`./sourceLabel.ts`)pattern — a real `TFunction` at call sites,
 * a minimal fake dict in tests — so the「看到」wording and the `·` separator between epLabel and
 * time live in i18n (`movie.continueWatchingSubtitleEp` / `…SubtitleMovie`), not hardcoded here
 * (see `docs/superpowers/specs/2026-07-24-server-watch-progress-design.md` §B6: 副标「看到
 * S03E02 12:34」/「看到 12:34」).
 */
export function continueWatchingCards(
  rows: Array<{ key: string; workKey: string; workTitle: string; workPoster?: string; epLabel?: string; position: number; duration: number; updatedAt: number }>,
  t: TFunction,
): ContinueWatchingCard[] {
  return rows.map((r) => {
    const time = fmtVideoClock(r.position)
    const subtitle = r.epLabel
      ? t('movie.continueWatchingSubtitleEp', { ep: r.epLabel, time })
      : t('movie.continueWatchingSubtitleMovie', { time })
    const percent = r.duration > 0 ? Math.round((r.position / r.duration) * 100) : 0
    return { key: r.key, title: r.workTitle, poster: r.workPoster, subtitle, percent }
  })
}

/**
 * 「继续观看」卡片指向的详情页坐标——**不是播放器**。点一张卡先落到作品详情页(和点「正在追的」
 * 一张海报一样),再由那一页上的「继续播放」按钮开播:一张卡点下去直接全屏起播,用户就没有机会
 * 先看一眼这部作品有几季几集、绑定配上了没有、要不要换一集。
 *
 * 坐标只能从 `workKey` 反推(行里没有别的身份字段),两个命名空间各对一条已有路由:
 *  - `stream:<streamId>` → `{kind:'item'}`：`WorkDetail`(关注的剧)。
 *  - `tmdb:<id>` → `{kind:'tmdb'}`：`TmdbWorkDetail`。
 *
 * `media`(movie/tv)不在行里,只能判:leftKey 的第三段就是集号(`tmdb:261391:S03E02`,见
 * `workKeyParts`),**有集号 = 剧,没有 = 电影**。电影的 leftKey 只有两段,剧集的每一条都带 SxxEyy,
 * 所以这条判据不是启发式而是 leftKey 文法的直接推论。
 *
 * 认不出的命名空间返回 null —— 调用方据此回落到原地续播(有个能播的入口,好过一张点不动的卡)。
 */
export type ContinueWatchingRoute =
  | { kind: 'item'; id: string }
  | { kind: 'tmdb'; id: string; media: 'movie' | 'tv' }

export function continueWatchingRoute(row: { workKey: string; epLabel?: string }): ContinueWatchingRoute | null {
  const at = row.workKey.indexOf(':')
  if (at <= 0) return null
  const ns = row.workKey.slice(0, at)
  const id = row.workKey.slice(at + 1)
  if (!id) return null
  if (ns === 'stream') return { kind: 'item', id }
  if (ns === 'tmdb') return { kind: 'tmdb', id, media: row.epLabel ? 'tv' : 'movie' }
  return null
}

/**
 * 详情页上「继续播放」要用的那一行——按**这一页自己播放时会写下的 workKey** 去找,而不是让上层
 * 替它猜。一个详情页可能以不止一种身份写进度:`WorkDetail` 的本地季/扁平 grid 分支写
 * `stream:<id>`,而它的 TMDb 分季分支写的是 `tmdb:<id>`(leftKey 自带身份,见 buildServerProgress
 * 头注)——两个都要找,漏一个的表现是「明明刚看过,详情页上却没有继续播放」。
 *
 * `rows` 是服务端已经按 work 去重、按 updatedAt 新→旧排好的(见 WatchProgressStore.inProgress),
 * 所以第一条命中的就是最近那一次,这里不再排序。
 */
export function findResumeRow<T extends { workKey: string }>(rows: T[], workKeys: Array<string | undefined>): T | undefined {
  const wanted = new Set(workKeys.filter((k): k is string => !!k))
  return wanted.size ? rows.find((r) => wanted.has(r.workKey)) : undefined
}
