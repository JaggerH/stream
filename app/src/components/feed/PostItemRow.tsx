// The timeline post row: one feed item rendered as an acrylic Item with media preview and
// inline video. **没有动作条**——这条内容的动作全在右键菜单里（ItemContextMenu）。Reused by
// the main timeline, global search results, and the stream PreviewModal.
import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LayersIcon, PauseIcon, PlayIcon } from 'lucide-react'

import { LOCAL } from '../../lib/api.ts'
import type { Item as StreamItem } from '../../lib/types.ts'
import { formatTime, mmss, type MediaPreview } from '../../lib/feedPresent.ts'
import { usePrefetchOnApproach } from '../../lib/preload.ts'
import { usePostPresentation } from '../../lib/postPresentation.ts'
import type { OpenDetailOptions } from '../../lib/openDetail.ts'
import type { VideoMedia } from '../../lib/videoPlan.ts'
import { useVideoStage } from '../../lib/videoStage.ts'
import { Avatar, AvatarFallback, AvatarImage } from '../acrylic/avatar.tsx'
import { Badge } from '../acrylic/badge.tsx'
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '../acrylic/item.tsx'
import { MediaBox, MEDIA_BOX_MAX_VIDEO_HEIGHT } from '../acrylic/media-box.tsx'
import { MediaBoxPlayer } from '../MediaBoxPlayer.tsx'
import { ItemContextMenu } from './ItemContextMenu.tsx'
import { ItemActionButtons } from './ItemActionButtons.tsx'

// Width is the only cap the feed sets itself. HEIGHT is deliberately left to MediaBox's own
// ceilings (MEDIA_BOX_MAX_IMAGE_HEIGHT / MEDIA_BOX_MAX_VIDEO_HEIGHT) — passing a `maxHeight`
// here OVERRIDES them, and a generous one silently disables the cap: the feed used to pass
// 920, which let portrait photos render 626–853px tall while a video poster in the same list
// still stopped at 507. Don't reintroduce a maxHeight without a reason the component's own
// default can't express.
const POST_MEDIA_MAX_WIDTH = 520

/**
 * 媒体的可点区域 = **画面本身**，不是那条 `w-full` 的外框。
 *
 * MediaBox 是两层：外层 `[data-slot=media-box]` 恒占满整列宽（列表里 490px），里层
 * `[data-slot=media-box-frame]` 才是按媒体比例算出来的画面（竖版视频 507×9/16 ≈ 285px，
 * 左对齐）。把 onClick 交给 MediaBox 自己（`{...props}` 落在外层）时，画面右边那条
 * 205px 的空档就成了"看不见的播放键"：用户点的是空白，触发的是播放。
 *
 * 所以交互挂在这一层——它是 MediaBox 的 **children**，而 children 渲染在 frame 里面，
 * `absolute inset-0` 正好铺满画面、一个像素都不多。空档因此回落给行本身（= 打开详情），
 * 这也是用户对"点空白处"的预期。
 *
 * 横版视频/正方图看不出差别（画面本来就铺满整列），所以这个缺陷只在**竖版**上显形——
 * 别用横版去验它。
 */
function MediaHitArea({
  label,
  onActivate,
  children,
}: {
  label: string
  onActivate: () => void
  children?: ReactNode
}) {
  return (
    <div
      data-slot="media-hit"
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      className="absolute inset-0 flex items-center justify-center"
      onClick={(event) => {
        event.stopPropagation()
        onActivate()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        onActivate()
      }}
    >
      {children}
    </div>
  )
}

export function PostItemRow({
  item,
  last,
  onOpen,
  onPlayAudio,
}: {
  item: StreamItem
  last: boolean
  onOpen: (item: StreamItem, opts?: OpenDetailOptions) => void
  /** the timeline's podcast-queue producer: play this item AND queue the surrounding feed's
   *  audio items behind it. Absent (PreviewModal) → the row falls back to a single-track play. */
  onPlayAudio?: (item: StreamItem) => void
}) {
  return (
    <>
      <FeedPostItem item={item} onOpen={onOpen} onPlayAudio={onPlayAudio} />
      {!last ? <ItemSeparator className="mx-3 bg-[var(--acr-border-soft)]" /> : null}
    </>
  )
}

