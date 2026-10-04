import { Fragment, useCallback, useEffect, useMemo, useState, useRef, type CSSProperties, type ReactNode } from 'react'
import { useSpeakerMap } from '../hooks/useSpeakerMap.ts'
import { DetailShell } from './DetailShell.tsx'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, ChevronRight, ExternalLink, Film, Loader2, MessageSquareQuote, Play, RefreshCw, Settings2, Star, UserRound, UserRoundPlus, X } from 'lucide-react'
import { referenceEpisode, referenceWork } from '../lib/askExtract.ts'
import { Searchbar } from './acrylic/searchbar.tsx'
import { api, imgUrl, ApiError, LOCAL, type Connection } from '../lib/api.ts'
import { mergeFollowingTimeline, partitionFollowing } from '../lib/items.ts'
import { MediaBadge, MediaCard } from './MediaCard.tsx'
import type { ChannelStream, ChannelView, CollectedItem, Conversion, Item, SeasonEpisode, SeasonGroup, VideoWorkCandidate, VoicePerson, WatchProgressRow, WorkBindingView } from '../lib/types.ts'
import { SYSTEM_COLLECTIONS } from '../lib/types.ts'
import { playableVideo, type VideoMedia } from '../lib/videoPlan.ts'
import { cn } from '../lib/utils.ts'
import { ChannelTitleMenu } from './ChannelTitleMenu.tsx'
import { ArtPlayer, type ServerProgressConfig } from './ArtPlayer.tsx'
import { continueWatchingCards, continueWatchingRoute, findResumeRow, resumeUrlFor, workKeyParts } from '../lib/watchProgress.ts'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu.tsx'
import { ChannelConfigPanel } from './manage/ChannelConfigPanel.tsx'
// 多频道那一档还留着齿轮 → 抽屉（见 `tab` 那格的注释）
import { ChannelManageSheet } from './manage/ChannelManageSheet.tsx'
import { ChannelTabs, type ChannelTab } from './manage/ChannelTabs.tsx'
import { ResourceFinderSheet } from './ResourceFinder.tsx'
import { WorkBinding } from './WorkBinding.tsx'
import { CollectButton } from './CollectButton.tsx'
import { ScrollArea } from './ui/scroll-area.tsx'
import { Badge } from './acrylic/badge.tsx'
import { Item as AcrylicItem, ItemGroup, ItemRow } from './acrylic/item.tsx'
import { Spinner } from './acrylic/spinner.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './acrylic/tooltip.tsx'
import { Button } from './acrylic/button.tsx'
import { ButtonGroup, ButtonGroupItem } from './acrylic/button-group.tsx'
import { toast } from './acrylic/sonner.tsx'
import { Card, CardMedia, CardMediaOverlay, CardTitle, CardDescription } from './acrylic/card.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './acrylic/popover.tsx'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './acrylic/alert-dialog.tsx'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './acrylic/command.tsx'
import { speakerColor, speakerSegments, speakingAt, segmentSeekPoints } from '../lib/speaker-timeline.ts'
import { useSubRoute, useSubRouteLocation } from '../hooks/useSubRoute.ts'
import { useScrollMemory, scrollAreaViewport } from '../hooks/useScrollMemory.ts'

const badgeText = (n: number) => (n > 9 ? '9+' : String(n))

/**
 * Esc dismisses the topmost layer. Ownership is explicit rather than raced: every layer listens
 * on window, so the one underneath opts out via `enabled` while something covers it — otherwise
 * closing the player with Esc would also drop the detail page back to the grid, in one keypress.
 */
function useEscape(onEscape: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onEscape() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscape, enabled])
}

/**
 * The level-2 detail selection encoded in the URL, so the 影视 channel's sub-page is
 * addressable (deep-linkable + visible for debugging) instead of pure component state.
 * The virtual 影视 channel lives at /video. Named video channels remain supported for existing
 * links, so their sub-pages can also hang off /c/<channelId>:
 *   /video or /c/<channelId>          → level-1 grid
 *   /video/item/<id> or /c/<channelId>/item/<id> → that title's detail page
 * route.ts preserves these sub-paths so App's route sync doesn't collapse a deep-link.
 *
 * One segment, because from the outside both pages are the same thing: one title you opened.
 * That a followed 剧 is addressed by its Stream id and a ranking row by its item id is how
 * Stream happens to store them, not something a URL should make the reader care about — the
 * id namespaces are disjoint in practice (slug vs 16-hex digest) and `videoSelection` fixes
 * the lookup order, so one segment stays unambiguous.
 */
export function videoBaseFrom(pathname: string): string {
  const seg = pathname.split('/') // ['', 'c', '<id>', ...]
  if (seg[1] === 'c' && seg[2]) return '/c/' + seg[2]
  return seg[1] === 'video' ? '/video' : pathname
}
type VideoRoute =
  | { kind: 'home' }
  | { kind: 'item'; id: string }
  | { kind: 'tmdb'; id: string; media: 'movie' | 'tv' }
/** Pure parse body: pathname → route. Exported so both bases (/video and /c/<id>) can be tested
 *  without touching window.location. */
export function videoRouteFrom(pathname: string): VideoRoute {
  const seg = pathname.split('/') // ['', 'c', '<id>', 'item', '<x>']
  const subpath = seg[1] === 'c' && seg[2] ? seg.slice(3) : seg[1] === 'video' ? seg.slice(2) : []
  // 纯榜单作品(无 Stream,收藏后落在这条路由)——'tmdb/<movie|tv>/<id>'。
  if (subpath[0] === 'tmdb' && (subpath[1] === 'movie' || subpath[1] === 'tv') && subpath[2]) {
    return { kind: 'tmdb', media: subpath[1], id: decodeURIComponent(subpath[2]) }
  }
  // 'work' was the old segment for a followed 剧; keep reading it so open tabs and bookmarks
  // still land, but only ever write 'item'.
  if ((subpath[0] === 'item' || subpath[0] === 'work') && subpath[1]) return { kind: 'item', id: decodeURIComponent(subpath[1]) }
  return { kind: 'home' }
}
/** Pure path-build body: base + route → path. Exported so both bases can be tested without
 *  touching window.location. A base of '/' would make '/'+'/work' → '//work' (a protocol-relative
 *  URL); collapse it to avoid that. */
export function videoToPathFrom(base: string, r: VideoRoute): string {
  if (r.kind === 'home') return base
  const prefix = base === '/' ? '' : base
  if (r.kind === 'tmdb') return `${prefix}/tmdb/${r.media}/${encodeURIComponent(r.id)}`
  return `${prefix}/${r.kind}/${encodeURIComponent(r.id)}`
}

/** First image media is the poster (the movie normalizer emits archetype 'gallery' + cover). */
function poster(it: Item): string | undefined {
  for (const m of it.content?.media ?? []) if (m.kind === 'image' && m.url) return m.url
  return undefined
}

/**
 * Item card — used for level-1 ranking movies (2:3 posters) AND level-2 episodes
 * (16:9 thumbs). Ranking cards open their Stream detail; episode cards without an
 * internal media binding still link out to their source page. Standardized
 * on the shared MediaCard: a fixed `aspect-ratio` cover (per `ratio`) on the frosted
 * Card, so a homogeneous grid stays uniform. The rating star + source label ride as
 * overlays inside the cover.
 */
function MovieCard({ it, baseUrl, ratio = '2 / 3', onOpen }: { it: Item; baseUrl: string; ratio?: string; onOpen?: () => void }) {
  const meta = it.content?.meta
  const preview = it.videoDetail
  const cover = preview?.poster ?? poster(it)
  const sub = [preview?.year ?? meta?.year, meta?.genres?.[0]].filter(Boolean).join(' · ')
  return (
    <MediaCard
      href={onOpen ? undefined : it.url || undefined}
      onOpen={onOpen}
      ariaLabel={preview?.title ?? it.title}
      src={cover ? imgUrl(baseUrl, cover) : undefined}
      ratio={ratio}
      fallback={<Film className="size-8" />}
      title={preview?.title ?? it.title}
      subtitle={sub}
    >
      {(preview?.rating ?? meta?.rating) && (
        <MediaBadge className="right-1.5 top-1.5 tabular-nums">
          <Star className="size-3 fill-amber-400 text-amber-400" />
          {preview?.rating ?? meta?.rating}
        </MediaBadge>
      )}
      {meta?.source && (
        <MediaBadge className="bottom-1.5 left-1.5">{meta.sourceLabel ?? meta.source}</MediaBadge>
      )}
    </MediaCard>
  )
}

/**
 * Level-1 「正在追的」card: ONE followed work (剧集/综艺/电影) as a fixed portrait album poster
 * + title + update badge. Never shows episodes — clicking opens the work detail (level-2).
 * Cover is the stream's work poster (`stream.image`, from the feed image / author_avatar).
 */
function WorkCard({ stream, badge, baseUrl, onOpen }: {
  stream: ChannelStream
  badge: number
  baseUrl: string
  onOpen: () => void
}) {
  return (
    <MediaCard
      onOpen={onOpen}
      ariaLabel={stream.description || stream.id}
      src={stream.image ? imgUrl(baseUrl, stream.image) : undefined}
      ratio="2 / 3"
      fallback={<Film className="size-8" />}
      title={stream.description || stream.id}
    >
      {badge > 0 && (
        <Badge size="sm" className="absolute right-1.5 top-1.5 z-10 min-w-[18px] tabular-nums shadow">
          {badgeText(badge)}
        </Badge>
      )}
    </MediaCard>
  )
}

/**
 * Level-1 「正在追的」card for a 收藏-by-tmdb-id work — a ranking-only movie/show with no Stream
 * (see collections/store.ts 头注). Same tile as WorkCard, sourced from the收藏 snapshot directly
 * instead of a ChannelStream (no newCount concept applies — chart rows don't have "new episodes").
 */
