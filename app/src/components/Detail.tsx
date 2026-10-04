import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type WheelEvent } from 'react'
import { DetailShell } from './DetailShell.tsx'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Clipboard, Download, ExternalLink, FileText, MoreHorizontal, Pause, Play } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from './acrylic/dropdown-menu.tsx'
import { Badge } from './acrylic/badge.tsx'
import { Card, CardContent } from './acrylic/card.tsx'
import { Skeleton } from './acrylic/skeleton.tsx'
import { faviconUrl, imgUrl, type Connection } from '../lib/api.ts'
import { sourceIconFallbackUrl } from '../lib/sourceIcon.ts'
import { hasCommentThread } from '../lib/enrich.ts'
import { ItemActionButtons } from './feed/ItemActionButtons.tsx'
import { AuthorChip } from './AuthorChip.tsx'
import { useEnrichment, type EnrichmentState } from '../lib/preload.ts'
import { planVideo } from '../lib/videoPlan.ts'
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from './ui/carousel.tsx'
import { LabelSelect } from './LabelSelect.tsx'
import { ArtPlayer } from './ArtPlayer.tsx'
import { OutPortal } from '../lib/portal.ts'
import { useVideoStage } from '../lib/videoStage.ts'
import { useAudioStageOptional } from '../lib/audioStage.ts'
import { toTrack } from '../lib/audioTrack.ts'
import { mmss, triggerDownload } from '../lib/feedPresent.ts'
import { usePostPresentation } from '../lib/postPresentation.ts'
import { SourceAvatar } from './SourceAvatar.tsx'
import { CommentList } from './CommentList.tsx'
import { sourceLabel } from '../lib/sourceLabel.ts'
import { ModalAcrylicBody } from './acrylic/use-modal-acrylic.ts'
import { Button as AcrylicButton } from './acrylic/button.tsx'
import { cn } from '../lib/utils.ts'
import { askExtract } from '../lib/askExtract.ts'
import type { Item, Media, Quoted } from '../lib/types.ts'
import { overlayBlurb } from '../lib/blurb.ts'
import { BlurbOverlay } from './BlurbOverlay.tsx'

/** YYYY-MM-DD HH:MM:SS in local time. */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Body text in the reading modal: fully expanded, no collapse toggle — the info
 *  pane is a scroll area, so a long body is browsed by scrolling, not a 展开 click. */
function BodyText({ text }: { text: string }) {
  return <div className="text-sm whitespace-pre-wrap leading-relaxed text-foreground/90">{text}</div>
}

