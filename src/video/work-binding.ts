import type { VideoDetail } from './types.ts'

/** 一部作品在 TMDb 的坐标。绑定左侧要它，因为 TMDb 的 id 按媒体类型分命名空间。 */
export interface TmdbWorkRef {
  id: string
  media: 'movie' | 'tv'
  title: string
  /** 首播年份（转存落点走 Jellyfin 命名 `<标题> (年份) [tmdbid-x]` 用；取不到就省略年份段）。 */
  year?: number
}

/**
 * 详情 → 这部作品的 TMDb 坐标（能绑网盘的前提）。
 *
 * 只认 canonical **已验证**的 id：`video-canonical` 的整个存在意义就是「不让模糊匹配把一部作品
 * 悄悄变成另一部」。拿一个没验过的候选去绑网盘，等于把那个模糊匹配写进用户的盘里。
 * 没有 canonical → null（调用方据此说「还不能绑」，而不是绑错）。
 */
export function tmdbWorkRef(detail: VideoDetail | undefined): TmdbWorkRef | null {
  const c = detail?.canonical
  if (!c || c.status !== 'resolved') return null
  const id = c.externalIds?.tmdb
  if (!id) return null
  const kind = c.kind ?? detail?.identity.kind
  // series/season/episode 都住在 TMDb 的 tv 命名空间；movie 独立。kind 说不清时不猜——
  // 猜错媒体类型 = 绑到另一部同 id 的作品上。
  const media = kind === 'movie' ? 'movie' : kind === 'series' || kind === 'season' || kind === 'episode' ? 'tv' : null
  if (!media) return null
  // ref.title 会被 jellyfinDirName 刻进用户的网盘目录——id 冒充的 title（旧毒缓存里 canonical.title
  // 就是 id 回显）在每一级都跳过，全链没有真名就宁可 null（「还不能绑」），别把 id 写进盘里。
  const usable = (t: string | undefined) => (t?.trim() && t !== id ? t : undefined)
  const title = usable(c.title) ?? usable(detail?.metadata?.title) ?? usable(detail?.identity.title)
  if (!title) return null
  const year = c.year ?? detail?.metadata?.year ?? detail?.identity.year
  return { id, media, title, ...(typeof year === 'number' && Number.isFinite(year) ? { year } : {}) }
}

/**
 * 转存落点子目录名，照 Jellyfin 的电影/剧集文件夹约定：`<标题> (年份) [tmdbid-<id>]`。
 *
 * 为什么带 id：用户本机跑 Jellyfin，网盘目录用它认识的名字 → 将来挂进 Jellyfin 零改名直接刮削；
 * 同时防同名不同年撞目录（title-only 会把重拍挤进同一个目录，绑定就乱了）。id 天然唯一，年份
 * 只是锦上添花，不是靠它去重。文件系统非法字符（`/ \ : * ? " < > |`）替换为空格。
 *
 * 剧集不带年份：`ref.year` 只是**首播**（第一季）的年份，一个标量扛不起一部可能跨好几年、
 * 好几季的剧——真实案例：某剧绑定目录曾被落成 `<标题> (2024) [tmdbid-x]`，但这部剧其实播到了
 * 2026，`(2024)` 反而在暗示"这个目录只代表某一年"，是误导而不是信息。tmdbid 本身已经唯一
 * 定位到整部作品，剧集侧不需要靠年份再去重。电影没有这个问题（一部电影只有一个上映年份），
 * 且重拍片确实靠年份区分（`流浪地球` 1986 版 vs 2019 版这类），继续带。
 */
export function jellyfinDirName(ref: { id: string; media: 'movie' | 'tv'; title: string; year?: number }): string {
  const clean = ref.title.replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
  const showYear = ref.media === 'movie' && typeof ref.year === 'number' && Number.isFinite(ref.year)
  const year = showYear ? ` (${ref.year})` : ''
  return `${clean}${year} [tmdbid-${ref.id}]`
}

/**
 * 转存落点子目录名——**网盘上不出现明文作品名**（设计见
 * `docs/superpowers/specs/2026-07-25-netdisk-opaque-work-dirs-design.md`）。
 *
 * 为什么不用 jellyfinDirName：分享者把文件名打成规避字是为了躲网盘的版权识别，而把它们装进
 * 一个叫「喜剧之王单口季」的目录里，里面伪装得再好也无意义——目录名就是最好的索引。这是
 * Stream 自己造成的暴露。用户 2026-07-25 拍板：已基本不用 Jellyfin，防和谐优先于可刮削。
 *
 * **`media-` 前缀不可省**：TMDb 的 id 按媒体类型分命名空间，`movie/1084244` 和 `tv/1084244`
 * 是两部不同作品，只用数字将来必撞目录。
 *
 * **必须是同一作品恒定可复现的纯函数**：`planBinding` 靠 `existing.right.path === dirPath`
 * 判断这次转存是 sync（同作品补集）还是 rebind（换了目录）。掺进随机数/时间戳/可变盐，同作品
 * 转存两次就会建出两个目录、散掉绑定。改这里之前先满足这一条。
 *
 * 未加盐哈希是明知的取舍：TMDb id 挡得住按片名匹配的自动扫描，挡不住针对性反查
 * （`themoviedb.org/tv/261391` 一查即出）。换来的是用户自己在网盘里看到 `tv-261391`
 * 回 Stream 一搜就知道是哪部；哈希则只能查表。
 */
export function opaqueWorkDirName(ref: { id: string; media: 'movie' | 'tv' }): string {
  return `${ref.media}-${ref.id}`
}