function FeedPostItem({
  item,
  onOpen,
  onPlayAudio,
}: {
  item: StreamItem
  onOpen: (item: StreamItem, opts?: OpenDetailOptions) => void
  onPlayAudio?: (item: StreamItem) => void
}) {
  const prefetchRef = usePrefetchOnApproach<HTMLDivElement>(item, LOCAL)
  const {
    media, firstMedia, video, isVideoNote,
    audioTrack, audioPlaying, onAudioActivate,
    title, summary, quoted, avatar,
    videoDl, canDownload, actions,
  } = usePostPresentation(item, { onPlayAudio })

  // 行本身抽成一个变量、再由右键菜单包起来，这样行的结构一个字都不用改。
  const row = (
    <Item
      ref={prefetchRef}
      data-item-id={item.id}
      variant="outline"
      role="button"
      tabIndex={0}
      // 点行（标题/摘要/作者/空白处）= 读，不是看：详情页开出来别自己把视频播起来。
      // 媒体区那一格自己带 intent:'watch'（见下面 PostMedia），两者不能共用一个默认值——
      // 这正是 onOpen 从 `mediaIndex?` 换成 `OpenDetailOptions` 的原因。
      onClick={() => onOpen(item, { intent: 'read' })}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(item, { intent: 'read' })
        }
      }}
      className="group/row w-full cursor-pointer items-start !bg-transparent !backdrop-blur-none hover:!bg-transparent focus-visible:border-transparent focus-visible:ring-0"
    >
      <ItemHeader className="flex-row items-center gap-3">
        <ItemMedia variant="avatar">
          <Avatar>
            {avatar ? <AvatarImage src={avatar} alt="" className="object-cover" /> : null}
            <AvatarFallback>
              <LayersIcon className="size-3.5" />
            </AvatarFallback>
          </Avatar>
        </ItemMedia>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <div className="min-w-0">
            <ItemTitle>{item.author || item.stream_id}</ItemTitle>
            <ItemDescription>
              {item.stream_id} · {formatTime(item.timestamp)}
            </ItemDescription>
          </div>
          {/* 带状态的东西留在外面——点赞/收藏藏进右键菜单就看不见自己赞没赞了
              （其余动作全在菜单里，见 ItemContextMenu）。hover 才浮出：它是低频动作，
              常驻只会把这一行挤窄。位置和瀑布流卡片对齐——都在那条 meta 行的末尾。 */}
          {actions.length ? (
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
              <ItemActionButtons actions={actions} />
            </div>
          ) : null}
          <Badge variant="secondary" size="sm">{item.type}</Badge>
        </div>
      </ItemHeader>

      <ItemContent className="-my-2 pl-[52px] pr-2.5">
        {/* Untitled posts have no title line at all. Older items stored a literal "(无标题)"
            placeholder; treat that (and blank) as no title. */}
        {title ? <ItemTitle className="whitespace-normal text-[14px]">{title}</ItemTitle> : null}
        {summary ? (
          <ItemDescription className="mt-1 line-clamp-3">
            {summary}
          </ItemDescription>
        ) : null}
        {/* 原帖走派生层的 quoted，不再自己读 item.content.quoted：它和 summary 是同一件事的
            两半（转发语为空时摘要要让位给这里，见 feedPresent.postSummary），拆在两处迟早分叉。 */}
        {quoted ? (
          <div className="mt-2 line-clamp-2 border-l-2 border-[var(--acr-border-soft)] pl-2.5 text-[13px] text-muted-foreground">
            {quoted.author ? <span className="font-medium text-foreground/70">@{quoted.author}：</span> : null}
            {quoted.text}
          </div>
        ) : null}
        {video ? (
          <InlineVideoPreview item={item} media={video} poster={firstMedia?.src} className="mt-2" />
        ) : audioTrack && onAudioActivate ? (
          <InlineAudioPreview poster={firstMedia?.src} playing={audioPlaying} durationS={audioTrack.durationS} onActivate={onAudioActivate} />
        ) : firstMedia ? (
          <PostMedia
            media={media}
            compact
            isVideo={isVideoNote}
            onOpen={(index) => onOpen(item, { mediaIndex: index, intent: 'watch' })}
          />
        ) : null}
      </ItemContent>
    </Item>
  )

  // 动作条没了：这条内容的动作全在右键菜单里（转成文字 / 打开原文 / 下载）。别把任何一格加回
  // 行上——常驻 × 118 行就是 118 排噪音，理由见 ItemContextMenu。
  return (
    <ItemContextMenu item={item} videoDl={canDownload ? videoDl : undefined}>
      {row}
    </ItemContextMenu>
  )
}