function TmdbWorkCard({ item, baseUrl, onOpen }: { item: CollectedItem; baseUrl: string; onOpen: () => void }) {
  const { t } = useTranslation()
  const card = (
    <MediaCard
      onOpen={onOpen}
      ariaLabel={item.title}
      src={item.poster ? imgUrl(baseUrl, item.poster) : undefined}
      ratio="2 / 3"
      fallback={<Film className="size-8" />}
      title={item.title}
    />
  )
  // 收藏快照缺 tmdbId/media 的老行（迁移前写下的）没有坐标可引——那种情况不出菜单，
  // 而不是出一个点了插进去半截坐标的菜单项。
  if (!item.tmdbId || !item.media) return card
  const ref = { id: item.tmdbId, media: item.media, title: item.title }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild><div>{card}</div></ContextMenuTrigger>
      <ContextMenuContent size="sm" className="w-40">
        <ContextMenuItem onSelect={() => void referenceWork(ref)}>{t('movie.referenceInChat')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 搜索候选卡——TMDB 片名搜索结果的一张海报卡（评分 + 来源角标叠在封面上）；点开走已有的
 *  tmdb 详情路由（externalIds.tmdb + kind），不新造详情。 */
function CandidateCard({ candidate, baseUrl, onOpen }: { candidate: VideoWorkCandidate; baseUrl: string; onOpen: () => void }) {
  return (
    <MediaCard
      onOpen={onOpen}
      ariaLabel={candidate.title}
      src={candidate.poster ? imgUrl(baseUrl, candidate.poster) : undefined}
      ratio="2 / 3"
      fallback={<Film className="size-8" />}
      title={candidate.title}
      subtitle={candidate.year ? String(candidate.year) : undefined}
    >
      {candidate.rating != null && (
        <MediaBadge className="right-1.5 top-1.5 tabular-nums">
          <Star className="size-3 fill-amber-400 text-amber-400" />{candidate.rating.toFixed(1)}
        </MediaBadge>
      )}
      <MediaBadge className="bottom-1.5 left-1.5">TMDB</MediaBadge>
    </MediaCard>
  )
}

/**
 * Level-2 work detail — a作品页: back button + poster/title hero + the work's episode grid.
 * Resolve-only episodes are Stream-managed AList bindings: mapped files play in this
 * page, while unmapped files deliberately remain inert rather than opening a stale
 * source URL. Other episodes retain their original official-link behavior.
 */
function EpisodeCard({ it, baseUrl, onPlay, onFindResource }: {
  it: Item
  baseUrl: string
  /** 第二参 = 该集转写/说话人数据的键（inbox item 用 id，网盘绑定的集用 leftKey） */
  onPlay: (media: VideoMedia, itemId?: string) => void
  onFindResource: (title: string) => void
}) {
  const { t } = useTranslation()
  const resolveOnly = it.content?.media?.find((m): m is VideoMedia => m.kind === 'video' && !!m.resolveOnly)
  const media = resolveOnly ? playableVideo([resolveOnly]) : undefined
  const cover = poster(it) ?? resolveOnly?.poster

  if (resolveOnly && !media) {
    return (
      <UnmatchedEpisodeCard
        cover={cover ? imgUrl(baseUrl, cover) : undefined}
        title={it.title}
        note={t('video.finderNotMatched')}
        action={t('video.findResource')}
        onAction={() => onFindResource(it.title)}
      />
    )
  }

  if (resolveOnly && media) {
    return (
      <MediaCard
        onOpen={() => onPlay(media, it.id)}
        ariaLabel={it.title}
        src={cover ? imgUrl(baseUrl, cover) : undefined}
        ratio="16 / 9"
        fallback={<Film className="size-8" />}
        title={it.title}
        className={cn('transition-colors hover:border-primary/50')}
      />
    )
  }

  return <MovieCard it={it} baseUrl={baseUrl} ratio="16 / 9" />
}

/**
 * 一集分集卡 —— 和「正在追的」扁平分集 grid（`EpisodeCard`）同构：16:9 剧照缩略图 + 集号角标 + 标题。
 * 已配上文件 → 点了直接播；没配上 → 灰卡 +「找资源」。剧照来自 TMDb still（后端投影，w300）；
 * 缺图回落 Film 占位。这样 Jellyfin 那种「一屏剧照墙」在分季分集里也成立，而不是一列干巴巴的文字。
 */
function SeasonEpisodeCard({ ep, workTitle, season, baseUrl, onPlay, onFindResource }: {
  ep: SeasonEpisode
  /** 引用一集时屏幕上要写清是哪一部的第几集——光有集标题，翻回去的人认不出来。 */
  workTitle: string
  season: number
  baseUrl: string
  /** 第二参 = 该集转写/说话人数据的键（网盘绑定的集就是 leftKey） */
  onPlay: (media: VideoMedia, itemId?: string) => void
  onFindResource: () => void
}) {
  const { t } = useTranslation()
  const cover = ep.still ? imgUrl(baseUrl, ep.still) : undefined
  const epNo = t('movie.episodeShort', { n: ep.episode })
  const badge = <MediaBadge className="left-2 top-2 tabular-nums">{epNo}</MediaBadge>
  // TMDb 会把已公布但未播出的集也列进分集索引（air_date 是未来日期）——这类集本来就搜不到资源，
  // 灰卡不该引导用户去「找资源」，要跟「已播出但没匹配上」区分开。
  const unaired = !ep.playable && !!ep.airDate && new Date(ep.airDate).getTime() > Date.now()

  // 右键引用**两态都给**：没配上的那些恰恰是最需要拿进对话说的（"这一集为什么没配上"）。
  const withRef = (card: ReactNode): ReactNode => (
    <ContextMenu>
      <ContextMenuTrigger asChild><div>{card}</div></ContextMenuTrigger>
      <ContextMenuContent size="sm" className="w-40">
        <ContextMenuItem onSelect={() => void referenceEpisode({ leftKey: ep.leftKey, workTitle, season, episode: ep.episode, title: ep.title })}>
          {t('movie.referenceInChat')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )

  if (ep.playable) {
    return withRef(
      <MediaCard
        onOpen={() => onPlay({ kind: 'video', url: '/api/media/videos/resolve?key=' + encodeURIComponent(ep.leftKey), resolveOnly: true }, ep.leftKey)}
        ariaLabel={`${epNo} ${ep.title}`}
        src={cover}
        ratio="16 / 9"
        fallback={<Film className="size-8" />}
        title={ep.title}
        subtitle={epNo}
        className="transition-colors hover:border-primary/50"
      >
        {badge}
      </MediaCard>,
    )
  }
  return withRef(
    <UnmatchedEpisodeCard
      cover={cover}
      title={ep.title}
      note={unaired ? t('video.notAired') : t('video.finderNotMatched')}
      action={unaired ? undefined : t('video.findResource')}
      onAction={onFindResource}
      opacity="opacity-70"
    >
      {badge}
    </UnmatchedEpisodeCard>,
  )
}

/**
 * 灰卡 —— 一集存在但点不了：没配上文件，或（分季索引里）还没播。和能播的 MediaCard 同构，
 * 走同一套 Card / CardMedia / CardTitle / CardDescription 骨架（此前是手搓 div + 手挑字号，
 * 和旁边的正常卡对不齐），只是整张降透明度、剧照去色，读起来「在这儿，但还拿不到」。
 * 有 `action` 才给下一步按钮——灰卡曾是死胡同，看到「没有」却没有下一步；未播的集不该被
 * 引导去搜一个还不存在的资源，所以那种情况只留说明、不给按钮。
 */
function UnmatchedEpisodeCard({ cover, title, note, action, onAction, opacity = 'opacity-60', children }: {
  cover?: string
  title: string
  note: string
  action?: string
  onAction: () => void
  opacity?: string
  children?: ReactNode
}) {
  return (
    <div data-nested-surface="true" className={cn('group block text-left', opacity)}>
      <Card className="flex h-full flex-col overflow-hidden p-0 text-left">
        <CardMedia ratio="16 / 9" src={cover} fallback={<Film className="size-8" />} imageClassName="grayscale">
          {children}
        </CardMedia>
        <div className="flex flex-col gap-1 px-3 pb-3 pt-2.5">
          <CardTitle className="self-stretch truncate text-muted-foreground" title={title}>{title}</CardTitle>
          <div className="flex items-center justify-between gap-2">
            <CardDescription className="truncate">{note}</CardDescription>
            {action && (
              <Button
                variant="neutral"
                size="mini"
                className="shrink-0"
                onClick={(e) => { e.stopPropagation(); onAction() }}
              >
                {action}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

/**
 * 分季 tab + 分集卡墙 —— 「真剧集」详情页的分集区（Jellyfin 式）。数据是 TMDb 权威分集索引
 * （后端 `seasons`，带每集剧照）；能播性从网盘绑定叠上去。分集卡与「正在追的」扁平 grid 同构。
 *
 * 「找资源」的查询用整部剧的标题（`workTitle`）而不是单集名：资源站按整季/整部发布，拿单集名
 * （「凛冬将至」）去搜基本搜不到。
 */
function SeasonEpisodeList({ seasons, workTitle, baseUrl, onPlay, onFindResource }: {
  seasons: SeasonGroup[]
  workTitle: string
  baseUrl: string
  onPlay: (media: VideoMedia, itemId?: string) => void
  onFindResource: (query: string) => void
}) {
  const { t } = useTranslation()
  const [active, setActive] = useState(seasons[0]?.season ?? 1)
  const current = seasons.find((s) => s.season === active) ?? seasons[0]
  if (!current) return null
  return (
    <div className="flex flex-col gap-4">
      {seasons.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {seasons.map((s) => (
            <button
              key={s.season}
              type="button"
              onClick={() => setActive(s.season)}
              className={cn(
                'rounded-full px-3 py-1 text-[12px] transition-colors',
                s.season === current.season ? 'bg-primary text-primary-foreground' : 'bg-foreground/8 text-muted-foreground hover:text-foreground',
              )}
            >
              {t('movie.seasonLabel', { n: s.season })}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-5">
        {current.episodes.map((ep) => (
          <SeasonEpisodeCard key={ep.leftKey} ep={ep} workTitle={workTitle} season={current.season} baseUrl={baseUrl} onPlay={onPlay} onFindResource={() => onFindResource(workTitle)} />
        ))}
      </div>
    </div>
  )
}

/**
 * 本地季 tab —— 非 TMDb 匹配、由多个 fanout member（各带 `season` 标签）合并进同一个 Stream 的剧，
 * 按 item.season 分组展示。跟 SeasonEpisodeList 视觉同构（同款 pill tab），但数据源和渲染完全不同：
 * 这里的一集就是一个原始采集 Item，直接复用现有、不改动的扁平 EpisodeCard（resolveOnly 播放 /
 * 灰卡找资源 / 普通条目跳原始链接三态都保留），不是 SeasonEpisodeCard 那套 leftKey/playable 逻辑。
 */
function LocalSeasonTabs({ episodes, baseUrl, onPlay, onFindResource }: {
  episodes: Item[]
  baseUrl: string
  onPlay: (media: VideoMedia, itemId?: string) => void
  onFindResource: (title: string) => void
}) {
  const { t } = useTranslation()
  const bySeason = new Map<number, Item[]>()
  const untagged: Item[] = []
  for (const ep of episodes) {
    if (ep.season == null) { untagged.push(ep); continue }
    const list = bySeason.get(ep.season) ?? []
    list.push(ep)
    bySeason.set(ep.season, list)
  }
  // Untagged items are pre-migration history of whatever season was being tracked before sibling
  // seasons were added as additional members — in both real migrations this feature exists for,
  // that's the highest-numbered season (the pre-existing member kept its season while new,
  // earlier seasons were added alongside it). Merge them in rather than dropping them, so no
  // episode vanishes from the UI just because it predates the `season` tag existing.
  if (untagged.length) {
    const maxSeason = bySeason.size ? Math.max(...bySeason.keys()) : 1
    const list = bySeason.get(maxSeason) ?? []
    list.push(...untagged)
    bySeason.set(maxSeason, list)
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b)
  const [active, setActive] = useState(seasons[seasons.length - 1] ?? 1)
  const current = bySeason.get(active) ?? bySeason.get(seasons[seasons.length - 1])
  if (!current) return null
  return (
    <div className="flex flex-col gap-4">
      {seasons.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {seasons.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setActive(s)}
              className={cn(
                'rounded-full px-3 py-1 text-[12px] transition-colors',
                s === active ? 'bg-primary text-primary-foreground' : 'bg-foreground/8 text-muted-foreground hover:text-foreground',
              )}
            >
              {t('movie.seasonLabel', { n: s })}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-5">
        {current.map((ep) => <EpisodeCard key={ep.id} it={ep} baseUrl={baseUrl} onPlay={onPlay} onFindResource={onFindResource} />)}
      </div>
    </div>
  )
}

interface VideoDetailPayload {
  episodes: Item[]
  /** 分季分集树（后端 /video-detail 的 `seasons`）——仅「真剧集」有；电影/综艺/无 canonical absent，
   *  前端据此在「TMDb 分季分集」与「扁平采集 grid」之间择一渲染。 */
  seasons?: SeasonGroup[]
  /** 这部作品的网盘绑定视图（后端 /video-detail 的 `work` 字段）。 */
  binding?: WorkBindingView
  detail: {
    metadata?: { source?: string; title?: string; originalTitle?: string; releaseDate?: string; year?: number; runtimeMinutes?: number; overview?: string; genres?: string[]; people?: Array<{ name: string; role: string; character?: string; image?: string }>; ratings?: Array<{ source: string; value: number; scale: number }> }
    images: { poster?: { url: string }; backdrop?: { url: string }; logo?: { url: string } }
    failures: Array<{ member: string; message: string }>
    /** canonical 解析结果——metadata 整体没拿到时,它常常还留着一个可用的真实标题(见 title 计算)。 */
    canonical?: { status: 'resolved'; title?: string } | { status: 'miss' }
    /** 这次查询最终落到的身份（后端 VideoDetail.identity）——外链去哪由它决定，见 tmdbWorkUrl。 */
    identity?: { kind?: 'movie' | 'series' | 'season' | 'episode' | 'unknown'; externalIds?: Record<string, string> }
  }
}

/** 「TMDb 作品页的 URL 怎么拼」——**全前端只此一处**。三个详情页的外链都从这里拿，
 *  别在别处再内联一次字符串拼接（内联的搜不到、也钉不住测试）。 */
export function tmdbWorkUrl(media: 'movie' | 'tv', id: string): string {
  return `https://www.themoviedb.org/${media}/${id}`
}

/** 详情页外链的去处判据：有权威 TMDb id 就跳 TMDb，没有才回落到发现源自己的页面。
 *
 *  判据只看 `identity.externalIds.tmdb` 有没有，不额外要求 `canonical.status === 'resolved'`：
 *  canonical miss 时后端把**查询用的** identity 原样带回（detail-service.ts mergeVideoDetail），
 *  那份里的 tmdb id 来自条目自己的 videoRef——同样是权威坐标，够格跳 TMDb；纯标题查询的 miss
 *  则根本没有 tmdb id，自然落到回落分支。 */
function OriginalLink({ url, identity, label }: {
  url?: string
  /** `VideoDetailPayload['detail']['identity']`——给了就优先跳 TMDb。 */
  identity?: VideoDetailPayload['detail']['identity']
  label?: string
}) {
  const { t } = useTranslation()
  const tmdbId = identity?.externalIds?.tmdb
  // series/season/episode 的 tmdb id 都是那部剧的 id → /tv；其余（movie/unknown/缺省）→ /movie。
  const isTv = identity?.kind === 'series' || identity?.kind === 'season' || identity?.kind === 'episode'
  const href = tmdbId ? tmdbWorkUrl(isTv ? 'tv' : 'movie', tmdbId) : url
  if (!href) return null
  const text = label ?? (tmdbId ? t('movie.viewOnTmdb') : t('movie.viewOriginal'))
  return <a href={href} target="_blank" rel="noreferrer" aria-label={text} title={text} className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground"><ExternalLink className="size-4" /></a>
}

type Person = NonNullable<NonNullable<VideoDetailPayload['detail']['metadata']>['people']>[number]

/** A cast member tile with an overlay caption — name/role float over the portrait on a
 *  bottom scrim (acrylic Card gallery "overlay" variant) rather than sitting below it.
 *  Inert by design: unlike a movie poster there is no person page to open. Hover keeps the
 *  soft float shadow WITHOUT a lift (the shared cover-tile treatment), so it reads as an
 *  inert tile, not a clickable one. */
const CAST_HOVER_FLOAT =
  'before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-xl ' +
  'before:shadow-[0_12px_28px_rgba(0,0,0,0.28)] before:opacity-0 before:transition-opacity ' +
  'before:[transition-timing-function:var(--acr-spring-default)] before:[transition-duration:var(--acr-spring-default-duration)] hover:before:opacity-100'

function PersonCard({ person, baseUrl }: { person: Person; baseUrl: string }) {
  const subtitle = person.character ?? person.role
  return (
    <Card className={cn('overflow-hidden p-0', CAST_HOVER_FLOAT)}>
      <CardMedia
        ratio="2 / 3"
        src={person.image ? imgUrl(baseUrl, person.image) : undefined}
        alt={person.name}
        fallback={<UserRound className="size-8" />}
      >
        <CardMediaOverlay>
          <CardTitle>{person.name}</CardTitle>
          {subtitle && <CardDescription>{subtitle}</CardDescription>}
        </CardMediaOverlay>
      </CardMedia>
    </Card>
  )
}

/** 演职员 reads as a ranking row: same horizontal, page-able Rail, same tile width. Cast is shown
 *  whole rather than cut to a first dozen — billing order already puts the leads first, and the
 *  rail pages past the long tail instead of hiding it. Tiles use the overlay caption variant. */
function CastGallery({ people, baseUrl }: { people?: Person[]; baseUrl: string }) {
  const { t } = useTranslation()
  if (!people?.length) return null
  return (
    <Rail title={t('movie.credits')} count={people.length}>
      {people.map((person, index) => (
        <div key={person.name + ':' + person.role + ':' + index} className="w-[160px] shrink-0">
          <PersonCard person={person} baseUrl={baseUrl} />
        </div>
      ))}
    </Rail>
  )
}

/**
 * 详情页上的「继续播放」——上次看到哪一集,就从哪一集接着放。
 *
 * 这颗按钮是「继续观看」墙那张卡的**下半程**:卡片只负责把人送到作品详情页(见
 * `continueWatchingRoute` 头注),真正起播在这里。所以它排在动作行最前——一个刚看过一半的作品,
 * 用户来这一页十有八九就是为了接着看。
 *
 * 三个详情页(WorkDetail / RankingDetail / TmdbWorkDetail)共用这一颗,不各画一遍:按钮长什么样、
 * 带不带集号,是同一件事。
 */
function ResumeButton({ row, onResume }: { row: WatchProgressRow; onResume: (row: WatchProgressRow) => void }) {
  const { t } = useTranslation()
  return (
    <Button type="button" size="small" onClick={() => onResume(row)}>
      <Play className="size-3.5 fill-current" /> {row.epLabel ? t('movie.resumePlayEp', { ep: row.epLabel }) : t('movie.resumePlay')}
    </Button>
  )
}

/** 续播那一集的播放源。`resumeUrlFor` 是唯一算 `?key=` / `?id=` 的地方,调用点不许自己再判一次。 */
function resumeMedia(row: WatchProgressRow, posterUrl?: string): VideoMedia {
  return { kind: 'video', url: resumeUrlFor(row), poster: posterUrl, resolveOnly: true }
}

/**
 * 续播时喂给 `buildServerProgress` 的身份覆盖——**直接用这一行自己的 workKey/epLabel**,不从
 * `row.key` 反推。反推只对 leftKey 成立;`stream:` 那一档的 key 是不透明 inbox id,反推出来的
 * workKey 会让每一集各自成一个"作品",下一次心跳就把这一行的身份写坏了(见 buildServerProgress
 * 头注)。行里已经存着服务端算好的身份,原样带回去是唯一不会漂的做法。
 */
function resumeProgressOverride(row: WatchProgressRow): { workKey: string; epLabel?: string } {
  return { workKey: row.workKey, epLabel: row.epLabel }
}

function RankingDetail({ item, channelId, watchProgress, conn, onBack, onCollectedChanged, onPlaybackClosed }: {
  item: Item
  /** 播放进度记在哪个频道名下（见 buildServerProgress）。 */
  channelId?: string
  /** 本屏「继续观看」的全部行——这一页自己按它播放时写下的 workKey 去认领其中一条（见
   *  `findResumeRow`），认到就出「继续播放」。 */
  watchProgress: WatchProgressRow[]
  conn: Connection
  onBack: () => void
  /** fires when this work's membership in「正在追的」changes — only meaningful once `work.ref`
   *  resolves a verified TMDb id (see the CollectButton gate below); a plain discovery row with
   *  no canonical identity has nothing collectible about it yet. */
  onCollectedChanged: (item: { id: string; media: 'movie' | 'tv'; title: string; poster?: string }, member: boolean) => void
  /** fires when the fullscreen player closes — lets the caller (MovieChannel) refresh the
   *  「继续观看」shelf, which otherwise only fetches once on mount and would keep showing a
   *  stale/missing state for the rest of the session. */
  onPlaybackClosed?: () => void
}) {
  const { t } = useTranslation()
  const [payload, setPayload] = useState<VideoDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [finding, setFinding] = useState<string | null>(null)
  // `progressOverride`: 续播入口专用——它的身份直接来自「继续观看」那一行，不从 itemId 反推
  // （见 resumeProgressOverride 头注）。页面自己的播放按钮/分集卡不设，itemId 本就是 leftKey。
  const [playing, setPlaying] = useState<{ media: VideoMedia; itemId?: string; progressOverride?: { workKey: string; epLabel?: string } } | null>(null)
  // 绑定建完要重取详情——绑定状态是后端算的（配上几集），不能靠前端猜。
  const [nonce, setNonce] = useState(0)
  const reload = () => setNonce((n) => n + 1)
  // The player covers this page and owns Esc while it is open.
  useEscape(onBack, !playing)

  useEffect(() => {
    let live = true
    setLoading(true)
    fetch(conn.baseUrl + '/api/video/works/item:' + encodeURIComponent(item.id), {
      headers: conn.token ? { Authorization: 'Bearer ' + conn.token } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('detail unavailable')
        return response.json() as Promise<{ detail: VideoDetailPayload['detail']; binding?: WorkBindingView; seasons?: SeasonGroup[] }>
      })
      .then((value) => { if (live) setPayload({ episodes: [], detail: value.detail, binding: value.binding, seasons: value.seasons }) })
      .catch(() => { if (live) setPayload(null) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [conn.baseUrl, conn.token, item.id, nonce])

  // 强制刷新：绕过 video_details 缓存重新取一遍（分季分集索引缓存也会跟着这次写清、下次懒加载
  // 重抓——见 detail-service.ts mergeVideoDetail 不带 episodeIndex，是「未播出」判定吃得到新数据
  // 的唯一入口，不只是刷元数据）。
  const forceRefresh = async () => {
    setRefreshing(true)
    try {
      const response = await fetch(conn.baseUrl + '/api/video/works/item:' + encodeURIComponent(item.id) + '/refresh', {
        method: 'POST', headers: conn.token ? { Authorization: 'Bearer ' + conn.token } : undefined,
      })
      if (!response.ok) throw new Error('detail unavailable')
      const value = await response.json() as { detail: VideoDetailPayload['detail']; binding?: WorkBindingView; seasons?: SeasonGroup[] }
      setPayload({ episodes: [], detail: value.detail, binding: value.binding, seasons: value.seasons })
    } catch {
      // 保留上一份已渲染的 payload——刷新失败不该让页面变空。
    } finally {
      setRefreshing(false)
    }
  }

  const detail = payload?.detail
  const metadata = detail?.metadata
  const title = metadata?.title ?? item.title
  const posterUrl = detail?.images.poster?.url ?? poster(item)
  const backdropUrl = detail?.images.backdrop?.url
  const facts = [metadata?.year ?? item.content?.meta?.year, metadata?.runtimeMinutes ? t('movie.runtimeMinutes', { n: metadata.runtimeMinutes }) : undefined].filter(Boolean)
  const rating = metadata?.ratings?.[0] ?? (item.videoDetail?.rating != null ? { value: item.videoDetail.rating, scale: 10, source: 'tmdb' } : item.content?.meta?.rating ? { value: Number(item.content.meta.rating), scale: 10, source: item.content.meta.sourceLabel ?? item.content.meta.source ?? '' } : undefined)
  const overview = metadata?.overview ?? item.content?.text ?? item.body_text
  const genres = metadata?.genres?.length ? metadata.genres : item.content?.meta?.genres
  // 后端发现兜底的 source 是 `<normalizer 自报的来源>-discovery`（src/video/discovery-fallback.ts），按后缀认。
  const isDiscoveryFallback = !!metadata?.source?.endsWith('-discovery')
  // 这一页播放时写进度用的是 leftKey（`tmdb:<id>[:SxxEyy]`），所以它的进度行只会挂在
  // `tmdb:<ref.id>` 名下——榜单条目自己的 item id 不是任何一条进度的身份。
  const resumeRow = findResumeRow(watchProgress, [payload?.binding?.ref ? 'tmdb:' + payload.binding.ref.id : undefined])
  // 作品级绑定配上的条目（电影 1 条）→ 直接播。leftKey 喂 resolve?key=，播放侧键无关。
  const firstPlayable = payload?.binding?.binding?.playable?.[0]
  const playable: VideoMedia | undefined = firstPlayable
    ? { kind: 'video', url: '/api/media/videos/resolve?key=' + encodeURIComponent(firstPlayable.leftKey), poster: posterUrl, resolveOnly: true }
    : undefined

  return (
    <div className="flex flex-col gap-5">
      <header className="relative isolate -mx-5 -mt-5 flex min-h-[24rem] flex-col justify-end overflow-hidden bg-muted/40 px-5 pb-8 pt-16 sm:min-h-[28rem] sm:px-8 sm:pb-12 sm:pt-16">
        {backdropUrl && <img src={imgUrl(conn.baseUrl, backdropUrl)} alt="" className="absolute inset-0 -z-10 size-full object-cover object-top opacity-45" />}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-background/85 to-background/15" />
        <div className="flex items-start gap-4 sm:gap-5">
          <div className="w-28 shrink-0 overflow-hidden rounded-xl bg-muted shadow-lg ring-1 ring-white/10 sm:w-40">
            {posterUrl ? <img src={imgUrl(conn.baseUrl, posterUrl)} alt="" className="aspect-[2/3] size-full object-cover" /> : <div className="flex aspect-[2/3] items-center justify-center text-muted-foreground"><Film className="size-8" /></div>}
          </div>
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-center gap-1"><h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">{title}</h1><OriginalLink url={item.url} identity={detail?.identity} /></div>
            {metadata?.originalTitle && metadata.originalTitle !== title && <p className="mt-1 text-[13px] text-muted-foreground">{metadata.originalTitle}</p>}
            {facts.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] tabular-nums text-muted-foreground">{facts.map((fact) => <span key={String(fact)}>{fact}</span>)}</div>}
            {rating && <div className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-amber-500"><Star className="size-3.5 fill-current" /> {rating.value.toFixed(1)} <span className="font-normal text-muted-foreground">/ {rating.scale} · {rating.source.toUpperCase()}</span></div>}
            {overview && <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{overview}</p>}
            {genres?.length ? <div className="mt-3 flex flex-wrap gap-1.5">{genres.map((genre) => <span key={genre} className="rounded-full bg-foreground/8 px-2 py-0.5 text-[11px] text-muted-foreground">{genre}</span>)}</div> : null}
            {/* 榜单条目本就一份拷贝都没有——「想看但没有」正是找资源存在的理由，
                所以这里比剧集页更需要这个入口。 */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {/* 收藏排最前——只有 ref 验出了 tmdb 坐标才有东西可收(见 CollectedItemKey 头注,
                  纯发现层数据没有可收藏的稳定身份)。 */}
              {payload?.binding?.ref && (
                <CollectButton
                  conn={conn}
                  domain="video"
                  itemKey={{ kind: 'tmdb', id: payload.binding.ref.id, media: payload.binding.ref.media }}
                  meta={{ title: payload.binding.ref.title, poster: posterUrl }}
                  onChanged={(collectionId, member) => {
                    if (collectionId === SYSTEM_COLLECTIONS.videoFollowing && payload?.binding?.ref) {
                      onCollectedChanged({ id: payload.binding.ref.id, media: payload.binding.ref.media, title: payload.binding.ref.title, poster: posterUrl }, member)
                    }
                  }}
                />
              )}
              {/* 看过一半 → 接着看。排在「播放」之前：有进度时"从头播"几乎不是用户想要的那一下。 */}
              {resumeRow && <ResumeButton row={resumeRow} onResume={(row) => setPlaying({ media: resumeMedia(row, posterUrl), itemId: row.key, progressOverride: resumeProgressOverride(row) })} />}
              {/* 绑定配上了 → 直接能播：这一步是整条链路的终点，按钮排在最前。 */}
              {playable && (
                <Button type="button" size="small" onClick={() => setPlaying({ media: playable, itemId: firstPlayable?.leftKey })}>
                  <Play className="size-3.5 fill-current" /> {t('movie.play')}
                </Button>
              )}
              <Button type="button" variant="neutral" size="small" onClick={() => void forceRefresh()} disabled={refreshing}>{refreshing ? <Loader2 className="animate-spin" /> : t('movie.refreshDetail')}</Button>
              <Button type="button" variant="neutral" size="small" onClick={() => setFinding(title)}>{t('video.findResource')}</Button>
              {/* 绑定入口紧挨着「找资源」：找到资源 → 转存 → 绑定 是同一件事的三步，
                  把最后一步藏进别的页面，用户就走不完这条路。 */}
              {payload?.binding && <WorkBinding conn={conn} work={payload.binding} onChanged={reload} />}
              {loading && <span className="text-[12px] text-muted-foreground">{t('movie.loadingMetadata')}</span>}
            </div>
            {!loading && !metadata && <p className="mt-4 text-[12px] text-muted-foreground">{t('movie.noVerifiedMetadata')}</p>}
            {isDiscoveryFallback && <p className="mt-4 text-[12px] text-muted-foreground">{t('movie.discoveryFallback')}</p>}
          </div>
        </div>
      </header>
      {detail?.failures.length && !isDiscoveryFallback ? <p className="text-[12px] text-muted-foreground">{t('movie.partialUnavailable')}</p> : null}
      {payload?.seasons?.length ? (
        <section className="flex flex-col gap-3"><h2 className="text-[15px] font-semibold">{t('movie.episodesSection')}</h2>
          <SeasonEpisodeList seasons={payload.seasons} workTitle={title} baseUrl={conn.baseUrl} onPlay={(m, id) => setPlaying({ media: m, itemId: id })} onFindResource={setFinding} />
        </section>
      ) : null}
      <CastGallery people={metadata?.people} baseUrl={conn.baseUrl} />
      <ResourceFinderSheet open={!!finding} conn={conn} query={finding ?? ''} onClose={() => setFinding(null)} work={payload?.binding} onBound={reload} />
      {playing && (
        <FullscreenEpisodePlayer
          media={playing.media}
          itemId={playing.itemId}
          baseUrl={conn.baseUrl}
          onClose={() => { setPlaying(null); onPlaybackClosed?.() }}
          serverProgress={buildServerProgress(playing.itemId, title, posterUrl, conn, channelId, playing.progressOverride)}
          episodes={payload?.seasons?.length ? seasonsToPickerEpisodes(payload.seasons, conn.baseUrl) : undefined}
          onPickEpisode={(ep) => ep.media && setPlaying({ media: ep.media, itemId: ep.key })}
        />
      )}
    </div>
  )
}

/**
 * 收藏-by-tmdb-id 的详情页——「奥德赛」这类纯榜单作品(无 Stream)收藏后从「正在追的」网格点进来
 * 走这条路,而不是 RankingDetail(那条永远要从一个当次抓取里的 Item 进入)。同构 RankingDetail 的
 * hero+分集区布局,区别只是身份直接来自 tmdb id/media(见 /api/video/works/tmdb:<media>:<id>),
 * 不依赖任何 Item——收藏的作品哪怕从当日榜单滚出去了,详情页依然打得开。
 * `titleHint`/`posterHint`:从网格卡片点进来时,收藏快照里已经有 title/poster,首帧直接显示、不用
 * 等一轮 fetch 才出现文字；深链刷新进来时缺省,回落 tmdb id 直到 fetch 回来。
 */
function TmdbWorkDetail({ id, media, titleHint, posterHint, channelId, watchProgress, conn, onBack, onCollectedChanged, onPlaybackClosed }: {
  id: string
  media: 'movie' | 'tv'
  titleHint?: string
  posterHint?: string
  /** 播放进度记在哪个频道名下（见 buildServerProgress）。纯 tmdb 收藏没有流可反查，聚合入口下为空。 */
  channelId?: string
  /** see RankingDetail's doc —— 这一页据此认领自己那条进度行，出「继续播放」。 */
  watchProgress: WatchProgressRow[]
  conn: Connection
  onBack: () => void
  onCollectedChanged: (item: { id: string; media: 'movie' | 'tv'; title: string; poster?: string }, member: boolean) => void
  /** see RankingDetail's doc — refreshes the 「继续观看」shelf on player close. */
  onPlaybackClosed?: () => void
}) {
  const { t } = useTranslation()
  const [payload, setPayload] = useState<VideoDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [finding, setFinding] = useState<string | null>(null)
  // `progressOverride`: 续播入口专用——它的身份直接来自「继续观看」那一行，不从 itemId 反推
  // （见 resumeProgressOverride 头注）。页面自己的播放按钮/分集卡不设，itemId 本就是 leftKey。
  const [playing, setPlaying] = useState<{ media: VideoMedia; itemId?: string; progressOverride?: { workKey: string; epLabel?: string } } | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = () => setNonce((n) => n + 1)
  // The player covers this page and owns Esc while it is open.
  useEscape(onBack, !playing)

  useEffect(() => {
    let live = true
    setLoading(true)
    const q = titleHint ? '?title=' + encodeURIComponent(titleHint) : ''
    fetch(conn.baseUrl + '/api/video/works/tmdb:' + media + ':' + encodeURIComponent(id) + q, {
      headers: conn.token ? { Authorization: 'Bearer ' + conn.token } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('detail unavailable')
        return response.json() as Promise<{ detail: VideoDetailPayload['detail']; binding?: WorkBindingView; seasons?: SeasonGroup[] }>
      })
      .then((value) => { if (live) setPayload({ episodes: [], detail: value.detail, binding: value.binding, seasons: value.seasons }) })
      .catch(() => { if (live) setPayload(null) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.baseUrl, conn.token, media, id, nonce])

  // 封面快照自愈:点「收藏」那一刻 detail 还没回来/TMDB 图片源瞬时失败,快照就永久落了空 poster
  // (store.ts addItem 只在"再收藏一次"时刷新,没有别的回填路径)。这次 detail 解出了真封面 →
  // 已收藏且快照缺 poster 就静默补一次 addToCollection(幂等 upsert 只刷快照、不动归属),并回调
  // 网格立即换图。healedKey 防同一次停留反复打;失败不重试(下次进详情页天然重来)。
  const healedKey = useRef<string | null>(null)
  useEffect(() => {
    const posterNow = payload?.detail?.images.poster?.url
    const workKey = `${media}:${id}`
    if (loading || !posterNow || healedKey.current === workKey) return
    healedKey.current = workKey
    const freshTitle = payload?.detail?.metadata?.title
      ?? (payload?.detail?.canonical?.status === 'resolved' ? payload.detail.canonical.title : undefined)
      ?? titleHint ?? id
    void api.whereCollected(conn, { kind: 'tmdb', id, media })
      .then(({ item, collectionIds }) => {
        if (!item || item.poster || !collectionIds.length) return
        return api.addToCollection(conn, collectionIds[0], { kind: 'tmdb', id, media }, { title: freshTitle, poster: posterNow })
          .then(() => {
            // 只有真在「正在追的」里才通知网格换图——只进了自建列表的作品不该被这回调加进网格。
            if (collectionIds.includes(SYSTEM_COLLECTIONS.videoFollowing)) onCollectedChanged({ id, media, title: freshTitle, poster: posterNow }, true)
          })
      })
      .catch(() => { /* best-effort——自愈失败不影响页面 */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, payload, conn, id, media])

  // 强制刷新：绕过 video_details 缓存重新取一遍（分季分集索引缓存也跟着这次写清、下次懒加载
  // 重抓——见 RankingDetail 同名函数的注释）。
  const forceRefresh = async () => {
    setRefreshing(true)
    const q = titleHint ? '?title=' + encodeURIComponent(titleHint) : ''
    try {
      const response = await fetch(conn.baseUrl + '/api/video/works/tmdb:' + media + ':' + encodeURIComponent(id) + '/refresh' + q, {
        method: 'POST', headers: conn.token ? { Authorization: 'Bearer ' + conn.token } : undefined,
      })
      if (!response.ok) throw new Error('detail unavailable')
      const value = await response.json() as { detail: VideoDetailPayload['detail']; binding?: WorkBindingView; seasons?: SeasonGroup[] }
      setPayload({ episodes: [], detail: value.detail, binding: value.binding, seasons: value.seasons })
    } catch {
      // 保留上一份已渲染的 payload——刷新失败不该让页面变空。
    } finally {
      setRefreshing(false)
    }
  }

  const detail = payload?.detail
  const metadata = detail?.metadata
  // metadata 是个独立能力,可能整体没拿到(如 tmdb-metadata 一时抽风、omdb 无匹配)——但 canonical 解析
  // 本身几乎总能带回真实标题,比直接落回数字 id 靠谱得多;titleHint/id 只在两者都没有时才用。
  const title = metadata?.title ?? (detail?.canonical?.status === 'resolved' ? detail.canonical.title : undefined) ?? titleHint ?? id
  const posterUrl = detail?.images.poster?.url ?? posterHint
  const backdropUrl = detail?.images.backdrop?.url
  const facts = [metadata?.year, metadata?.runtimeMinutes ? t('movie.runtimeMinutes', { n: metadata.runtimeMinutes }) : undefined].filter(Boolean)
  const rating = metadata?.ratings?.[0]
  const overview = metadata?.overview
  const genres = metadata?.genres
  const firstPlayable = payload?.binding?.binding?.playable?.[0]
  const playable: VideoMedia | undefined = firstPlayable
    ? { kind: 'video', url: '/api/media/videos/resolve?key=' + encodeURIComponent(firstPlayable.leftKey), poster: posterUrl, resolveOnly: true }
    : undefined
  // 身份就是路由上的这个 tmdb id——这一页所有播放入口写下的 workKey 都是它。
  const resumeRow = findResumeRow(watchProgress, ['tmdb:' + id])

  return (
    <div className="flex flex-col gap-5">
      <header className="relative isolate -mx-5 -mt-5 flex min-h-[24rem] flex-col justify-end overflow-hidden bg-muted/40 px-5 pb-8 pt-16 sm:min-h-[28rem] sm:px-8 sm:pb-12 sm:pt-16">
        {backdropUrl && <img src={imgUrl(conn.baseUrl, backdropUrl)} alt="" className="absolute inset-0 -z-10 size-full object-cover object-top opacity-45" />}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-background/85 to-background/15" />
        <div className="flex items-start gap-4 sm:gap-5">
          <div className="w-28 shrink-0 overflow-hidden rounded-xl bg-muted shadow-lg ring-1 ring-white/10 sm:w-40">
            {posterUrl ? <img src={imgUrl(conn.baseUrl, posterUrl)} alt="" className="aspect-[2/3] size-full object-cover" /> : <div className="flex aspect-[2/3] items-center justify-center text-muted-foreground"><Film className="size-8" /></div>}
          </div>
          <div className="min-w-0 flex-1 pt-1">
            {/* 纯 tmdb-id 收藏没有 harvest 来源 URL 可"查看原始条目"——链接改指向 TMDB 自己的页面,
                id/media 是 props 直传的收藏坐标,不依赖 detail fetch,任何时候都能拼。 */}
            <div className="flex items-center gap-1"><h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">{title}</h1><OriginalLink url={tmdbWorkUrl(media, id)} label={t('movie.viewOnTmdb')} /></div>
            {metadata?.originalTitle && metadata.originalTitle !== title && <p className="mt-1 text-[13px] text-muted-foreground">{metadata.originalTitle}</p>}
            {facts.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] tabular-nums text-muted-foreground">{facts.map((fact) => <span key={String(fact)}>{fact}</span>)}</div>}
            {rating && <div className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-amber-500"><Star className="size-3.5 fill-current" /> {rating.value.toFixed(1)} <span className="font-normal text-muted-foreground">/ {rating.scale} · {rating.source.toUpperCase()}</span></div>}
            {overview && <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{overview}</p>}
            {genres?.length ? <div className="mt-3 flex flex-wrap gap-1.5">{genres.map((genre) => <span key={genre} className="rounded-full bg-foreground/8 px-2 py-0.5 text-[11px] text-muted-foreground">{genre}</span>)}</div> : null}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {/* 首次加载完成前 title/posterUrl 全靠 titleHint/posterHint 兜底(深链进来时两者常常
                  缺省)——点了收藏会把这份不完整快照永久写死(store.ts addItem 只在"再点一次"时才刷新),
                  故等 detail 落地后再让按钮出现,避免抢在 fetch 前提交一份坏快照。 */}
              {!loading && (
                <CollectButton
                  conn={conn}
                  domain="video"
                  itemKey={{ kind: 'tmdb', id, media }}
                  meta={{ title, poster: posterUrl }}
                  onChanged={(collectionId, member) => {
                    if (collectionId === SYSTEM_COLLECTIONS.videoFollowing) onCollectedChanged({ id, media, title, poster: posterUrl }, member)
                  }}
                />
              )}
              {/* 看过一半 → 接着看（同 RankingDetail：有进度时"从头播"几乎不是用户想要的那一下）。 */}
              {resumeRow && <ResumeButton row={resumeRow} onResume={(row) => setPlaying({ media: resumeMedia(row, posterUrl), itemId: row.key, progressOverride: resumeProgressOverride(row) })} />}
              {playable && (
                <Button type="button" size="small" onClick={() => setPlaying({ media: playable, itemId: firstPlayable?.leftKey })}>
                  <Play className="size-3.5 fill-current" /> {t('movie.play')}
                </Button>
              )}
              <Button type="button" variant="neutral" size="small" onClick={() => void forceRefresh()} disabled={refreshing}>{refreshing ? <Loader2 className="animate-spin" /> : t('movie.refreshDetail')}</Button>
              <Button type="button" variant="neutral" size="small" onClick={() => setFinding(title)}>{t('video.findResource')}</Button>
              {/* 引用这部作品到对话。摆在动作行里而不是右键菜单：详情页上"我正看着的就是它"
                  没有歧义，而右键在这一页要找目标（海报？标题？），反而绕。 */}
              <Button type="button" variant="neutral" size="small" onClick={() => void referenceWork({ id, media, title })}>
                <MessageSquareQuote className="size-3.5" /> {t('movie.referenceInChat')}
              </Button>
              {payload?.binding && <WorkBinding conn={conn} work={payload.binding} onChanged={reload} />}
              {loading && <span className="text-[12px] text-muted-foreground">{t('movie.loadingMetadata')}</span>}
            </div>
            {/* 纯 tmdb-id 收藏没有 stream.synopsis/item 兜底——不能用 noVerifiedMetadata 那句"当前显示
                发现源提供的信息",这里压根没有发现源信息可显示,那句话对这个页面是假话。 */}
            {!loading && !metadata && <p className="mt-4 text-[12px] text-muted-foreground">{t('movie.noVerifiedMetadataBare')}</p>}
          </div>
        </div>
      </header>
      {detail?.failures.length ? <p className="text-[12px] text-muted-foreground">{t('movie.partialUnavailable')}</p> : null}
      {payload?.seasons?.length ? (
        <section className="flex flex-col gap-3"><h2 className="text-[15px] font-semibold">{t('movie.episodesSection')}</h2>
          <SeasonEpisodeList seasons={payload.seasons} workTitle={title} baseUrl={conn.baseUrl} onPlay={(m, id) => setPlaying({ media: m, itemId: id })} onFindResource={setFinding} />
        </section>
      ) : null}
      <CastGallery people={metadata?.people} baseUrl={conn.baseUrl} />
      <ResourceFinderSheet open={!!finding} conn={conn} query={finding ?? ''} onClose={() => setFinding(null)} work={payload?.binding} onBound={reload} />
      {playing && (
        <FullscreenEpisodePlayer
          media={playing.media}
          itemId={playing.itemId}
          baseUrl={conn.baseUrl}
          onClose={() => { setPlaying(null); onPlaybackClosed?.() }}
          serverProgress={buildServerProgress(playing.itemId, title, posterUrl, conn, channelId, playing.progressOverride)}
          episodes={payload?.seasons?.length ? seasonsToPickerEpisodes(payload.seasons, conn.baseUrl) : undefined}
          onPickEpisode={(ep) => ep.media && setPlaying({ media: ep.media, itemId: ep.key })}
        />
      )}
    </div>
  )
}

/** 详情外壳右侧插槽在**影视调用态**下的内容：这一集谁在说话、此刻是谁在说、他的发言段在哪、
 *  点一下跳过去、只看某几个人、以及把匿名簇认成一个人。
 *  时间线那边的插槽放帖子正文/评论/转写——同一个框架、不同的面板内容。
 *
 *  设计取向（acrylic + Apple）：
 *  - **身份先于文字**：每人一个 `speakerColor(label)` 色点，和播放器进度条上的跳转点**同一套色**，
 *    列表和画面对得上。没认过的簇不显示 `SPEAKER_03` 这种机器名，显示「说话人 3」。
 *  - **跟着播放走**：`speakingAt` 判出此刻在说话的人，那一行升到 `--acr-surface-hover` 并戴本人色的环
 *    （Apple 的「反馈要连续」）。顺序始终按发言时长排，不随播放重排——位置不跳 = 空间一致性。
 *  - **状态要看得见**：「只看」是一个明确的开关药丸（选中=实心 default，未选=ghost），不再靠
 *    「把没选中的人调暗」反着暗示。仍保留双击=只看TA一人，但写进抬头说明里，不再只藏在 title 里。
 *  - **发言段画成条，不是一排数字**：每人一条迷你时间轴（整条=全片时长，自己的段染本人色，
 *    带播放头），点段跳转。话多的人不再糊成一团时间戳。
 *  - 过渡走 `--acr-spring-default`（`prefers-reduced-motion` 由令牌层统一兜住）。
 *    注：旧代码写的 `--acr-spring-smooth` 在主题里并不存在，过渡其实一直没生效。 */
/** 迷你时间轴上的一个热区（段首 / 段尾 / 短段整段）+ **秒出**的时间提示。
 *
 *  时间提示不能用原生 `title`：浏览器固定要悬停约一秒才显示，而这条轴的用法是沿着一行来回扫
 *  「这段在几分几秒」——每次都等一秒，等于没有。acrylic 的 `Tooltip` 走 Radix，`delayDuration`
 *  默认 0，指过去就出。两者只能留一个，同时挂会先出 Radix、一秒后再叠一个原生的。
 *  可读名字仍在 `aria-label` 上（tooltip 内容对读屏是装饰）。 */
function SegmentZone({ tip, label, onClick, className, style }: {
  tip: string
  label: string
  onClick: () => void
  className: string
  style: CSSProperties
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} className={className} style={style} />
      </TooltipTrigger>
      <TooltipContent side="top" className="tabular-nums">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

export function SpeakerSegmentPanel({ itemId, map, onSeek, currentTime, duration }: {
  itemId: string
  map: ReturnType<typeof useSpeakerMap>
  onSeek: (seconds: number) => void
  /** 播放头位置 / 全片时长，由 ArtPlayer 的 `onTime` 节流喂上来。0 = 还不知道（未加载元数据）。 */
  currentTime: number
  duration: number
}) {
  const [identifying, setIdentifying] = useState(false)
  const [persons, setPersons] = useState<VoicePerson[]>([])
  const [naming, setNaming] = useState<string | null>(null) // 正开着认人浮层的那个 label
  const [confirmOpen, setConfirmOpen] = useState(false) // 重新识别的确认框
  const [job, setJob] = useState<Conversion | null>(null) // 本集最近一次 identify
  const [pollKey, setPollKey] = useState(0) // 排队成功后 +1，重新拉起轮询
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const jobRunning = job?.status === 'queued' || job?.status === 'running'

  // 认人所需的两份参照：本集的簇（谁已经认过了）+ 人物库（能认成谁）。两者都可能 503
  // （后端没配声纹库）——那时静默降级成「只有色点和时长、不能认人」，面板其余功能不受影响。
  // 认领状态（谁已经是谁）由 useSpeakerMap 统一持有——两个界面共用同一份名字。这里只要
  // 人物库：认人浮层得列出「能认成谁」。声纹库没配就是空库，浮层退化成「只能新建」。
  const reloadPersons = useCallback(async () => {
    try {
      setPersons(await api.voiceprint.listPersons(LOCAL))
    } catch {
      setPersons([])
    }
  }, [])
  useEffect(() => {
    void reloadPersons()
  }, [reloadPersons])

  /** `map.refresh` 每次渲染都是新函数，不能进下面那个 effect 的依赖（会把轮询打断重启）。 */
  const refreshRef = useRef(map.refresh)
  refreshRef.current = map.refresh

  // 识别是分钟级的异步活儿，而 `/clusters` 不带状态——要知道「现在是不是在跑」只能问
  // `/api/conversions`（memory 有档：轮 /clusters 会秒退）。轮它换来两件事：
  //   1. 重开面板也能看到「识别中」，不会因为看不见而重复点（后端会 409，但那是事后拦）；
  //   2. 跑完自动把名单/色段换成新结果——原来只能靠文案「完成后重开即可看到」。
  // 只在**跑着的时候**轮（5s）；不在跑就问一次然后停，不留常驻定时器。
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let wasRunning = false
    const tick = async () => {
      let latest: Conversion | null = null
      try {
        latest = await api.conversions.latest(LOCAL, itemId, 'identify')
      } catch {
        // 后端没配声纹库 / 暂时不可达 → 静默降级（与 reloadPersons 同一策略），面板其余功能照用
      }
      if (!alive) return
      setJob(latest)
      const running = latest?.status === 'queued' || latest?.status === 'running'
      if (wasRunning && !running) {
        if (latest?.status === 'done') {
          refreshRef.current()
          toast.success('识别完成', { description: '名单与进度条色段已换成新结果' })
        } else if (latest?.status === 'error') {
          toast.error('识别失败', { description: latest.error?.message ?? '' })
        }
      }
      wasRunning = running
      if (running) timer = setTimeout(tick, 5000)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [itemId, pollKey])

  const runIdentify = async () => {
    setIdentifying(true)
    try {
      await api.voiceprint.recluster(LOCAL, itemId)
      setConfirmOpen(false)
      toast.success('已排队识别本集说话人', { description: '要几分钟，跑完这里会自己换成新结果' })
      setPollKey((n) => n + 1)
    } catch (err) {
      // 409 = 这条已经有识别/转写在跑（后端显式区分了「没配」503 和「有活儿」409）——
      // 它不是失败，是「已经在做了」，混进通用错误文案会让人以为要重试。
      if (err instanceof ApiError && err.status === 409) {
        setConfirmOpen(false)
        setPollKey((n) => n + 1)
        toast.info('本集已有识别任务在跑', { description: '跑完这里会自己换成新结果' })
      } else {
        toast.error('识别启动失败', { description: err instanceof ApiError ? err.message : '' })
      }
    } finally {
      setIdentifying(false)
    }
  }

  /** 认成某个人：enroll 会把存储转写里的簇标签**改名**成人名，所以要让 map 重读——
   *  `refresh()` 会同时拉新的 blocks(新标签)和新的认领状态,面板与进度条一起换名。 */
  const enrollTo = async (label: string, personId: string) => {
    try {
      await api.voiceprint.enroll(LOCAL, itemId, label, personId)
      setNaming(null)
      map.refresh()
    } catch (err) {
      toast.error('认人失败', { description: err instanceof ApiError ? err.message : '' })
    }
  }
  const createAndEnroll = async (label: string, name: string) => {
    try {
      const created = await api.voiceprint.createPerson(LOCAL, name)
      await reloadPersons() // 新人物进库，下次浮层能搜到
      await enrollTo(label, created.id)
    } catch (err) {
      toast.error('新建人物失败', { description: err instanceof ApiError ? err.message : '' })
    }
  }

  /** 「不认」：否决这条待确认的抽名（同名同作品不再问）。认走的是既有 `createAndEnroll` 通道
   *  ——认下来就是一次普通的认人，没有第二套写路径。 */
  const rejectPendingName = async (label: string) => {
    try {
      await api.voiceprint.rejectPending(LOCAL, itemId, label)
      map.refresh()
    } catch (err) {
      toast.error('操作失败', { description: err instanceof ApiError ? err.message : '' })
    }
  }

  const speaking = speakingAt(map.blocks, currentTime)
  const totalSeconds = map.people.reduce((sum, p) => sum + p.seconds, 0)

  return (
    <div
      data-scroll-root
      data-nested-surface="true"
      className="scrollbar-mac h-full w-full overflow-y-auto bg-[var(--acr-panel)] backdrop-blur-xl"
    >
      <div className="flex flex-col gap-4 p-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-[15px] font-semibold leading-tight tracking-[-0.01em]">谁在说话</h2>
            <p className="text-[13px] leading-snug text-muted-foreground">
              {map.people.length ? '色段左半跳段首、右半跳段尾 · 「只看」筛选，双击只看TA一人' : '识别后这里列出每个人的发言段'}
            </p>
          </div>
          {/* 重新识别：识别过一次之后也要能再跑（改了阈值/门控/模型、或这一集分得不对）。
              以前入口只在「还没识别过」那个空状态里，跑过一次就再也点不到了。 */}
          {map.people.length > 0 && (
            <Button
              type="button"
              size="small"
              variant="ghost"
              disabled={identifying || jobRunning}
              onClick={() => setConfirmOpen(true)}
              className="shrink-0"
            >
              {identifying || jobRunning ? <Spinner size={14} /> : <RefreshCw />}
              {jobRunning ? (job?.status === 'queued' ? '排队中…' : '识别中…') : '重新识别'}
            </Button>
          )}
        </header>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>重新识别本集说话人？</AlertDialogTitle>
              <AlertDialogDescription>
                会从音频重跑一遍分段与聚类（几分钟，不重跑转写、不花转写的钱），本集现有的簇<strong>整份替换</strong>。
                已认过的人靠库里的声纹自动认回来；认不回的要再认一次。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={identifying}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={identifying}
                onClick={(e) => {
                  e.preventDefault()
                  void runIdentify()
                }}
              >
                {identifying ? '排队中…' : '重新识别'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {map.people.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] text-muted-foreground">这一集还没识别过说话人。</p>
            <Button type="button" size="small" variant="neutral" disabled={identifying} onClick={runIdentify}>
              {identifying ? <Spinner size={14} /> : <UserRound />}
              {identifying ? '排队中…' : '识别本集说话人'}
            </Button>
          </div>
        ) : (
          <ItemGroup className="gap-2">
            {map.people.map((p) => {
              const color = speakerColor(p.label)
              const selected = !!map.activeSpeakers?.includes(p.label)
              const filtering = !!map.activeSpeakers
              const isSpeaking = speaking === p.label
              const name = map.names[p.label] ?? p.label
              const needsName = map.unnamed.has(p.label)
              const segs = speakerSegments(p.blocks, duration)
              const pending = map.pending[p.label]
              const share = totalSeconds > 0 ? Math.round((p.seconds / totalSeconds) * 100) : 0
              return (
                <AcrylicItem
                  key={p.label}
                  variant="outline"
                  size="sm"
                  data-speaking={isSpeaking || undefined}
                  className={cn(
                    'flex-col items-stretch gap-2.5',
                    'transition-[opacity,background-color,box-shadow]',
                    '[transition-duration:var(--acr-spring-default-duration)] [transition-timing-function:var(--acr-spring-default)]',
                    // 正在说话：抬一档表面 + 戴本人色的环。用 ring 而不是 border——边框会挤动布局。
                    isSpeaking && 'bg-[var(--acr-surface-hover)] ring-1',
                    // 有筛选时，没被选中的人降透明度（次要信号；主信号是「只看」药丸本身的实心态）
                    filtering && !selected && 'opacity-45'
                  )}
                  style={isSpeaking ? ({ ['--tw-ring-color' as string]: color }) : undefined}
                >
                  {/* 一行：色点 · 名字 · 时长占比。**必须是 ItemRow 不是 ItemHeader**——acrylic 的
                      ItemHeader 本身就是 flex-col（给「标题在上、描述在下」用的），拿它当横排会把
                      三样东西摞成三层；ItemRow 才是横向那个。 */}
                  <ItemRow className="items-center gap-2.5">
                    {/* 身份色点：与播放器进度条上的跳转点同色。正在说话时外扩一圈同色光晕。 */}
                    <span className="relative flex size-2.5 shrink-0 items-center justify-center">
                      {isSpeaking ? (
                        <span
                          aria-hidden
                          className="absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
                          style={{ background: color }}
                        />
                      ) : null}
                      <span className="relative inline-flex size-2.5 rounded-full" style={{ background: color }} />
                    </span>

                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{name}</span>

                    <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                      {mmss(p.seconds)} · {share}%
                    </span>
                  </ItemRow>

                  {/* 待确认的抽名：自我介绍里抽到「X」但演职员表查无此人，不硬认，问一次。
                      证据（那句自我介绍）必须给出来——不看证据没法判断认不认。 */}
                  {pending ? (
                    <p className="text-[12px] leading-snug text-muted-foreground">
                      抽到「<span className="font-medium text-foreground">{pending.name}</span>
                      」，演职员表里没有——{pending.evidence}
                    </p>
                  ) : null}

                  {/* 迷你时间轴：整条 = 全片，自己的发言段染本人色，白线 = 播放头。
                      长段分成**左右两个热区**：左半跳段首、右半跳段尾（`segmentSeekPoints`）。
                      这两个落点服务的是「验这段切得连不连贯」——听头听尾，确认整段是同一个人、
                      边界没把别人切进来。段内任意定位不是这里的活（一条 200px 画满一集，
                      1px ≈ 18s，瞄不准），要精细定位就用播放器自己的进度条。 */}
                  {segs.length > 0 ? (
                    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-[var(--acr-chip)]">
                      {segs.map((s) => {
                        const { start, tail } = segmentSeekPoints(s)
                        const zone =
                          'absolute inset-y-0 transition-[filter] [transition-duration:var(--acr-spring-default-duration)] hover:brightness-125'
                        // 短段不分半：两个落点几乎重合，还会挤出两个 1px 的热区，只会点不准。
                        if (tail === null)
                          return (
                            <SegmentZone
                              key={s.start}
                              tip={mmss(start)}
                              label={`跳到 ${mmss(start)}`}
                              onClick={() => onSeek(start)}
                              className={cn(zone, 'rounded-full')}
                              style={{ left: `${s.leftPct}%`, width: `${s.widthPct}%`, background: color }}
                            />
                          )
                        return (
                          <Fragment key={s.start}>
                            <SegmentZone
                              tip={`开头 ${mmss(start)}`}
                              label={`跳到这段开头 ${mmss(start)}`}
                              onClick={() => onSeek(start)}
                              className={cn(zone, 'rounded-l-full')}
                              style={{ left: `${s.leftPct}%`, width: `${s.widthPct / 2}%`, background: color }}
                            />
                            <SegmentZone
                              tip={`结尾 ${mmss(s.end)}`}
                              label={`跳到这段结尾 ${mmss(s.end)}`}
                              onClick={() => onSeek(tail)}
                              className={cn(zone, 'rounded-r-full')}
                              style={{
                                left: `${s.leftPct + s.widthPct / 2}%`,
                                width: `${s.widthPct / 2}%`,
                                background: color,
                              }}
                            />
                          </Fragment>
                        )
                      })}
                      {duration > 0 ? (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-y-0 w-0.5 rounded-full bg-foreground/70 mix-blend-plus-lighter"
                          style={{ left: `${Math.min(100, (currentTime / duration) * 100)}%` }}
                        />
                      ) : null}
                    </div>
                  ) : (
                    /* 没有一个够长的连续块 → 上面那条时间轴画不出来。**空着不解释，用户看到的就是
                       一行莫名其妙的空白**（实测：喜剧之王 E02 十六行里有六行是空的）。理由跟
                       「只看」被禁用完全相同，就写在这里，不要只藏在按钮的 title 里。 */
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      发言零碎，没有可跳的整段
                    </p>
                  )}

                  <div className="flex items-center gap-1.5">
                    {/* 说得零碎的人（没有一个够长的连续块）在名单里，但「只看」对他无从跳起——
                        选中只会让播放器把整片跳空。禁掉，别给一个按下去就坏的按钮。 */}
                    <Button
                      type="button"
                      size="mini"
                      variant={selected ? 'default' : 'ghost'}
                      disabled={segs.length === 0}
                      onClick={() => map.toggleSpeaker(p.label)}
                      onDoubleClick={() => map.soloSpeaker(p.label)}
                      title={segs.length === 0 ? '他的发言太零碎，没有可跳的整段' : '点击=加入/移出「只看」，双击=只看TA一人'}
                      aria-pressed={selected}
                    >
                      {selected ? <Check /> : null}
                      只看
                    </Button>

                    {pending ? (
                      <>
                        <Button
                          type="button"
                          size="mini"
                          variant="neutral"
                          onClick={() => void createAndEnroll(p.label, pending.name)}
                        >
                          认
                        </Button>
                        <Button type="button" size="mini" variant="ghost" onClick={() => void rejectPendingName(p.label)}>
                          不认
                        </Button>
                      </>
                    ) : null}

                    {needsName ? (
                      <Popover
                        open={naming === p.label}
                        onOpenChange={(open) => setNaming(open ? p.label : null)}
                      >
                        <PopoverTrigger asChild>
                          <Button type="button" size="mini" variant="neutral">
                            <UserRoundPlus />
                            认成…
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-56 p-0">
                          <NamePicker
                            persons={persons}
                            onPick={(personId) => void enrollTo(p.label, personId)}
                            onCreate={(newName) => void createAndEnroll(p.label, newName)}
                          />
                        </PopoverContent>
                      </Popover>
                    ) : null}
                  </div>
                </AcrylicItem>
              )
            })}
          </ItemGroup>
        )}
      </div>
    </div>
  )
}

/** 认人浮层：搜人物库 + 就地新建。替掉原来的原生 `prompt()` 和裸 `<select>`。 */
function NamePicker({ persons, onPick, onCreate }: {
  persons: VoicePerson[]
  onPick: (personId: string) => void
  onCreate: (name: string) => void
}) {
  const [q, setQ] = useState('')
  const trimmed = q.trim()
  const exists = persons.some((p) => p.name === trimmed)
  return (
    <Command>
      <CommandInput placeholder="搜人物 / 输入新名字…" value={q} onValueChange={setQ} />
      <CommandList>
        {/* 有输入就永远给得出「新建」这条，所以只有空输入且人物库为空时才是真的空 */}
        <CommandEmpty>人物库是空的，输入名字即可新建。</CommandEmpty>
        {persons.length ? (
          <CommandGroup heading="人物库">
            {persons.map((p) => (
              <CommandItem key={p.id} value={p.name} onSelect={() => onPick(p.id)}>
                {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {trimmed && !exists ? (
          <CommandGroup>
            {/* value 里带上 q，cmdk 的过滤才不会把这条自己滤掉 */}
            <CommandItem value={`__new__ ${trimmed}`} onSelect={() => onCreate(trimmed)}>
              <UserRoundPlus />
              新建「{trimmed}」
            </CommandItem>
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  )
}

/** 播放侧键(`itemId`)拼成 serverProgress 配置——三个详情页(RankingDetail/TmdbWorkDetail/
 *  WorkDetail)各自已经知道 title/posterUrl/channelId。`itemId` 的形状决定 workKey 怎么来:
 *  - netdisk 绑定的集/电影,`itemId` 是 leftKey(`tmdb:261391:S03E02`)→ 用 workKeyParts 从
 *    key 里推导 workKey/epLabel(两段作品身份 + 第三段集号)。
 *  - 未绑定的采集条目(WorkDetail 的本地季 tab / 扁平 grid),`itemId` 是不透明的 inbox item
 *    id,身份推不出来——**必须由调用点显式给 `override`**(WorkDetail 那边有 stream 在手,
 *    knows its own identity),否则每一集会各自成一个"作品",「继续观看」按 workKey 去重就失效。
 *  无 itemId(理论上不会发生——播放按钮总是随着一个可播 key 才出现)就不给服务端进度,
 *  ArtPlayer 走它自己的兜底(0)。 */
function buildServerProgress(
  itemId: string | undefined,
  workTitle: string,
  workPoster: string | undefined,
  conn: Connection,
  channelId: string | undefined,
  override?: { workKey: string; epLabel?: string },
): ServerProgressConfig | undefined {
  if (!itemId) return undefined
  const { workKey, epLabel } = override ?? workKeyParts(itemId)
  return { key: itemId, workKey, workTitle, workPoster, epLabel, channelId, conn }
}

/** 播放器右侧「选集」面板要的一集——两种数据源（TMDb 分季 / 本地采集条目）摊平成同一形状。
 *  `key` = 播放侧键(itemId)：既是身份（高亮当前在播）也是切集时传给 onPick 的键。 */
export interface PickerEpisode {
  key: string
  season?: number
  episode?: number
  title: string
  still?: string
  playable: boolean
  /** 可播时的媒体（点了原地换源）；不可播为空。 */
  media?: VideoMedia
}

/** TMDb 分季索引 → 选集条目。可播的集拼 resolve 媒体（与 SeasonEpisodeCard 点击时同款），
 *  key = leftKey；不可播（没配上文件/未播）留着占位但点不动。 */
export function seasonsToPickerEpisodes(seasons: SeasonGroup[], baseUrl: string): PickerEpisode[] {
  const out: PickerEpisode[] = []
  for (const s of seasons) {
    for (const ep of s.episodes) {
      out.push({
        key: ep.leftKey,
        season: ep.season,
        episode: ep.episode,
        title: ep.title,
        still: ep.still ? imgUrl(baseUrl, ep.still) : undefined,
        playable: ep.playable,
        media: ep.playable
          ? { kind: 'video', url: '/api/media/videos/resolve?key=' + encodeURIComponent(ep.leftKey), resolveOnly: true }
          : undefined,
      })
    }
  }
  return out
}

/** 本地采集条目 → 选集条目。可播性来自 resolveOnly video 媒体（同 EpisodeCard 的判据），key = item id。 */
export function itemsToPickerEpisodes(items: Item[], baseUrl: string): PickerEpisode[] {
  return items.map((it) => {
    const resolveOnly = it.content?.media?.find((m): m is VideoMedia => m.kind === 'video' && !!m.resolveOnly)
    const media = resolveOnly ? playableVideo([resolveOnly]) : undefined
    const cover = poster(it) ?? resolveOnly?.poster
    return {
      key: it.id,
      season: it.season ?? undefined,
      title: it.title,
      still: cover ? imgUrl(baseUrl, cover) : undefined,
      playable: !!media,
      media,
    }
  })
}

/** 播放时的「选集」面板：分季 pill + 紧凑分集列表（窄栏，不是详情页那种大剧照墙）。可播的点了
 *  原地换源、当前在播那条高亮；不可播的降透明、点不动。 */
export function EpisodePickerPanel({ episodes, currentKey, onPick }: {
  episodes: PickerEpisode[]
  currentKey?: string
  onPick: (ep: PickerEpisode) => void
}) {
  const { t } = useTranslation()
  const bySeason = new Map<number, PickerEpisode[]>()
  for (const ep of episodes) {
    const s = ep.season ?? 1
    const list = bySeason.get(s) ?? []
    list.push(ep)
    bySeason.set(s, list)
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b)
  // 默认落在「当前在播那一集所属的季」，不是永远第一季——切集面板一打开就该停在你正在看的地方。
  const currentSeason = episodes.find((e) => e.key === currentKey)?.season ?? seasons[0] ?? 1
  const [active, setActive] = useState(currentSeason)
  const current = bySeason.get(active) ?? bySeason.get(seasons[0]!) ?? []

  return (
    <div
      data-scroll-root
      data-nested-surface="true"
      className="scrollbar-mac h-full w-full overflow-y-auto bg-[var(--acr-panel)] backdrop-blur-xl"
    >
      <div className="flex flex-col gap-4 p-5">
        <header className="flex flex-col gap-0.5">
          <h2 className="text-[15px] font-semibold leading-tight tracking-[-0.01em]">选集</h2>
          <p className="text-[13px] leading-snug text-muted-foreground">点一集直接切换，不用退出播放</p>
        </header>

        {seasons.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {seasons.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setActive(s)}
                className={cn(
                  'rounded-full px-3 py-1 text-[12px] transition-colors',
                  s === active ? 'bg-primary text-primary-foreground' : 'bg-foreground/8 text-muted-foreground hover:text-foreground',
                )}
              >
                {t('movie.seasonLabel', { n: s })}
              </button>
            ))}
          </div>
        )}

        <ItemGroup className="gap-1.5">
          {current.map((ep) => {
            const isCurrent = ep.key === currentKey
            const epNo = ep.episode != null ? t('movie.episodeShort', { n: ep.episode }) : undefined
            return (
              <AcrylicItem
                key={ep.key}
                variant="outline"
                size="sm"
                data-current={isCurrent || undefined}
                onClick={ep.playable && !isCurrent ? () => onPick(ep) : undefined}
                className={cn(
                  'items-center gap-3',
                  ep.playable ? 'cursor-pointer' : 'cursor-default opacity-55',
                  isCurrent && 'bg-[var(--acr-surface-hover)] ring-1 ring-primary/60',
                )}
              >
                <div className="relative aspect-video w-20 shrink-0 overflow-hidden rounded-md bg-muted">
                  {ep.still ? (
                    <img src={ep.still} alt="" className={cn('size-full object-cover', !ep.playable && 'grayscale')} />
                  ) : (
                    <div className="flex size-full items-center justify-center text-muted-foreground"><Film className="size-4" /></div>
                  )}
                  {epNo ? <MediaBadge className="left-1 top-1 tabular-nums">{epNo}</MediaBadge> : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-medium">{ep.title}</span>
                  {isCurrent ? (
                    <span className="text-[11px] text-primary">▶ 正在播放</span>
                  ) : !ep.playable ? (
                    <span className="text-[11px] text-muted-foreground">{t('video.finderNotMatched')}</span>
                  ) : null}
                </div>
              </AcrylicItem>
            )
          })}
        </ItemGroup>
      </div>
    </div>
  )
}

/** 说话人那半在播放器右侧栏里**暂时不接线**——面板不画、分段切换不出现，但
 *  `SpeakerSegmentPanel`、`useSpeakerMap` 和它们的测试原样留着，改回 `true` 就恢复。
 *
 *  为什么留一个常量而不是把渲染那几行删掉：删了等于把一整条线（面板 + hook + 两份测试）报废，
 *  恢复时要重写；留常量则「关掉」这件事本身是可搜的，下一个人不会以为这个功能从来不存在。
 *
 *  **它只管右侧栏这一格。** 进度条上那几段说话人色块走的是 ArtPlayer 的 `speakerBlocks`，
 *  是另一条线，不受这个开关影响。 */
// 标注成 boolean 而不是让它推成字面量 `false`：否则 TS 把下面那些分支全判成不可达，
// 「留着等恢复」的代码会被当成死代码报出来。
const SPEAKER_PANEL_ENABLED: boolean = false

/** 右侧栏这一趟有没有东西可放。
 *
 *  必须单独算一次给 `DetailShell`：它是靠 `panel` 是不是空来决定留不留出那一列的，
 *  而「渲染出来是 null 的元素」在它眼里照样非空——那样会画出一条空白栏。 */
export function playerRightPanelHasContent(
  itemId: string | undefined,
  episodes?: PickerEpisode[],
  onPickEpisode?: (ep: PickerEpisode) => void,
): boolean {
  if (itemId === undefined) return false
  return SPEAKER_PANEL_ENABLED || !!(episodes && episodes.length > 1 && onPickEpisode)
}

/** 播放器右侧栏：多集时顶部给一个「选集 / 识别发言人」分段切换（Button Group），单集/无分集时
 *  直接就是识别发言人。选集和「谁在说话」共用这一栏，一次只显示一个。
 *
 *  说话人那半现在关着（`SPEAKER_PANEL_ENABLED`）：这一栏退化成只有选集，没有分集就整个不画。 */
export function PlayerRightPanel({ itemId, map, onSeek, currentTime, duration, episodes, onPickEpisode }: {
  itemId: string
  map: ReturnType<typeof useSpeakerMap>
  onSeek: (seconds: number) => void
  currentTime: number
  duration: number
  episodes?: PickerEpisode[]
  onPickEpisode?: (ep: PickerEpisode) => void
}) {
  const hasPicker = !!(episodes && episodes.length > 1 && onPickEpisode)
  const [tab, setTab] = useState<'episodes' | 'speakers'>('episodes') // 默认选集：切集是常态化诉求
  if (!SPEAKER_PANEL_ENABLED) {
    // 只剩选集：切换器没有第二个选项就不该出现（一个只能选自己的分段控件是纯噪音）。
    return hasPicker ? <EpisodePickerPanel episodes={episodes!} currentKey={itemId} onPick={onPickEpisode!} /> : null
  }
  const speaker = (
    <SpeakerSegmentPanel itemId={itemId} map={map} onSeek={onSeek} currentTime={currentTime} duration={duration} />
  )
  if (!hasPicker) return speaker
  return (
    <div className="flex h-full w-full flex-col bg-[var(--acr-panel)] backdrop-blur-xl">
      <div className="shrink-0 px-5 pt-4">
        <ButtonGroup
          type="single"
          variant="segmented"
          size="large"
          value={tab}
          onValueChange={(v) => setTab((v as 'episodes' | 'speakers') || 'speakers')}
          aria-label="右侧面板视图"
          className="w-full"
        >
          <ButtonGroupItem value="episodes">选集</ButtonGroupItem>
          <ButtonGroupItem value="speakers">识别发言人</ButtonGroupItem>
        </ButtonGroup>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'episodes' ? (
          <EpisodePickerPanel episodes={episodes!} currentKey={itemId} onPick={onPickEpisode!} />
        ) : (
          speaker
        )}
      </div>
    </div>
  )
}

function FullscreenEpisodePlayer({ media, itemId, baseUrl, onClose, serverProgress, episodes, onPickEpisode }: {
  media: VideoMedia
  /** 该集转写/说话人数据的键；缺省 = 这个播放入口没带身份，说话人面板整个不出现 */
  itemId?: string
  baseUrl: string
  onClose: () => void
  /** 存在 = 该次播放用服务端「继续观看」进度(取代 localStorage)——只有影视频道传，
   *  Timeline(Detail.tsx/App.tsx)不传,原有 localStorage 行为不变。 */
  serverProgress?: ServerProgressConfig
  /** 本作品的分集（>1 才在右侧栏给「选集」切换）；点某集调 onPickEpisode 原地换源。 */
  episodes?: PickerEpisode[]
  onPickEpisode?: (ep: PickerEpisode) => void
}) {
  useEscape(onClose)
  const map = useSpeakerMap(itemId)
  const seekRef = useRef<((seconds: number) => void) | null>(null)
  // 播放头 + 全片时长：由 ArtPlayer 的 onTime 节流(~4/s)喂上来，供右侧面板高亮「此刻谁在说」
  // 并给每人的迷你时间轴一个刻度。一次 setState 带两个值，免得两个 state 各触发一次渲染。
  const [clock, setClock] = useState({ t: 0, duration: 0 })
  // 和时间线帖子详情用**同一个** DetailShell（外壳 + 播放区 + 关闭语义），只是右侧插槽换成
  // 「谁在说话」——这正是「按调用它的功能区来调度」：框架和播放逻辑共享，面板内容各出各的。
  return (
    <DetailShell
      onClose={onClose}
      media={
        <ArtPlayer
          media={media}
          baseUrl={baseUrl}
          // 不再 autoFullscreen / onFullscreenExit=onClose：那是裸播放器时代的语义（播放器**就是**
          // 全屏本身，所以"退出全屏"等价于"关闭"）。进 DetailShell 后 shell 已占满视口，再强制进
          // 浏览器全屏会盖掉右侧面板；而把"退出全屏"接到 onClose，会让用户想缩回详情页时整个页面
          // 被关掉——正是那个"双击又跳回作品页、很不稳定"的来源。全屏改为用户按播放器自己的按钮进出。
          seekRef={seekRef}
          speakerBlocks={map.blocks}
          activeSpeakers={map.activeSpeakers}
          speakerNames={map.names}
          onTime={(t, d) => setClock({ t, duration: d })}
          serverProgress={serverProgress}
        />
      }
      panel={
        // 「有没有内容」单独问一次，不能只看 itemId：说话人那半关掉之后，单集作品的右侧栏
        // 是空的，而给 DetailShell 一个渲染出来是 null 的元素它照样留出那一列。
        itemId !== undefined && playerRightPanelHasContent(itemId, episodes, onPickEpisode) ? (
          <PlayerRightPanel
            itemId={itemId}
            map={map}
            onSeek={(sec) => seekRef.current?.(sec)}
            currentTime={clock.t}
            duration={clock.duration}
            episodes={episodes}
            onPickEpisode={onPickEpisode}
          />
        ) : undefined
      }
    />
  )
}

function WorkDetail({ stream, channelId, episodes, watchProgress, conn, onBack, onCollectedChanged, onPlaybackClosed }: {
  stream: ChannelStream
  /** stream 所属的频道 id——用于「找资源」按该频道的槽位设置(能力槽位覆盖)搜索；
   *  未知归属(理论上不会发生,streams 派生自 channels)时不传,退化为不带 channelId 的全局搜索。 */
  channelId?: string
  episodes: Item[]
  /** see RankingDetail's doc —— 这一页据此认领自己那条进度行，出「继续播放」。 */
  watchProgress: WatchProgressRow[]
  conn: Connection
  onBack: () => void
  onCollectedChanged: (streamId: string, member: boolean) => void
  /** see RankingDetail's doc — refreshes the 「继续观看」shelf on player close. */
  onPlaybackClosed?: () => void
}) {
  const { t } = useTranslation()
  // `progressOverride`: only the local-season-tab / flat-grid branches below set this (their
  // itemId is an opaque inbox item id, not a leftKey workKeyParts can derive identity from —
  // see buildServerProgress's doc). The TMDb-seasons branch leaves it unset since its itemId
  // IS a leftKey. 续播入口也带它——身份直接来自那一行（见 resumeProgressOverride 头注）。
  const [playing, setPlaying] = useState<{ media: VideoMedia; itemId?: string; progressOverride?: { workKey: string; epLabel?: string } } | null>(null)
  const [finding, setFinding] = useState<string | null>(null)
  // The player covers this page and owns Esc while it is open.
  useEscape(onBack, !playing)
  const [payload, setPayload] = useState<VideoDetailPayload | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const loadDetail = async (force = false) => {
    force ? setRefreshing(true) : setLoadingDetail(true)
    try {
      const response = await fetch(conn.baseUrl + '/api/video/works/stream:' + encodeURIComponent(stream.id) + (force ? '/refresh' : ''), {
        method: force ? 'POST' : 'GET', headers: conn.token ? { Authorization: 'Bearer ' + conn.token } : undefined,
      })
      if (!response.ok) throw new Error('detail unavailable')
      setPayload(await response.json() as VideoDetailPayload)
    } catch {
      setPayload(null)
    } finally {
      setLoadingDetail(false); setRefreshing(false)
    }
  }
  useEffect(() => { void loadDetail() }, [conn.baseUrl, conn.token, stream.id])
  const detail = payload?.detail
  const metadata = detail?.metadata
  const visibleEpisodes = payload?.episodes ?? episodes
  const posterUrl = detail?.images.poster?.url ?? stream.image
  // canonical miss 时 detail.failures 必然非空——但只在本地也没什么可看时才算真的"部分不可用";
  // 有 poster/简介/分集摆在这,TMDB 数据本来就不适用,不该显示这条容易误导的横幅。
  const hasSubstantialLocalData = !!posterUrl || !!stream.synopsis || visibleEpisodes.length > 0
  const backdropUrl = detail?.images.backdrop?.url
  const title = (metadata?.title ?? stream.description) || stream.id
  const facts = [metadata?.year ?? (metadata?.releaseDate ? metadata.releaseDate.slice(0, 4) : undefined), metadata?.runtimeMinutes ? t('movie.runtimeMinutes', { n: metadata.runtimeMinutes }) : undefined, t('movie.episodeCount', { n: visibleEpisodes.length })].filter(Boolean)
  const rating = metadata?.ratings?.[0]
  // 这一页有**两种**身份会被写进进度：TMDb 分季分集那一支的 itemId 本身就是 leftKey（workKey =
  // `tmdb:<id>`，来自 binding.ref），本地季 tab / 扁平 grid 那一支的 itemId 是不透明 inbox id、
  // 显式打了 `stream:<id>` 标记。两个都要认领——只认一个的表现是「刚看过，详情页上却没有继续播放」。
  const resumeRow = findResumeRow(watchProgress, [
    `stream:${stream.id}`,
    payload?.binding?.ref ? 'tmdb:' + payload.binding.ref.id : undefined,
  ])

  return (
    <>
    <div className="flex flex-col gap-6">
      <header className="relative isolate -mx-5 -mt-5 flex min-h-[24rem] flex-col justify-end overflow-hidden bg-muted/40 px-5 pb-8 pt-16 sm:min-h-[28rem] sm:px-8 sm:pb-12 sm:pt-16">
        {backdropUrl && <img src={imgUrl(conn.baseUrl, backdropUrl)} alt="" className="absolute inset-0 -z-10 size-full object-cover object-top opacity-45" />}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-background/85 to-background/15" />
        <div className="flex items-start gap-4 sm:gap-5">
          <div className="w-28 shrink-0 overflow-hidden rounded-xl bg-muted shadow-lg ring-1 ring-white/10 sm:w-40">
            {posterUrl ? <img src={imgUrl(conn.baseUrl, posterUrl)} alt="" className="aspect-[2/3] size-full object-cover" /> : <div className="flex aspect-[2/3] items-center justify-center text-muted-foreground"><Film className="size-8" /></div>}
          </div>
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-center gap-1">{detail?.images.logo?.url ? <img src={imgUrl(conn.baseUrl, detail.images.logo.url)} alt={title} className="max-h-10 max-w-[220px] object-contain object-left" /> : <h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">{title}</h1>}<OriginalLink url={episodes[0]?.url} identity={detail?.identity} /></div>
            {metadata?.originalTitle && metadata.originalTitle !== title && <p className="mt-1 text-[13px] text-muted-foreground">{metadata.originalTitle}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] tabular-nums text-muted-foreground">{facts.map((fact) => <span key={String(fact)}>{fact}</span>)}</div>
            {rating && <div className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-amber-500"><Star className="size-3.5 fill-current" /> {rating.value.toFixed(1)} <span className="font-normal text-muted-foreground">/ {rating.scale} · {rating.source.toUpperCase()}</span></div>}
            {(metadata?.overview ?? stream.synopsis) && <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{metadata?.overview ?? stream.synopsis}</p>}
            {metadata?.genres?.length ? <div className="mt-3 flex flex-wrap gap-1.5">{metadata.genres.map((genre) => <span key={genre} className="rounded-full bg-foreground/8 px-2 py-0.5 text-[11px] text-muted-foreground">{genre}</span>)}</div> : null}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <CollectButton
                conn={conn}
                domain="video"
                itemKey={{ kind: 'stream', streamId: stream.id }}
                meta={{ title, poster: posterUrl }}
                onChanged={(collectionId, member) => {
                  if (collectionId === SYSTEM_COLLECTIONS.videoFollowing) onCollectedChanged(stream.id, member)
                }}
              />
              {/* 看过一半 → 接着看（同 RankingDetail：有进度时"从头播"几乎不是用户想要的那一下）。 */}
              {resumeRow && <ResumeButton row={resumeRow} onResume={(row) => setPlaying({ media: resumeMedia(row, posterUrl), itemId: row.key, progressOverride: resumeProgressOverride(row) })} />}
              <Button type="button" variant="neutral" size="small" onClick={() => void loadDetail(true)} disabled={refreshing}>{refreshing ? <Loader2 className="animate-spin" /> : t('movie.refreshDetail')}</Button>
              <Button type="button" variant="neutral" size="small" onClick={() => setFinding(title)}>{t('video.findResource')}</Button>
              {payload?.binding && <WorkBinding conn={conn} work={payload.binding} streamId={stream.id} streamTitle={title} onChanged={() => void loadDetail(true)} />}
              {loadingDetail && <span className="text-[12px] text-muted-foreground">{t('movie.loadingMetadata')}</span>}
            </div>
          </div>
        </div>
      </header>
      {detail?.failures.length && !hasSubstantialLocalData ? <p className="text-[12px] text-muted-foreground">{t('movie.partialUnavailable')}</p> : null}
      <CastGallery people={metadata?.people} baseUrl={conn.baseUrl} />
      <section className="flex flex-col gap-3"><h2 className="text-[15px] font-semibold">{t('movie.episodesSection')}</h2>
      {/* 三选一：真剧集 → TMDb 分季分集树；本地多季合并（无 canonical，item 带 season）→ 本地季 tab；
          都没有 → 扁平采集 grid（后端 seasons 有无、item.season 有无是判据）。 */}
      {payload?.seasons?.length ? (
        // itemId here IS a leftKey (`tmdb:xxx:SxxEyy`) — buildServerProgress derives workKey via
        // workKeyParts, no override needed.
        <SeasonEpisodeList seasons={payload.seasons} workTitle={title} baseUrl={conn.baseUrl} onPlay={(m, id) => setPlaying({ media: m, itemId: id })} onFindResource={setFinding} />
      ) : visibleEpisodes.some((ep) => ep.season != null) ? (
        // itemId here is a raw inbox item id (no tmdb structure) — workKeyParts can't derive the
        // work from it, so every episode would land as its own "work". This component already
        // knows the real identity (the stream itself), so hand it over explicitly.
        <LocalSeasonTabs episodes={visibleEpisodes} baseUrl={conn.baseUrl} onPlay={(m, id) => setPlaying({ media: m, itemId: id, progressOverride: { workKey: `stream:${stream.id}` } })} onFindResource={(t) => setFinding(t)} />
      ) : visibleEpisodes.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-5">
          {visibleEpisodes.map((ep) => <EpisodeCard key={ep.id} it={ep} baseUrl={conn.baseUrl} onPlay={(m, id) => setPlaying({ media: m, itemId: id, progressOverride: { workKey: `stream:${stream.id}` } })} onFindResource={(t) => setFinding(t)} />)}
        </div>
      ) : (
        <div className="px-2 py-12 text-center text-sm text-muted-foreground">{t('movie.noEpisodes')}</div>
      )}</section>
      <ResourceFinderSheet open={!!finding} conn={conn} query={finding ?? ''} channelId={channelId} onClose={() => setFinding(null)} work={payload?.binding} onBound={() => void loadDetail(true)} />
    </div>
    {playing && (
      <FullscreenEpisodePlayer
        media={playing.media}
        itemId={playing.itemId}
        baseUrl={conn.baseUrl}
        onClose={() => { setPlaying(null); onPlaybackClosed?.() }}
        serverProgress={buildServerProgress(playing.itemId, title, posterUrl, conn, channelId, playing.progressOverride)}
        // 选集与上面「三选一」分集区同源：TMDb 分季无 override；本地季/扁平 grid 带 stream override
        // （itemId 是不透明 inbox id，续播 workKey 得显式给，和 LocalSeasonTabs/EpisodeCard 一致）。
        episodes={payload?.seasons?.length ? seasonsToPickerEpisodes(payload.seasons, conn.baseUrl) : itemsToPickerEpisodes(visibleEpisodes, conn.baseUrl)}
        onPickEpisode={(ep) => ep.media && setPlaying({
          media: ep.media, itemId: ep.key,
          ...(payload?.seasons?.length ? {} : { progressOverride: { workKey: `stream:${stream.id}` } }),
        })}
      />
    )}
    </>
  )
}

/**
 * A horizontal, page-able strip of tiles — the level-1 shelf layout. Factored out of Shelf so a
 * work's cast can reuse it verbatim (same tiles, same paging) instead of being its own widget.
 *
 * `count` doubles as the re-measure signal: the ResizeObserver only sees the container's own box,
 * so content arriving inside a same-sized container would otherwise leave the arrows stale.
 */
function Rail({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isAtLeft, setIsAtLeft] = useState(true)
  const [isAtRight, setIsAtRight] = useState(false)

  const checkScroll = () => {
    const el = containerRef.current
    if (!el) return
    const atLeft = el.scrollLeft <= 2
    const maxScroll = el.scrollWidth - el.clientWidth
    const atRight = maxScroll <= 0 || el.scrollLeft >= maxScroll - 2
    setIsAtLeft(atLeft)
    setIsAtRight(atRight)
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    checkScroll()
    el.addEventListener('scroll', checkScroll, { passive: true })
    const observer = new ResizeObserver(() => {
      checkScroll()
    })
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', checkScroll)
      observer.disconnect()
    }
  }, [count])

  const scroll = (direction: 'left' | 'right') => {
    const el = containerRef.current
    if (!el) return
    const scrollAmount = el.clientWidth * 0.8
    el.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    })
  }

  return (
    <div className="min-w-0 flex flex-col">
      <div className="mb-3 flex w-full items-center gap-2 px-1 text-left">
        <h2 className="text-[16px] font-bold tracking-tight text-foreground">{title}</h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="large"
            icon
            onClick={() => scroll('left')}
            disabled={isAtLeft}
            title={t('movie.prevPage')}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="large"
            icon
            onClick={() => scroll('right')}
            disabled={isAtRight}
            title={t('movie.nextPage')}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex flex-row gap-4 overflow-x-auto scroll-smooth scrollbar-none pb-1"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {children}
      </div>
    </div>
  )
}

/** One ranking = one horizontal shelf of movie posters. */
function Shelf({ stream, items, baseUrl, onOpenItem }: {
  stream: ChannelStream
  items: Item[]
  baseUrl: string
  onOpenItem: (item: Item) => void
}) {
  if (!items.length) return null
  return (
    <Rail title={stream.description || stream.id} count={items.length}>
      {items.map((it) => (
        <div key={it.id} className="w-[160px] shrink-0">
          <MovieCard it={it} baseUrl={baseUrl} onOpen={() => onOpenItem(it)} />
        </div>
      ))}
    </Rail>
  )
}

/**
 * 影视 (video-variant) channel — pure presentation, two levels:
 *  • Level 1: 「正在追的」= a poster wall of followed WORKS (WorkCard: album poster + badge),
 *    pinned above the ranking shelves (豆瓣 / TMDB / IMDb, each a Shelf of movie posters).
 *  • Level 2: clicking a work → its detail page (WorkDetail: hero + episode grid). Entering
 *    marks the work seen (clears its badge). Ranking cards open their own item detail,
 *    whose lookup identity comes from that item rather than the ranking stream label.
 * Netdisk/AList binding is NOT wired here — channels present, bindings live in the source UI.
 */
export function MovieChannel({ conn, channels, onChannelsChanged, onReload }: { conn: Connection; channels: ChannelView[]; onChannelsChanged?: () => void; onReload: () => void }) {
  const { t } = useTranslation()
  // 「内容 | 配置」分页。**只有恰好一个频道时才有它**：分页说的是「这个频道的配置」，
  // 有多个 video 频道时配哪一个是没有答案的，那一档保留原来那颗齿轮（点开先选频道）。
  // 两个宿主（主应用 videoChannels / 面板 movieChannels）都只喂当前这一个，所以实际
  // 走的一直是分页那条路。
  const [tab, setTab] = useState<ChannelTab>('content')
  const [manageId, setManageId] = useState<string | null>(null)
  const streams = useMemo(() => {
    const seen = new Set<string>()
    const res: ChannelStream[] = []
    for (const c of channels) for (const s of c.streams) if (!seen.has(s.id)) { seen.add(s.id); res.push(s) }
    return res
  }, [channels])

  // MovieChannel 是虚拟聚合(所有 present === 'video' 的频道合并展示,见文件头注)，一个 stream
  // 归属哪个真实频道要反查——「找资源」按频道槽位设置(能力槽位覆盖)搜索需要这个 id。
  const channelIdByStreamId = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of channels) for (const s of c.streams) if (!m.has(s.id)) m.set(s.id, c.id)
    return m
  }, [channels])

  // 收藏(正在追的成员来源,见 lib/items.ts partitionFollowing 头注)——覆盖层同 seenOverride 的
  // 道理:点了「收藏/取消收藏」要立刻反映在网格上,不等下一次 /api/channels 轮询。undefined=按
  // 服务端的 newCount 有无判(partitionFollowing 的老规则);true/false=本地刚点过、还没被下一次
  // 拉取覆盖。CollectButton 自己管弹层里的勾选状态,这里只接它的 onChanged 回调更新网格。
  const [streamCollectedOverride, setStreamCollectedOverride] = useState<Record<string, boolean>>({})
  const onStreamCollectedChanged = (streamId: string, member: boolean) => {
    setStreamCollectedOverride((prev) => ({ ...prev, [streamId]: member }))
    // 时间线权威(collectedFollowing)同步打本地补丁:刚收藏的排到最前(同服务端 added_at DESC 的
    // 语义),取消收藏的移出——不等下一次整体拉取。
    setCollectedFollowing((prev) => {
      const key = `stream:${streamId}`
      if (!member) return prev.filter((i) => i.key !== key)
      if (prev.some((i) => i.key === key)) return prev
      const snapshot: CollectedItem = { key, kind: 'stream', domain: 'video', streamId, title: streamId, firstCollectedAt: 0 }
      return [snapshot, ...prev]
    })
  }

  const { following, rankings } = useMemo(() => {
    const base = partitionFollowing(streams)
    if (!Object.keys(streamCollectedOverride).length) return base
    const byId = new Map(streams.map((s) => [s.id, s]))
    const following = base.following.filter((s) => streamCollectedOverride[s.id] !== false)
    const followingIds = new Set(following.map((s) => s.id))
    for (const [id, want] of Object.entries(streamCollectedOverride)) {
      if (!want || followingIds.has(id)) continue
      const s = byId.get(id)
      if (s) { following.push(s); followingIds.add(id) }
    }
    // 取消收藏不落回 rankings 货架(那是 5 个写死榜单流专用的图表 UI,渲染不了一个普通 Stream)——
    // 直接从网格里消失即可,跟"没收藏过"视觉上没差别。
    const rankings = base.rankings.filter((s) => !followingIds.has(s.id))
    return { following, rankings }
  }, [streams, streamCollectedOverride])

  // 「正在追的」系统列表全量条目(stream+tmdb 混排,服务端按 added_at DESC)——既是纯榜单收藏
  // (无 Stream,如「奥德赛」)的成员来源,也是整个网格跨类型排序的时间线权威(mergeFollowingTimeline)。
  // onTmdbCollectedChanged 直接本地增删,不重新整体 fetch。
  const [collectedFollowing, setCollectedFollowing] = useState<CollectedItem[]>([])
  useEffect(() => {
    let live = true
    api.collectionItems(conn, SYSTEM_COLLECTIONS.videoFollowing)
      .then((items) => { if (live) setCollectedFollowing(items) })
      .catch(() => {})
    return () => { live = false }
  }, [conn])
  const onTmdbCollectedChanged = (item: { id: string; media: 'movie' | 'tv'; title: string; poster?: string }, member: boolean) => {
    const key = `tmdb:${item.media}:${item.id}`
    setCollectedFollowing((prev) => {
      if (!member) return prev.filter((i) => i.key !== key)
      // 已在列表里 → 只刷新快照字段(poster 自愈会带着补好的封面再回调一次,网格立即换图)。
      if (prev.some((i) => i.key === key))
        return prev.map((i) => (i.key === key ? { ...i, title: item.title, poster: item.poster ?? i.poster } : i))
      const snapshot: CollectedItem = {
        key, kind: 'tmdb', domain: 'video', tmdbId: item.id, media: item.media,
        title: item.title, poster: item.poster, firstCollectedAt: 0,
      }
      return [snapshot, ...prev]
    })
  }

  // 「继续观看」——服务端已经按作品去重、过滤掉已完成、按最近更新排序,前端只管渲染,不重排/重过滤
  // (见 lib/watchProgress.ts continueWatchingCards 头注)。拉取失败 = 整段不出现 + 一次 toast,
  // 不阻塞其余网格。右键移除只本地过滤掉这一张卡,不整体重拉;失败则把卡还原(不能让用户以为
  // 移除成功了、下次刷新它又诡异地重新出现)。
  const [continueWatching, setContinueWatching] = useState<WatchProgressRow[]>([])
  // MovieChannel 二级页是路由态而非卸载/重新挂载(见文件头注),所以「进详情播放→退回频道首页」
  // 不会重新触发这个 effect——播放器每次关闭都要主动重拉一次,否则本次会话里刚看过的一集要么
  // 迟迟不出现在墙上,要么(刚看完的那集)带着旧进度赖着不掉。三个详情组件的播放器 onClose 都接了
  // 这个(见 onPlaybackClosed prop),不止「继续观看」墙自己 resume 那一条路径。
  //
  // 只要这一屏的进度：儿童频道不该出现大人正在追的剧。作用域就是本次渲染的频道集合（频道视图下
  // 是那一个，`/video` 聚合入口下是全部）。
  const channelIds = useMemo(() => channels.map((c) => c.id), [channels])
  const refreshContinueWatching = () => {
    api.watchProgressList(conn, channelIds)
      .then((rows) => setContinueWatching(rows))
      .catch(() => toast.error(t('movie.continueWatchingLoadFailed')))
  }
  useEffect(() => {
    let live = true
    api.watchProgressList(conn, channelIds)
      .then((rows) => { if (live) setContinueWatching(rows) })
      .catch(() => { if (live) toast.error(t('movie.continueWatchingLoadFailed')) })
    return () => { live = false }
  }, [conn, channelIds])
  const removeFromContinue = (key: string) => {
    const prev = continueWatching
    setContinueWatching((cur) => cur.filter((r) => r.key !== key))
    api.watchProgressRemove(conn, key).catch(() => {
      setContinueWatching(prev)
      toast.error(t('movie.continueWatchingRemoveFailed'))
    })
  }
  // 点一张「继续观看」卡 → **进作品详情页**，不直接起播；起播交给那一页上的「继续播放」按钮
  // （见 continueWatchingRoute 头注：一点就全屏，用户没机会先看一眼有几季几集、要不要换一集）。
  //
  // `resuming` 是回落：`workKey` 的命名空间认不出坐标时没有详情页可去，就地续播——有个能播的
  // 入口，好过一张点不动的卡。续播的「作品身份」直接来自这一行，不从 leftKey 反推。
  const [resuming, setResuming] = useState<WatchProgressRow | null>(null)
  const openContinue = (key: string) => {
    const row = continueWatching.find((r) => r.key === key)
    if (!row) return
    const target = continueWatchingRoute(row)
    if (target) navigate(target)
    else setResuming(row)
  }

  // local override so a badge clears immediately on open, before the next /api/channels refresh
  const [seenOverride, setSeenOverride] = useState<Record<string, true>>({})
  // level-2 selection lives in a path via useSubRoute: it seeds from the path (deep-link /
  // refresh land on the right detail) and stays in lock-step with browser back/forward. The
  // selection is just the parsed route; the concrete title is derived from it below.
  // 路径存哪由外层决定（主应用是地址栏，工作台面板里是内存——见 useSubRoute 头注）；base 因此
  // 也从那个存放处读，而不是直接读 `window.location`，否则面板里会拿宿主的路径当 base。
  const subRouteLocation = useSubRouteLocation()
  const videoToPath = useCallback(
    (r: VideoRoute) => videoToPathFrom(videoBaseFrom(subRouteLocation.pathname()), r),
    [subRouteLocation],
  )
  const { selection: route, navigate } = useSubRoute<VideoRoute>(videoRouteFrom, videoToPath)
  const badgeFor = (s: ChannelStream) => (seenOverride[s.id] ? 0 : s.newCount ?? 0)
  const openWork = (s: ChannelStream) => {
    navigate({ kind: 'item', id: s.id })
    if (!seenOverride[s.id]) {
      setSeenOverride((prev) => ({ ...prev, [s.id]: true }))
      api.markStreamSeen(conn, s.id).catch(() => { /* best-effort; server recomputes on next load */ })
    }
  }
  const openRankingItem = (it: Item) => navigate({ kind: 'item', id: it.id })
  const closeDetail = () => navigate({ kind: 'home' })

  const [itemsByStream, setItemsByStream] = useState<Record<string, Item[]>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    Promise.all(
      streams.map((s) =>
        api.items(conn, { stream: s.id, limit: 60 })
          // Drop folded items (ad-muted or 只看包含-filtered) — the poster wall has no Ads channel.
          .then((r) => [s.id, r.filter((it) => !it.muted)] as const)
          .catch(() => [s.id, [] as Item[]] as const),
      ),
    )
      .then((entries) => { if (live) setItemsByStream(Object.fromEntries(entries)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [conn, streams])

  // 影视片名搜索(TMDB;可插拔搜索源)。搜索态是本地 state——开详情再返回不丢(MovieChannel 不卸载)。
  // 防抖 300ms;非空即用候选网格替换「正在追+排行榜」,清空回货架。warnings 非空=某源失败,轻提示。
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<VideoWorkCandidate[] | null>(null)
  // 最近点开的搜索候选——还没收藏的作品在 collectedTmdb 里找不到 hint，首访详情就没有 ?title=，
  // 后端只好拿 id 当占位标题去拉详情。把候选卡上已有的 title/poster 记下来当 hint 回落。
  const [searchHint, setSearchHint] = useState<{ id: string; media: 'movie' | 'tv'; title: string; poster?: string } | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const searchActive = query.trim().length > 0
  useEffect(() => {
    const q = query.trim()
    if (!q) { setCandidates(null); setSearching(false); setSearchFailed(false); return }
    let live = true
    setSearching(true); setSearchFailed(false)
    const timer = setTimeout(() => {
      api.videoTitleSearch(conn, q)
        .then((r) => { if (live) { setCandidates(r.candidates); setSearchFailed(r.warnings.length > 0) } })
        .catch(() => { if (live) { setCandidates([]); setSearchFailed(true) } })
        .finally(() => { if (live) setSearching(false) })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [conn, query])

  // Resolve the selected id against the two things it can name, in a fixed order: a followed 剧
  // (a Stream, known synchronously from props) before a ranking row (an Item, which arrives with
  // the feeds — so a deep-link shows as soon as its item loads). The order, not the id shape, is
  // what keeps the single /item/ segment unambiguous.
  const selectedWork = route.kind === 'item' ? streams.find((s) => s.id === route.id) ?? null : null
  const selectedRankingItem = useMemo(
    () => (route.kind === 'item' && !streams.some((s) => s.id === route.id)
      ? Object.values(itemsByStream).flat().find((it) => it.id === route.id) ?? null
      : null),
    [route, itemsByStream, streams],
  )
  const selectedTmdb = route.kind === 'tmdb' ? { id: route.id, media: route.media } : null
  // 从网格卡片点进来时,收藏快照里已经有 title/poster——首帧直接显示,不必等一轮 fetch；深链刷新
  // 进来时 collectedFollowing 还没拉到/压根没收藏过也无妨,TmdbWorkDetail 自己会回落 tmdb id。
  const selectedTmdbHint = selectedTmdb
    ? collectedFollowing.find((i) => i.kind === 'tmdb' && i.tmdbId === selectedTmdb.id && i.media === selectedTmdb.media)
      ?? (searchHint && searchHint.id === selectedTmdb.id && searchHint.media === selectedTmdb.media ? searchHint : undefined)
    : undefined
  const selectedTitle = selectedWork ? (selectedWork.description || selectedWork.id) : selectedRankingItem?.title
  // 跨类型统一时间线(collected 按 added_at 新→旧交错两种收藏;见 mergeFollowingTimeline 头注)。
  const followingTimeline = useMemo(() => mergeFollowingTimeline(collectedFollowing, following), [collectedFollowing, following])
  // tmdb 收藏可能是网格上唯一有内容的东西(用户只收藏了纯榜单作品,streams 侧还没抓到任何 item)。
  const hasAny = streams.some((s) => (itemsByStream[s.id]?.length ?? 0) > 0) || collectedFollowing.some((i) => i.kind === 'tmdb')

  // Remember scroll per layer: the grid keeps its place when you return from a detail (and even
  // after leaving/re-entering the channel — the store is module-scoped), each detail keeps its own.
  const scrollRef = useScrollMemory<HTMLDivElement>(
    `movie:${route.kind === 'home' ? 'grid' : route.kind === 'tmdb' ? `tmdb/${route.media}/${route.id}` : route.kind + '/' + route.id}`,
    scrollAreaViewport,
  )

  const inDetail = !!(selectedWork || selectedRankingItem || selectedTmdb)

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {inDetail ? (
        // 二级页：navbar 化为悬浮层，只留返回键，让 banner 铺到它身后（沉浸式 hero）。
        <div className="absolute inset-x-0 top-0 z-20 flex h-[49px] items-center px-4">
          <Button icon size="large" variant="neutral" aria-label={t('movie.back')} title={t('movie.back')} onClick={closeDetail}>
            <ChevronLeft />
          </Button>
        </div>
      ) : (
        // 顶栏照 DSH 对话页那条 navbar：标题行 32px + 上留白 12px，没有图标。整条 navbar 的
        // 下边线由底下那条分页画（见 ChannelTabs）；多频道那档没有分页，线就得自己带，
        // 否则 navbar 和内容之间没有边界。
        <div className={`flex h-8 shrink-0 items-center gap-2 px-4 pt-3 pb-0 box-content ${channels.length === 1 ? '' : 'border-b border-border'}`}>
          <ChannelTitleMenu
            title={selectedTitle ?? t('movie.channelTitle')}
            onRefresh={onReload}
            // 恰好一个频道时才给导出——判据与上面那条分页同一个：多个 video 频道时"导出哪一个"
            // 没有答案。
            exportChannel={channels.length === 1 ? { conn, id: channels[0]!.id } : undefined}
            className="min-w-0 flex-1"
          />
          <Searchbar
            size="large"
            className="w-56 max-w-[48%] shrink-0"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery('')}
            placeholder={t('movie.searchPlaceholder')}
            aria-label={t('movie.searchPlaceholder')}
          />
          {channels.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={t('nav.manageChannel')} title={t('nav.manageChannel')} className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground">
                  <Settings2 className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {channels.map((c) => (
                  <DropdownMenuItem key={c.id} onSelect={() => setManageId(c.id)}>{c.label}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      )}
      {/* 标题栏正下方那条「内容 | 配置」——配置从齿轮开的抽屉改成了分页，见 ChannelTabs 头注。
          二级页（作品详情）不画：那一层的顶栏本来就化成了一颗悬浮返回键。 */}
      {!inDetail && channels.length === 1 ? <ChannelTabs value={tab} onChange={setTab} /> : null}
      {tab === 'config' && channels.length === 1 && !inDetail ? (
        // **只在配置页开着时挂**：它组件体里就调 `useChannels()`，常挂着会强迫每一个宿主
        // 都套一层 `ChannelsProvider`（含只想画个海报墙的测试）。
        <div className="min-h-0 flex-1 overflow-auto">
          <ChannelConfigPanel
            conn={conn}
            channelId={channels[0].id}
            showHeader={false}
            onChanged={onChannelsChanged}
            onDeleted={() => { setTab('content') }}
          />
        </div>
      ) : (
      <ScrollArea ref={scrollRef} className="min-h-0 flex-1 scrollbar-mac">
        <div className="flex flex-col gap-8 p-5 pb-16">
          {selectedWork ? (
            <WorkDetail
              stream={selectedWork}
              channelId={channelIdByStreamId.get(selectedWork.id)}
              episodes={itemsByStream[selectedWork.id] ?? []}
              watchProgress={continueWatching}
              conn={conn}
              onBack={closeDetail}
              onCollectedChanged={onStreamCollectedChanged}
              onPlaybackClosed={refreshContinueWatching}
            />
          ) : selectedRankingItem ? (
            <RankingDetail item={selectedRankingItem} channelId={channelIdByStreamId.get(selectedRankingItem.stream_id)} watchProgress={continueWatching} conn={conn} onBack={closeDetail} onCollectedChanged={onTmdbCollectedChanged} onPlaybackClosed={refreshContinueWatching} />
          ) : selectedTmdb ? (
            <TmdbWorkDetail
              id={selectedTmdb.id}
              media={selectedTmdb.media}
              titleHint={selectedTmdbHint?.title}
              posterHint={selectedTmdbHint?.poster}
              // 纯 tmdb 收藏没有流可反查——频道视图下就记本频道，聚合入口下留空（归属未知）。
              channelId={channels.length === 1 ? channels[0].id : undefined}
              watchProgress={continueWatching}
              conn={conn}
              onBack={closeDetail}
              onPlaybackClosed={refreshContinueWatching}
              onCollectedChanged={onTmdbCollectedChanged}
            />
          ) : searchActive ? (
            searching && !candidates ? (
              <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
                <Loader2 className="size-5 animate-spin" /> {t('movie.searching')}
              </div>
            ) : !candidates?.length ? (
              <div className="px-2 py-16 text-center text-sm text-muted-foreground">
                {searchFailed ? t('movie.searchFailed') : t('movie.searchEmpty')}
              </div>
            ) : (
              <section className="flex flex-col gap-3">
                {searchFailed && <p className="px-1 text-[12px] text-amber-500">{t('movie.searchFailed')}</p>}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-4 gap-y-5">
                  {candidates.map((cand) => (
                    <CandidateCard
                      key={cand.externalIds.tmdb}
                      candidate={cand}
                      baseUrl={conn.baseUrl}
                      onOpen={() => {
                        const media = cand.kind === 'series' ? 'tv' : 'movie'
                        setSearchHint({ id: cand.externalIds.tmdb, media, title: cand.title, poster: cand.poster })
                        navigate({ kind: 'tmdb', id: cand.externalIds.tmdb, media })
                      }}
                    />
                  ))}
                </div>
              </section>
            )
          ) : loading && !hasAny ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> {t('movie.loading')}
            </div>
          ) : (
            <>
              {/* 「继续观看」「正在追的」与下面的榜单**同一种陈列**：横向 Rail、160px 定宽海报、
                  标题旁带条数和翻页键。此前这两块是会换行的自适应网格（卡片被拉到比 160 宽），
                  于是同一页上出现两种尺寸的海报，读起来像两个来源不同的模块。 */}
              {continueWatching.length > 0 && (
                <Rail title={t('movie.continueWatching')} count={continueWatching.length}>
                  {continueWatchingCards(continueWatching, t).map((c) => (
                    <ContextMenu key={c.key}>
                      <ContextMenuTrigger asChild>
                        <div className="w-[160px] shrink-0">
                          <MediaCard onOpen={() => openContinue(c.key)} ariaLabel={c.title} ratio="2 / 3"
                            src={c.poster ? imgUrl(conn.baseUrl, c.poster) : undefined}
                            fallback={<Film className="size-9" />} caption="overlay" title={c.title} subtitle={c.subtitle}>
                            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
                              <div className="h-full bg-primary" style={{ width: `${c.percent}%` }} />
                            </div>
                          </MediaCard>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent size="sm" className="w-36">
                        <ContextMenuItem variant="destructive" onSelect={() => void removeFromContinue(c.key)}>
                          <X /><span>{t('movie.removeFromContinue')}</span>
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </Rail>
              )}
              {!hasAny && (
                <div className="px-1 text-sm text-muted-foreground">{t('movie.noContent')}</div>
              )}
              {followingTimeline.length > 0 && (
                <Rail title={t('movie.nowFollowing')} count={followingTimeline.length}>
                  {/* 单一时间线:Stream 关注与 tmdb 收藏按「正在追的」系统列表的 added_at 新→旧
                      交错排,不再是两段各自排序后拼接(排序权威见 mergeFollowingTimeline 头注)。 */}
                  {followingTimeline.map((entry) => entry.kind === 'stream' ? (
                    <div key={entry.stream.id} className="w-[160px] shrink-0">
                      <WorkCard stream={entry.stream} badge={badgeFor(entry.stream)} baseUrl={conn.baseUrl} onOpen={() => openWork(entry.stream)} />
                    </div>
                  ) : (
                    <div key={entry.item.key} className="w-[160px] shrink-0">
                      <TmdbWorkCard
                        item={entry.item}
                        baseUrl={conn.baseUrl}
                        onOpen={() => navigate({ kind: 'tmdb', id: entry.item.tmdbId!, media: entry.item.media! })}
                      />
                    </div>
                  ))}
                </Rail>
              )}
              {rankings.map((s) => (
                <Shelf
                  key={s.id}
                  stream={s}
                  items={itemsByStream[s.id] ?? []}
                  baseUrl={conn.baseUrl}
                  onOpenItem={openRankingItem}
                />
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      )}
      {resuming && (
        <FullscreenEpisodePlayer
          media={{ kind: 'video', url: resumeUrlFor(resuming), resolveOnly: true }}
          itemId={resuming.key}
          baseUrl={conn.baseUrl}
          onClose={() => { setResuming(null); refreshContinueWatching() }}
          serverProgress={buildServerProgress(resuming.key, resuming.workTitle, resuming.workPoster, conn, resuming.channelId, { workKey: resuming.workKey, epLabel: resuming.epLabel })}
        />
      )}
      {manageId ? (
        <ChannelManageSheet open onOpenChange={(o) => { if (!o) setManageId(null) }} conn={conn} channelId={manageId} onChanged={onChannelsChanged} />
      ) : null}
    </div>
  )
}