/** Extracted-article prose (HN/link) rendered from sanitized html. */
function ArticleBody({ html }: { html: string }) {
  return (
    <div
      className="text-sm leading-relaxed text-foreground/90 [&_a]:break-all [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h2]:mb-1 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** Large centered translucent circular play button, layered over a poster.
 *  `playing` flips it into the pause control (the audio branch reuses it as a toggle). */
function PlayOverlay({ onClick, playing = false }: { onClick?: (e: MouseEvent) => void; playing?: boolean }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={playing ? t('timeline.pause') : t('timeline.play')}
      className="absolute inset-0 z-10 flex items-center justify-center"
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70">
        {playing ? <Pause className="size-8 fill-current" /> : <Play className="size-8 translate-x-0.5 fill-current" />}
      </span>
    </button>
  )
}

function VideoView({
  m,
  baseUrl,
  blurb,
  autoplay,
}: {
  m: Extract<Media, { kind: 'video' }>
  baseUrl: string
  /** 挂载即开播——由「用户是点媒体还是点正文进来的」决定，见 Detail 的 autoPlayMedia。 */
  autoplay: boolean
  /** 这条视频没有走 stage(OutPortal) 共享实例时（例如点卡片整行直开详情页），这里自己起的
   *  ArtPlayer 拿不到 App.tsx 那份 blurb 接线——必须从 DetailContent 转发进来，否则简介
   *  在这条路径上哪儿都不画（浮层没画、右面板又被 blurb 判据抹掉），且没有任何报错。 */
  blurb?: string
}) {
  // All provider decoding lives in planVideo — the component only renders the plan,
  // so a new (provider, vid) platform is a package install, not a new case here.
  const plan = planVideo(m, baseUrl)
  // 第三方 iframe 那一档保留自己的"点海报再加载"闸门；dash/file 交给 ArtPlayer，播不播看
  // `autoplay`（进来的那一下点的是媒体才播）。**这里以前写死"进详情页 = 想看"**——那是
  // "只有点缩略图才进得来"年代的假设；点标题也进得来之后，它表现为"点帖子就自己放视频"。
  const [started, setStarted] = useState(plan.kind !== 'iframe')

  // playable streams (DASH + progressive mp4) → Artplayer: themed controls +
  // loading spinner (no dark native one), danmaku-ready, with watch-progress resume.
  if (plan.kind === 'dash' || plan.kind === 'file')
    return (
      <div className="flex h-full w-full items-center justify-center">
        <ArtPlayer media={m} baseUrl={baseUrl} blurb={blurb} autoplay={autoplay} />
      </div>
    )

  // no playable/proxyable stream: just the cover ("源" link already routes out). Center it like the
  // player/image branches — bare `w-full` with no `h-full`/flex sat the poster flush to the top of
  // the pane with a blank gutter below (visible while a video note is still being harvested).
  if (plan.kind === 'poster')
    return (
      <div className="flex h-full w-full items-center justify-center">
        <img src={plan.src} referrerPolicy="no-referrer" className="max-h-[88vh] w-full rounded-lg object-contain" />
      </div>
    )

  if (plan.kind === 'none') return null

  // third-party iframe: click-to-load — show poster + play button, mount on click
  if (!started)
    return (
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full aspect-video overflow-hidden rounded-lg bg-black"
      >
        {/* 这一档 planVideo 只给了 iframe 的 src、没有 poster 字段，所以海报得自己过一次代理
            （其余各档的 plan.poster / plan.src 在 planVideo 里已经过了）。 */}
        {m.poster && (
          <img src={imgUrl(baseUrl, m.poster)} referrerPolicy="no-referrer" className="h-full w-full object-contain" />
        )}
        <PlayOverlay onClick={() => setStarted(true)} />
      </div>
    )
  return (
    <iframe
      src={plan.src}
      title="video"
      className="w-full aspect-video rounded-lg border-0 bg-black"
      allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
      allowFullScreen
      scrolling="no"
    />
  )
}

/** Primary media shown large in the overlay's left pane. A single image fills the
 *  pane; multiple images get a swipeable carousel. The dark gutter around the
 *  media closes the overlay (the parent pane handles that) — so the pixels
 *  themselves stop propagation, and embla distinguishes a drag-swipe from a tap. */
function MediaView({ images, startIndex = 0 }: { images: { url: string; alt?: string }[]; startIndex?: number }) {
  if (images.length === 0) return null
  if (images.length === 1)
    return (
      <img
        src={images[0].url}
        alt={images[0].alt}
        referrerPolicy="no-referrer"
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full object-contain"
      />
    )
  return (
    <div onClick={(e) => e.stopPropagation()} className="h-full w-full">
      <Carousel opts={{ loop: false, startIndex }} className="h-full w-full">
        <CarouselContent className="h-full">
          {images.map((im, i) => (
            <CarouselItem key={i} className="flex h-screen items-center justify-center">
              <img
                src={im.url}
                alt={im.alt}
                referrerPolicy="no-referrer"
                className="h-full w-full object-contain"
              />
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious className="left-3 border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white" />
        <CarouselNext className="right-3 border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white" />
      </Carousel>
    </div>
  )
}

/** Collapsed thumbnail grid for many images: a 3-column grid capped at 6 tiles
 *  (≤2 rows). If there are more than 6 images, the 6th tile gets a dark "+N"
 *  overlay. Clicking any tile calls `onOpen(index)` to enlarge from that image. */
export function GalleryGrid({
  images,
  onOpen,
}: {
  images: { url: string; alt?: string }[]
  onOpen: (index: number) => void
}) {
  const max = 6
  const shown = images.slice(0, max)
  const overflow = images.length - max
  return (
    <div onClick={(e) => e.stopPropagation()} className="grid w-full max-w-3xl grid-cols-3 gap-1.5">
      {shown.map((im, i) => {
        const isLast = i === max - 1 && overflow > 0
        return (
          <button
            key={i}
            type="button"
            onClick={() => onOpen(i)}
            className="relative aspect-square overflow-hidden rounded-md bg-black/20 focus:outline-none focus-visible:outline-none"
          >
            <img
              src={im.url}
              alt={im.alt}
              referrerPolicy="no-referrer"
              loading="lazy"
              className="h-full w-full object-cover"
            />
            {isLast && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-xl font-semibold text-white">
                +{overflow}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function LinkCard({ m }: { m: Extract<Media, { kind: 'link' }> }) {
  return (
    <a href={m.url} target="_blank" rel="noreferrer" className="my-3 block">
      <Card interactive>
        <CardContent className="p-3">
          <div className="truncate text-sm font-medium">{m.title || m.url}</div>
          {m.summary && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{m.summary}</div>}
        </CardContent>
      </Card>
    </a>
  )
}

/** A quoted/forwarded post, shown inline in the info pane. Its media is secondary,
 *  so images render as a small inline grid (the primary media pane is for the
 *  post's own media). */
function QuotedView({ q }: { q: Quoted }) {
  const imgs = (q.media ?? []).filter((m): m is Extract<Media, { kind: 'image' }> => m.kind === 'image')
  const [enlargeIndex, setEnlargeIndex] = useState<number | null>(null)
  const images = imgs.map((m) => ({ url: m.url, alt: m.alt }))
  return (
    <div className="mt-3 rounded-lg bg-[var(--acr-card-nested)] p-3">
      {q.author &&
        (q.permalink ? (
          <a
            href={q.permalink}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mb-1 inline-block text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            @{q.author}
          </a>
        ) : (
          <div className="mb-1 text-xs font-medium text-muted-foreground">@{q.author}</div>
        ))}
      {q.text && <div className="whitespace-pre-wrap text-sm text-foreground/90">{q.text}</div>}
      {images.length > 0 && (
        <div className="mt-2">
          <GalleryGrid images={images} onOpen={(i) => setEnlargeIndex(i)} />
        </div>
      )}
      {enlargeIndex !== null && (
        // 不吃 useOverlayRightInset：这个浮层住在详情页 dialog 的子树里，而生产上详情页
        // 永远是 variant="acrylic"（根节点带 backdrop-blur-2xl）——CSS 规定非 none 的
        // backdrop-filter 会给 fixed 后代造包含块，所以这里的 inset 从来就不是相对视口，
        // 是相对那个已经让过位的 dialog。dialog 的 right 已经停在抽屉左侧了，这里再自己
        // 让一次会让右边界落到抽屉左侧再往左 420px，把详情页正文的一整条露在抽屉外面。
        // jsdom 不做真实布局，测不出包含块这件事，这条判据只能靠这条注释和代码本身守住。
        <div
          data-testid="image-lightbox"
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setEnlargeIndex(null)}
        >
          {/* a quoted image enlarges within the reading column's width, not edge-to-edge */}
          <img
            src={images[enlargeIndex].url}
            alt={images[enlargeIndex].alt}
            referrerPolicy="no-referrer"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] w-auto max-w-2xl rounded-lg object-contain"
          />
        </div>
      )}
    </div>
  )
}

function fmtCount(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
}

function CommentsSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 评论区：小标题 +（骨架 / 空态 / 列表）。评论住在详情档的正文下面，切换器那几格文字
 *  （详情 / 转写 / 对话）不在它头上，所以「评论 N」这个抬头必须由这里自己画——掉了不报错，
 *  只是评论变成一段没头的列表（Detail.panel.test.tsx 钉着它）。
 *
 *  正文仍来自共享的 enrichment hook，分页评论的无限滚动照旧（底部哨兵对着面板的滚动
 *  视口观察，enr.loadMore 续页）。 */
function CommentsPanel({ enr }: { enr: EnrichmentState }) {
  const { t } = useTranslation()
  const { comments, loading, err, hasMore, loadMore } = enr
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return
    const root = el.closest('[data-scroll-root]') as Element | null
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore()
      },
      { root, rootMargin: '400px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadMore])

  if (err && comments.length === 0) return null

  return (
    <>
      {comments.length > 0 || loading ? (
        <div className="mb-3 mt-5 border-t border-border pt-5 text-sm font-medium">
          {t('timeline.comments')}
          {enr.total > 0 ? ` ${fmtCount(enr.total)}` : ''}
        </div>
      ) : null}
      {loading && comments.length === 0 ? (
        <CommentsSkeleton />
      ) : comments.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('timeline.commentsEmpty')}</div>
      ) : (
        <CommentList comments={comments} />
      )}
      <div ref={sentinelRef} className="h-px" />
    </>
  )
}

/**
 * 右面板：**只有详情这一档**，所以没有切换器。
 *
 * 对话曾经是第二档（`ChatStage`），随原生抽屉一起退役——对话入口只剩 DSH 工作台
 * （spec 2026-08-17-native-chat-drawer-removal）。转写更早（2026-08-12）就不在这儿了。
 * 一档不画切换器：一个只有一个选项的分段控件是纯噪声。
 */
function PostPanelTabs({
  detail,
  enr,
}: {
  /** 详情档要画的东西（作者块 / 标题 / 动作行 / 正文）。组件不认识它们是什么——
   *  三个布局分支装的内容不一样（无媒体那档的正文在左栏），由调用方组装。 */
  detail: ReactNode
  /** 评论。**没有评论线程的条目由调用方传 `null`**——详情档无条件画这一块，
   *  判据留在调用方那一份 `hasCommentThread` 上，组件这边只认"有没有给我评论"。 */
  enr: EnrichmentState | null
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        // 面板自己滚。它因此就是评论无限滚动那个哨兵的观察根——CommentsPanel 用
        // closest('[data-scroll-root]') 找最近的一个，不标的话找到的是外面那个不再滚动的壳，
        // rootMargin 预取就对着错的视口算。
        //
        // **20px 内边距在滚动容器里面，不在它外面**：搁外面时这个容器就比右面板窄 20px，
        // 滚动条于是悬在离面板右缘 20px 的地方——看起来像面板没顶满。内容的留白一点没少，
        // 只是滚动条回到了它该在的边上。
        data-scroll-root
        className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-mac"
      >
        {detail}
        {enr ? <CommentsPanel enr={enr} /> : null}
      </div>
    </div>
  )
}

const isImage = (m: Media): m is Extract<Media, { kind: 'image' }> => m.kind === 'image'
const isVid = (m: Media): m is Extract<Media, { kind: 'video' }> => m.kind === 'video'
const isLink = (m: Media): m is Extract<Media, { kind: 'link' }> => m.kind === 'link'

/** Fullscreen reading overlay (X photo-detail style): media fills the left pane,
 *  the post's text + comments scroll independently on the right. Click the dark
 *  media gutter, the ✕, or Esc to close. Items with no media collapse to a single
 *  centered column (X status-page style). All on-demand content (extracted article,
 *  note media/text, comments) flows through one source-blind enrichment hook. */
export function Detail({
  item,
  conn,
  onClose,
  startMediaIndex = 0,
  autoPlayMedia = false,
  variant = 'default',
  onPlayAudio,
  onNavigate,
  canExtract,
}: {
  item: Item | null
  conn: Connection
  onClose: () => void
  startMediaIndex?: number
  /** 开出来就把左边那格视频播起来。**缺省 false**：调用方要显式说"这一下点击是冲着看来的"
   *  （判据在 lib/openDetail.ts 的 autoPlaysDetailMedia）。以前这里没有开关，进详情页
   *  一律自动播——那是"点缩略图才会进详情页"年代的假设，现在点标题/正文也进得来。 */
  autoPlayMedia?: boolean
  variant?: 'default' | 'acrylic'
  /** the timeline's podcast-queue producer (see PostItemRow) — absent → single-track play */
  onPlayAudio?: (item: Item) => void
  /** Wheel-scroll on the left media pane past the edge switches to the prev/next post in
   *  whatever list this item was opened from — absent → the media pane just scrolls/does nothing. */
  onNavigate?: (direction: 'next' | 'prev') => void
  /** 「转成文字」可见性谓词（App 注入：archetype → planExtract → 分支可用性）。
   *  缺席 → 不显示转成文字入口。 */
  canExtract?: (item: Item) => boolean
}) {
  if (!item) return null
  return (
    <DetailContent
      item={item}
      conn={conn}
      onClose={onClose}
      startMediaIndex={startMediaIndex}
      autoPlayMedia={autoPlayMedia}
      variant={variant}
      onPlayAudio={onPlayAudio}
      onNavigate={onNavigate}
      canExtract={canExtract}
    />
  )
}

function DetailContent({
  item,
  conn,
  onClose,
  startMediaIndex,
  autoPlayMedia,
  variant,
  onPlayAudio,
  onNavigate,
  canExtract,
}: {
  item: Item
  conn: Connection
  onClose: () => void
  startMediaIndex: number
  autoPlayMedia: boolean
  variant: 'default' | 'acrylic'
  onPlayAudio?: (item: Item) => void
  onNavigate?: (direction: 'next' | 'prev') => void
  canExtract?: (item: Item) => boolean
}) {
  // Esc closes the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // one source-blind hook: extracted article (link items), a note's own media+text,
  // and normalized comments (whatever the package's enricher returns). No-op for plain items.
  const enr = useEnrichment(item, conn, !!item)
  const stage = useVideoStage()
  const { t } = useTranslation()
  const copyId = () => {
    if (!item) return
    navigator.clipboard.writeText(item.id).catch(() => {})
  }


  // Wheel-scroll on the left media pane switches to the prev/next post (the media pane
  // has no scrollable content of its own, so a wheel gesture there is unambiguous). Trackpad
  // momentum fires many small deltaY events per gesture, so this accumulates past a threshold
  // rather than firing on every event, then cools down for one gesture before re-arming —
  // otherwise one continuous scroll would page through several posts at once.
  const wheelAccum = useRef(0)
  const wheelCooldown = useRef(false)
  useEffect(() => {
    wheelAccum.current = 0
  }, [item.id])
  const onMediaWheel = (e: WheelEvent) => {
    if (!onNavigate || wheelCooldown.current) return
    wheelAccum.current += e.deltaY
    const THRESHOLD = 120
    if (Math.abs(wheelAccum.current) < THRESHOLD) return
    const direction = wheelAccum.current > 0 ? 'next' : 'prev'
    wheelAccum.current = 0
    wheelCooldown.current = true
    onNavigate(direction)
    setTimeout(() => {
      wheelCooldown.current = false
    }, 500)
  }

  const baseUrl = conn.baseUrl
  const legacyHtml = !item.content ? (item.body_html ?? '') : ''
  const art = enr.article

  // media (left pane): prefer the enrichment's media (a note's full image set / video)
  // and fall back to the item's own content media (a feed video, gallery cover).
  const contentMedia = item.content?.media ?? []
  const mediaSource = art?.media && art.media.length ? art.media : contentMedia
  const videos = mediaSource.filter(isVid)
  const images = mediaSource.filter(isImage).map((m) => ({ url: m.url, alt: m.alt }))
  const links = contentMedia.filter(isLink)

  // The audio branch (a podcast episode): the media pane hosts its cover + a play/pause toggle
  // instead of collapsing to a text-only column. Same rules as the feed row: NULLABLE stage
  // (no provider → no affordance), producer-first click, toggle when it's already current.
  const audioStage = useAudioStageOptional()
  const audioTrack = audioStage && videos.length === 0 && images.length === 0 ? toTrack(item, baseUrl, 'podcast') : null
  const audioCurrent = !!audioTrack && audioStage?.current?.id === item.id
  const audioPlaying = audioCurrent && !!audioStage?.playing
  const onAudioActivate = !audioTrack || !audioStage
    ? undefined
    : (e: MouseEvent) => {
        e.stopPropagation()
        if (audioCurrent) audioStage.toggle()
        else if (onPlayAudio) onPlayAudio(item)
        else audioStage.play(audioTrack)
      }
  const hasMedia = videos.length > 0 || images.length > 0 || !!audioTrack

  // 共用播放器实例经 OutPortal 骑走时，真正画出来的那份 blurb 是 App.tsx 自己算的
  // （逐字 overlayBlurb(activeVideo.item)，不带 art?.text/art?.html）——那份实例活在
  // App 里，Detail 够不着它，只能让「判断画不画」的这格和它同源，否则各算各的、
  // 参数一分家就可能得出不同结果。
  const ridesSharedPortal = videos.length > 0 && stage.activeId === item.id && !!stage.node

  // 简介只算一次：媒体台上的浮层和右面板「这段还画不画」读的必须是同一格，
  // 判据一分家就会出现两处各画一份同样的字。骑在共用播放器上时必须和 App.tsx
  // 那份实例逐字同参，否则两边可能算出不同结果（比如 item.content.text 为空、
  // 富化文本只在 Detail 这份 art.text 里才有）：Detail 这边非空 → 常驻浮层被跳过、
  // 右面板被抹掉，portal 那份播放器却拿到空串什么也不画——简介三处同时消失，
  // 且不报错（和上一次修的是同一种失效，参见下面 blurbRidesPlayer 的注释）。
  const blurb = !hasMedia ? '' : ridesSharedPortal ? overlayBlurb(item) : overlayBlurb(item, art?.text, art?.html)

  // 「有视频」不等于「浮层已经有人画了」。真正骑上了 ArtPlayer（浮层随播放器控制条
  // 一起自动隐/显）的只有两条路：①共用实例经 OutPortal（App.tsx 已经给那份实例转发
  // 了 blurb）；②VideoView 自起播放器、落进 dash/file 分支（那两档转发了 blurb，见
  // VideoView 的注释）。planVideo 剩下的 poster/iframe/none 三档根本不起 ArtPlayer——
  // 不能用 videos.length === 0 当替身判据，命中这三档时"有视频"为真但没人画简介，
  // mediaNode 的常驻浮层因 videos.length > 0 被跳过、bodyNode 又因 blurb 非空被抹掉，
  // 简介两处同时消失且不报错（上一次修复只转发了 blurb、没堵上这三档，是同一类缺陷）。
  const blurbRidesPlayer =
    videos.length > 0 &&
    (ridesSharedPortal ||
      videos.some((m) => {
        const kind = planVideo(m, baseUrl).kind
        return kind === 'dash' || kind === 'file'
      }))

  const mediaNode: ReactNode = hasMedia ? (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-4">
      {videos.length > 0 &&
        // the shared inline player (feed videos played in the card) moves in here via its
        // portal — same instance, so expanding from the card never reloads. Other videos
        // (fetched on open via enrichment, iframe) render their own player.
        (stage.activeId === item.id && stage.node ? (
          <div onClick={(e) => e.stopPropagation()} className="h-full w-full">
            <OutPortal node={stage.node} />
          </div>
        ) : (
          <div onClick={(e) => e.stopPropagation()} className="h-full w-full">
            {videos.map((m, i) => (
              <VideoView key={i} m={m} baseUrl={baseUrl} blurb={blurb} autoplay={autoPlayMedia} />
            ))}
          </div>
        ))}
      {/* one image fills the pane; multiple become a swipeable carousel directly
          (the collapsed +X grid lives on the list card, not here). */}
      {images.length > 0 && <MediaView images={images} startIndex={startMediaIndex} />}
      {audioTrack && onAudioActivate ? (
        <div className="relative max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
          {audioTrack.poster ? (
            <img
              src={audioTrack.poster}
              alt=""
              referrerPolicy="no-referrer"
              className="max-h-[80vh] max-w-full rounded-xl object-contain"
            />
          ) : (
            // no cover: still give the toggle a stage to sit on
            <div className="size-64 rounded-xl bg-black/40" />
          )}
          <PlayOverlay playing={audioPlaying} onClick={onAudioActivate} />
          {typeof audioTrack.durationS === 'number' ? (
            <span className="absolute bottom-2 right-2 z-10 rounded-full bg-black/55 px-2.5 py-1 text-[12px] tabular-nums text-white">
              {mmss(audioTrack.durationS)}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* 视频那一档的浮层挂在播放器自己身体里（跟控制条同生共死，见 ArtPlayer），所以这里
          只画给"没有会自动隐的控制条"的形态：播客封面、图集。 */}
      {blurb && !blurbRidesPlayer ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
          <BlurbOverlay text={blurb} />
        </div>
      ) : null}
    </div>
  ) : null

  // body (right / center pane)
  let bodyNode: ReactNode
  if (art?.html) {
    bodyNode = (
      <>
        {(art.domain || art.wordCount) && (
          <div className="mb-3 text-xs text-muted-foreground">
            {art.domain}
            {art.domain && art.wordCount ? ' · ' : ''}
            {art.wordCount ? t('timeline.wordCount', { n: art.wordCount }) : ''}
          </div>
        )}
        <ArticleBody html={art.html} />
      </>
    )
  } else {
    // A forward/quoted post (xueqiu) keeps its own comment as the body and routes `art`
    // (when enrichment fetched the quoted post's full, un-truncated text) into QuotedView
    // instead — unlike link/HN/xhs, where `art` (or its absence) IS the whole body.
    const isForward = !!item.content?.quoted
    bodyNode = (
      <>
        {blurb ? null : art?.text && !isForward ? (
          <BodyText text={art.text} />
        ) : item.content?.text ? (
          <BodyText text={item.content.text} />
        ) : null}
        {!art && links.map((m, i) => <LinkCard key={i} m={m} />)}
        {item.content?.quoted && (
          <QuotedView q={art?.text ? { ...item.content.quoted, text: art.text } : item.content.quoted} />
        )}
        {!art && !item.content && legacyHtml && (
          <div
            className="text-sm leading-relaxed text-foreground/90 [&_a]:break-all [&_a]:text-primary [&_a]:underline [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg"
            dangerouslySetInnerHTML={{ __html: legacyHtml }}
          />
        )}
        {enr.loading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        )}
        {enr.err && <div className="text-sm text-muted-foreground">{t('timeline.bodyLoadFailed')}</div>}
      </>
    )
  }

  // 可见性判别式**只有一份**：canExtract 谓词由 App 注入（archetype → planExtract →
  // 分支可用性，shared/extract/plan.ts），这里不重算嗅探逻辑。
  const canExtractItem = canExtract?.(item) ?? false
  // 这里曾经算一格 sttLikely（「这条大概率走语音转写」），唯一的消费方是那个已经撤掉的
  // 「识别发言人」开关。走哪条分支由后端 planExtract 判，前端不需要预判。
  // 下载可见性和列表行(PostItemRow)读同一个派生层，别开第三个副本。
  const { videoDl, canDownload } = usePostPresentation(item)
  // 「这条有没有右面板」**只有这一份判据**（下面 readingHasPanel 也吃它）。两份说法一旦分家，
  // 就会出现"面板恒在场、但布局按没面板排"这种两边单看都正常的错位：纯图文帖（没评论、
  // 取不了正文）那一栏底下会平白多出一块占满高度的对话，而且打开它就让外面的抽屉退场——
  // 设计明说不动纯图文帖那一档的版面。
  const hasArtifacts = hasCommentThread(item) || canExtractItem

  const headerNode = (
    <>
      {/* author block: avatar + name as a unit, time directly below the name,
          "⋯" debug menu top-right. Items without a carried avatar whose package declared
          an author enricher (item.author_enrich) resolve it via AuthorChip (async), inline. */}
      <div className="mb-3 flex items-start gap-3">
        <SourceAvatar
          realAvatar={item.author_avatar}
          favicon={sourceIconFallbackUrl(item.stream_id, undefined, item.source_site?.domain) ?? faviconUrl(conn.baseUrl, item.url)}
          name={typeof item.author === 'string' ? item.author : (item.stream_id ?? '')}
          className="size-10"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {item.author_enrich && typeof item.author === 'string' && item.author ? (
              <AuthorChip name={item.author} enrich={item.author_enrich} conn={conn} />
            ) : typeof item.author === 'string' && item.author ? (
              item.author
            ) : (
              item.stream_id
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{fmtTime(item.timestamp)}</span>
            <Badge size="sm" className="truncate">
              {sourceLabel(item)}
            </Badge>
          </div>
        </div>
        {/* 可点动作（点赞 / 收藏…）由产出这条的包声明、后端投影；前端不判站。 */}
        {item.actions?.length ? <ItemActionButtons actions={item.actions} className="shrink-0" /> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <AcrylicButton variant="ghost" size="large" icon className="size-8 shrink-0">
              <MoreHorizontal className="size-4" />
            </AcrylicButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={copyId}>
                <Clipboard className="size-4" />
                <span>Copy Item ID</span>
                <DropdownMenuShortcut>{item.id.slice(0, 8)}</DropdownMenuShortcut>
              </DropdownMenuItem>
              {item.source_id && (
                <DropdownMenuItem onClick={() => { navigator.clipboard.writeText(item.source_id!).catch(() => {}) }}>
                  <Clipboard className="size-4" />
                  <span>Copy Source ID</span>
                  <DropdownMenuShortcut>{item.source_id.slice(0, 8)}</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              {item.url && (
                <DropdownMenuItem onClick={() => { navigator.clipboard.writeText(item.url!).catch(() => {}) }}>
                  <Clipboard className="size-4" />
                  <span>Copy URL</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Item ID</DropdownMenuLabel>
            <DropdownMenuItem disabled className="font-mono text-[11px] text-muted-foreground">
              {item.id}
            </DropdownMenuItem>
            <DropdownMenuLabel>Stream</DropdownMenuLabel>
            <DropdownMenuItem disabled className="text-[11px] text-muted-foreground">
              {item.stream_id}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <h1 className="mb-1 text-lg font-semibold leading-snug">{item.title}</h1>
      {/* 这一行是 Detail 的动作面：原页链接、解析、下载、标签。瀑布流卡片不常驻动作条，
          所以解析/下载必须在这里有入口，否则搜索页（默认瀑布流）上这两件事全站没有第二个
          落点。加了按钮就可能挤，故允许换行。 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{item.content?.archetype ?? item.type}</Badge>
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            {t('timeline.source')}
          </a>
        )}
        {canDownload ? (
          <AcrylicButton variant="neutral" size="small" onClick={() => triggerDownload(videoDl)}>
            <Download className="size-4" />
            {t('timeline.download')}
          </AcrylicButton>
        ) : null}
        {canExtractItem ? (
          <AcrylicButton
            variant="neutral"
            size="small"
            onClick={() => void askExtract(conn, item)}
          >
            <FileText className="size-4" />
            {t('timeline.extract')}
          </AcrylicButton>
        ) : null}
        {/* 这里曾经挨着一个「识别发言人」开关。撤掉了：`extract` 工具自己就吃 diarize/rerun，
            识不识别、要不要重跑由模型按用户在对话里说的话定——UI 上再留一个开关，就是同一个
            决定有两个不打招呼的来源。 */}
        <div className="ml-auto shrink-0">
          <LabelSelect item={item} conn={conn} />
        </div>
      </div>
    </>
  )

  const articleNode = (
    <div className="mx-auto w-full max-w-3xl px-6 py-8 md:px-10">
      {bodyNode}
    </div>
  )

  // 有媒体那一档（info 的右列）：作者头 + 正文都进详情插槽，左边是播放器。
  // **必须在 headerNode / bodyNode 之后声明**：插槽在这里就被求值，早一行就是 TDZ 报错。
  const mediaPanelNode: ReactNode = hasArtifacts ? (
    <PostPanelTabs detail={<>{headerNode}{bodyNode}</>} enr={hasCommentThread(item) ? enr : null} />
  ) : null

  // 无媒体 + 有面板那一档：详情插槽里**只有作者头**，正文在左栏（articleNode）。
  // 别为了和上面对齐而把 bodyNode 也塞进来——那是同一篇正文的第二份。
  const readingPanelNode: ReactNode = hasArtifacts ? (
    <PostPanelTabs detail={headerNode} enr={hasCommentThread(item) ? enr : null} />
  ) : null

  const info = (
    <div
      data-scroll-root
      className={cn(
        // flex 列 + min-h-0：面板要吃掉头部/正文之后的**剩余**高度并自己内部滚，
        // 随内容长高的老写法会让它塌成 0 高。
        'scrollbar-mac flex h-full w-full flex-col overflow-y-auto',
        variant === 'acrylic'
          ? 'bg-[var(--acr-panel)] text-foreground backdrop-blur-xl'
          : 'bg-card'
      )}
    >
      {/* 这一块**同时服务两种形态**：有面板时它就是那两档（作者头和正文都在详情档里）；
          没面板时（纯图文帖走单栏阅读页）它必须照常画作者头 + 正文，否则整页空白。 */}
      {/* 有面板那一档的内边距由 `PostPanelTabs` 的滚动容器自己加（见那边的注释）；
          没面板那一档没有内层滚动容器，内边距只能加在这儿。 */}
      <div className={cn('flex min-h-0 flex-1 flex-col', hasArtifacts ? '' : 'p-5')}>
        {hasArtifacts ? mediaPanelNode : (
          <>
            {headerNode}
            {bodyNode}
          </>
        )}
      </div>
    </div>
  )
  // 无媒体时才有这个岔路：有评论/能转成文字的条目分成「正文居中 + 右侧 480 面板」两栏；
  // 什么都没有的纯图文帖仍是一栏居中读（面板跟着正文走，对话就在它下面）。
  const readingHasPanel = !hasMedia && hasArtifacts

  // 有媒体 = 播放形态,走共享外壳(影视频道分集播放用的是同一个 DetailShell,右侧插槽换内容)。
  if (hasMedia) {
    return (
      <DetailShell media={mediaNode} panel={info} onClose={onClose} variant={variant} onMediaWheel={onMediaWheel} />
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      // acrylic overlay 参与 modal-acrylic 涂层：use-modal-acrylic 已从挂载计数改为按 DOM 事实
      // [role=dialog][data-state=open] 判定开态，故这个自定义全屏 overlay 必须自报 data-state=open，
      // ModalAcrylicBody 的观察器才能把 html.modal-acrylic 点亮（磨砂背板赖此）。
      {...(variant === 'acrylic' ? { 'data-state': 'open' } : {})}
      className={cn(
        'fixed inset-0 z-50 flex',
        variant === 'acrylic'
          ? 'bg-[var(--acr-overlay)] backdrop-blur-2xl'
          : 'bg-background'
      )}
    >
      {variant === 'acrylic' ? <ModalAcrylicBody /> : null}
      {/* single close affordance, top-left (matches the video player's back button).
          三态与 DetailShell 那一颗同源（反馈走 ::before 的白色薄层，不动底下那层黑），
          理由见那里的注释——**别只留 `hover:!bg-black` 就完事**，那等于把 hover 一起压没。 */}
      <AcrylicButton
        variant="ghost"
        size="xl"
        icon
        onClick={onClose}
        aria-label={t('timeline.back')}
        className="fixed left-4 top-4 z-[60] !bg-black !text-white shadow-sm hover:!bg-black active:!bg-black overflow-hidden before:pointer-events-none before:absolute before:inset-0 before:rounded-full before:bg-white/0 before:transition-colors hover:before:bg-white/15 active:before:bg-white/25 [&>svg]:relative [&>svg]:z-10"
      >
        <ArrowLeft />
      </AcrylicButton>
      {readingHasPanel ? (
        <div className="flex h-full w-full flex-col lg:flex-row">
          <main
            className={cn(
              'min-h-0 min-w-0 flex-1 overflow-hidden',
              variant === 'acrylic'
                ? 'bg-[var(--acr-panel)] text-foreground backdrop-blur-xl'
                : 'bg-background'
            )}
            onClick={onClose}
          >
            <div
              className="scrollbar-mac h-full w-full overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {articleNode}
            </div>
          </main>
          <aside
            className={cn(
              'h-[42%] w-full shrink-0 border-t lg:h-full lg:w-[480px] lg:border-l lg:border-t-0',
              variant === 'acrylic'
                ? 'border-[var(--acr-border-soft)] shadow-[0_0_0_1px_var(--acr-border-soft)]'
                : 'border-border'
            )}
          >
            <div
              data-scroll-root
              className={cn(
                // 同 info：flex 列，让对话档吃掉作者头之后的剩余高度。
                'scrollbar-mac flex h-full w-full flex-col overflow-y-auto',
                variant === 'acrylic'
                  ? 'bg-[var(--acr-panel)] text-foreground backdrop-blur-xl'
                  : 'bg-card'
              )}
            >
              {/* 内边距同上：这一档装的就是 `PostPanelTabs`，它自己在滚动容器里加。 */}
              <div className="flex min-h-0 flex-1 flex-col">{readingPanelNode}</div>
            </div>
          </aside>
        </div>
      ) : (
        // no media → single centered reading column (X status-page style); clicking
        // the empty side gutters closes, like the media gutter does.
        <div className="flex h-full w-full justify-center" onClick={onClose}>
          <div
            className={cn(
              'h-full w-full max-w-2xl border-x',
              variant === 'acrylic' ? 'border-[var(--acr-border-soft)] shadow-[0_0_0_1px_var(--acr-border-soft)]' : 'border-border'
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {info}
          </div>
        </div>
      )}
    </div>
  )
}