function InlineVideoPreview({
  item,
  media,
  poster,
  className = 'mt-3',
}: {
  item: StreamItem
  media: VideoMedia
  poster?: string
  className?: string
}) {
  const stage = useVideoStage()
  const inlineRef = useRef<HTMLDivElement>(null)
  const playingInline = !!stage.node && stage.activeId === item.id && stage.openId !== item.id
  const preview = poster || media.poster

  useEffect(() => {
    if (!playingInline) return
    if (typeof IntersectionObserver === 'undefined') return
    const el = inlineRef.current
    if (!el) return
    const root = el.closest('[data-slot="shell-content"]') as Element | null
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) el.querySelector('video')?.pause()
      },
      { root, threshold: 0 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [playingInline])

  if (playingInline) {
    return (
      <div ref={inlineRef} data-slot="acrylic-inline-video">
        <MediaBox
          kind="video"
          src={preview}
          mediaSize={stage.videoSize ? { width: stage.videoSize.w, height: stage.videoSize.h } : null}
          className={className}
          maxWidth={POST_MEDIA_MAX_WIDTH}
          videoMaxHeight={MEDIA_BOX_MAX_VIDEO_HEIGHT}
        >
          {/* 「点播放器不要顺手打开详情」这一刀**只能盖住播放器本身**。它以前挂在外面那层
              `w-full` 的 div 上，于是竖版视频右边那条空档也被它吃掉——点上去既不播放也不
              打开详情，什么都不发生（用户看到的"这块区域是死的"就是这里）。放进 children =
              放进 frame，正好只盖住画面。 */}
          <div className="h-full w-full" onClick={(event) => event.stopPropagation()}>
            <MediaBoxPlayer node={stage.node!} />
          </div>
        </MediaBox>
      </div>
    )
  }

  return (
    <MediaBox
      kind="video"
      src={preview}
      className={className}
      maxWidth={POST_MEDIA_MAX_WIDTH}
      videoMaxHeight={MEDIA_BOX_MAX_VIDEO_HEIGHT}
    >
      {/* 播放键铺满画面本身（见 MediaHitArea）——竖版视频右边那条空档不归它，归行。 */}
      <MediaHitArea label="播放视频" onActivate={() => stage.play(item, media)}>
        <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white shadow-sm">
          <PlayIcon className="size-5 translate-x-px fill-current" />
        </span>
      </MediaHitArea>
    </MediaBox>
  )
}

/** The audio item's feed preview: its cover with a ▶/⏸ control (podcast episodes), or — when the
 *  episode carries no cover — a bare round play control. Clicking never opens the detail overlay
 *  (stopPropagation): play-in-place is the whole point of the audio branch. */
function InlineAudioPreview({
  poster,
  playing,
  durationS,
  onActivate,
}: {
  poster?: string
  playing: boolean
  durationS?: number
  onActivate: () => void
}) {
  const { t } = useTranslation()
  const label = playing ? t('timeline.pause') : t('timeline.play')
  const glyph = playing ? <PauseIcon className="size-5 fill-current" /> : <PlayIcon className="size-5 translate-x-px fill-current" />
  const control = (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        onActivate()
      }}
      className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white shadow-sm transition-colors hover:bg-black/70"
    >
      {glyph}
    </button>
  )

  if (!poster) {
    return (
      <div className="mt-2 flex items-center gap-2.5" onClick={(event) => event.stopPropagation()}>
        {control}
        {typeof durationS === 'number' ? (
          <span className="text-[12px] tabular-nums text-muted-foreground">{mmss(durationS)}</span>
        ) : null}
      </div>
    )
  }

  return (
    <MediaBox kind="image" src={poster} className="mt-2" maxWidth={POST_MEDIA_MAX_WIDTH}>
      <div className="absolute inset-0 flex items-center justify-center">{control}</div>
      {typeof durationS === 'number' ? (
        <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] tabular-nums text-white">
          {mmss(durationS)}
        </span>
      ) : null}
    </MediaBox>
  )
}

function PostMedia({
  media,
  compact = false,
  isVideo = false,
  onOpen,
}: {
  media: MediaPreview[]
  compact?: boolean
  /** a video note whose stream isn't resolved yet → show the cover WITH a ▶ badge, so it reads as
   *  a video rather than a plain image (tapping opens the note, where enrichment resolves playback). */
  isVideo?: boolean
  onOpen?: (index: number) => void
}) {
  const first = media[0]
  if (!first) return null

  if (media.length > 1 && !compact) {
    return (
      <div className="mt-3 grid max-w-xl grid-cols-2 gap-2">
        {media.slice(0, 4).map((entry, idx) => (
          <button
            key={`${entry.src}-${idx}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onOpen?.(idx)
            }}
            className="relative overflow-hidden rounded-[9px] border border-[var(--acr-border)] bg-[var(--acr-card-nested)]"
          >
            <img src={entry.src} alt={entry.alt || ''} referrerPolicy="no-referrer" className="aspect-square size-full object-cover" loading="lazy" />
            {idx === 3 && media.length > 4 ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/45 text-[13px] font-medium text-white">
                +{media.length - 4}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    )
  }

  // Badge goes as MediaBox CHILDREN, not around it: children render inside `media-box-frame`, the
  // element actually sized to the cover (box.width/height). Wrapping MediaBox externally centered the
  // ▶ over the w-full outer (post width), not the card — the bug this replaces.
  return (
    <MediaBox
      // A video note whose playback isn't resolved yet renders here as its poster; treat it as
      // video so the vertical-video height cap applies (else a 9:16 poster runs to the image
      // maxHeight and dwarfs the feed).
      kind={isVideo ? 'video' : 'image'}
      src={first.src}
      alt={first.alt}
      naturalWidth={first.w}
      naturalHeight={first.h}
      className="mt-2"
      maxWidth={compact ? POST_MEDIA_MAX_WIDTH : undefined}
      videoMaxHeight={compact && isVideo ? MEDIA_BOX_MAX_VIDEO_HEIGHT : undefined}
    >
      {/* 「点这张图 = 从这张开始看」同样只认画面本身（竖图的右边空档归行，见 MediaHitArea）。
          没有 onOpen（PreviewModal 那条路）时不铺这一层，空档和画面一样落回行。 */}
      {onOpen ? (
        <MediaHitArea label={isVideo ? '视频' : '查看大图'} onActivate={() => onOpen(0)}>
          {isVideo ? (
            <span className="flex size-9 items-center justify-center rounded-full bg-black/55 pl-0.5 text-[15px] text-white">▶</span>
          ) : null}
        </MediaHitArea>
      ) : isVideo ? (
        <div aria-label="视频" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-black/55 pl-0.5 text-[15px] text-white">▶</span>
        </div>
      ) : null}
    </MediaBox>
  )
}
