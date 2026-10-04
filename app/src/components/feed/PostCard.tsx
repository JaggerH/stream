// 瀑布流的贴文卡片。和 PostItemRow 读同一份 usePostPresentation——差别只在排版。
//
// 砍掉的东西和为什么：列表行挂了八样(头像/作者/来源·时间/type badge/标题/3行摘要/520px
// 媒体/7按钮动作条)，在 ~260px 宽的卡里全塞进去，密度会**低于**现状。这一屏用户扫的是
// "这条值不值得点开"，不是"这条能干哪七件事"。所以：type badge 去掉、动作条不常驻
// (hover 才浮出)、视频只出封面不内联播放(多列同时播放是灾难，且内联视频会改变卡片高度
// 把整列往下顶)。
//
// 无图条目画成纯文字卡：Stream 的流里有大量纯文本 RSS 条目，这跟全是图的 Pinterest 不一样。
// 不造假封面(色块/首字母没有信息量，只是在骗眼睛)、也不过滤掉它们(那是在丢内容)。
// 而这恰好是瀑布流对 Stream 成立的理由——文字卡矮、图卡高，错落是内容本身给的。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LayersIcon, PauseIcon, PlayIcon } from 'lucide-react'

import { LOCAL } from '../../lib/api.ts'
import type { Item as StreamItem } from '../../lib/types.ts'
import { formatTime, mmss } from '../../lib/feedPresent.ts'
import { usePostPresentation } from '../../lib/postPresentation.ts'
import type { OpenDetailOptions } from '../../lib/openDetail.ts'
import { clampMediaRatio, DEFAULT_MEDIA_ASPECT } from '../../lib/masonry.ts'
import { getMediaSize, rememberMediaSize } from '../../lib/mediaSize.ts'
import { usePrefetchOnApproach } from '../../lib/preload.ts'
import { Avatar, AvatarFallback, AvatarImage } from '../acrylic/avatar.tsx'
import { Card, CardDescription, CardMedia, CardTitle } from '../acrylic/card.tsx'
import { ItemContextMenu } from './ItemContextMenu.tsx'
import { ItemActionButtons } from './ItemActionButtons.tsx'
import { cn } from '../../lib/utils.ts'
// 悬停反馈复用 MediaCard 导出的那一份，不再本地重复一遍同样的五行 class 字符串——
// 两份拷贝迟早会在改 timing 时漂开（这条常量本身就是"别手挑时长"的产物）。
import { HOVER_FLOAT } from '../MediaCard.tsx'

// aria-label 落到 summary 兜底时，summary 可能是一整段正文——朗读一整段对屏幕阅读器
// 用户没有意义，截到这个长度加省略号。
const SUMMARY_LABEL_MAX = 60

export function PostCard({
  item,
  onOpen,
  onPlayAudio,
}: {
  item: StreamItem
  onOpen: (item: StreamItem, opts?: OpenDetailOptions) => void
  onPlayAudio?: (item: StreamItem) => void
}) {
  const { t } = useTranslation()
  const prefetchRef = usePrefetchOnApproach<HTMLDivElement>(item, LOCAL)
  const {
    firstMedia, isVideoNote, video, audioTrack, audioPlaying, onAudioActivate,
    title, summary, quoted, avatar, videoDl, canDownload, actions,
  } = usePostPresentation(item, { onPlayAudio })

  const cover = firstMedia
  // 比例的三档优先级：**学到的真实尺寸 > 条目声明的尺寸 > 占位比例**。
  //
  // 学到的排第一，是因为声明的那份被证伪过：实测有框子声明 1080/1920（竖），里面装的图
  // 真实比例是 1.33（横）——短视频的尺寸被挂到了封面图上。CardMedia 是 object-cover，
  // 比例给错就是把图裁成不属于它的形状，而瀑布流恰恰靠比例参差才成立。
  //
  // 占位比例必须是估高器用的那一个（DEFAULT_MEDIA_ASPECT）：否则封面框塌成 auto（图没
  // 加载完就是 0 高），估高器却已经按默认比例记了账，列高对不上。
  //
  // bump 只为触发一次重渲染——真值存在模块级缓存里（估高器读的是同一份），组件自己不持有。
  const [, bumpLearned] = useState(0)
  const learned = getMediaSize(cover?.src)
  const dims = learned ?? (cover?.w && cover?.h ? { w: cover.w, h: cover.h } : undefined)
  // 比例带和估高器共用同一个 clampMediaRatio（不是各自抄一遍 min/max——这条链上"只改一端"
  // 已经出过三次事）。落在带内的原样还原，出界的夹住并由 object-cover 裁掉多出来的部分：
  // 竖屏视频封面会裁上下约 30%，这是故意的，忠实还原就是 266px 的列里一根 472px 的塔。
  const rawRatio = dims ? dims.h / dims.w : undefined
  const clamped = rawRatio === undefined ? undefined : clampMediaRatio(rawRatio)
  const ratio =
    dims && clamped !== undefined
      ? clamped === rawRatio
        ? `${dims.w} / ${dims.h}`   // 带内：保留原始数字，devtools 里一眼能认出是哪张图
        : `1 / ${clamped}`          // 出界：夹到边界值
      : DEFAULT_MEDIA_ASPECT
  const summaryLabel = summary.length > SUMMARY_LABEL_MAX ? `${summary.slice(0, SUMMARY_LABEL_MAX)}…` : summary
  const label = title || summaryLabel || item.author || item.stream_id
  const isVideo = isVideoNote || !!video
  // 视频的时长不在 audioTrack 里——usePostPresentation 判定为视频时会直接把 audioTrack 置空
  // (postPresentation.ts:audioStage && !video && !isVideoNote)，所以只读 audioTrack?.durationS
  // 的话，"封面 + ▶ 角标 + 时长"里的时长在视频卡上永远画不出来。视频时长的真相源是条目自己的
  // video 媒体项(types.ts 的 duration_s，和 audio 同名字段)。
  const videoDurationS = item.content?.media?.find((m) => m.kind === 'video')?.duration_s
  const durationS = isVideo ? videoDurationS : audioTrack?.durationS

  // 音频播放控件抽出来复用：有封面时浮在封面中央，没封面时跟在文字下面（见下面两处）。
  // 抽这一层的理由不是省字数，是**不让两条分支各写一份点击语义**——onAudioActivate 的队列
  // 语义、stopPropagation（不让点播放变成打开详情）只写一次。
  const audioControl =
    audioTrack && onAudioActivate ? (
      <button
        type="button"
        aria-label={audioPlaying ? t('timeline.pause') : t('timeline.play')}
        onClick={(event) => {
          event.stopPropagation()
          onAudioActivate()
        }}
        className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white shadow-sm transition-colors hover:bg-black/70"
      >
        {audioPlaying ? <PauseIcon className="size-5 fill-current" /> : <PlayIcon className="size-5 translate-x-px fill-current" />}
      </button>
    ) : null

  // 卡片本身抽成一个变量、再由右键菜单包起来（和列表行共用 ItemContextMenu），这样卡片的
  // 结构一个字都不用改。
  const card = (
    <div
      ref={prefetchRef}
      data-nested-surface="true"
      data-item-id={item.id}
      role="button"
      tabIndex={0}
      aria-label={label}
      // 卡片主体（标题/摘要/作者/空白处）= 读。封面那一格自己声明 'watch'（见下面 CardMedia），
      // 所以"点封面进去就播"这条既有行为在瀑布流里原样保留，点文字则安静地开着。
      onClick={() => onOpen(item, { intent: 'read' })}
      onKeyDown={(event) => {
        // 只处理直接落在卡片根节点上的按键。音频播放按钮和外链的 Enter/Space 有各自的
        // 原生激活语义（keydown 冒泡到这里时 event.target 还是那个嵌套元素，
        // event.currentTarget 才是这层根 div）——根节点若在这一步 preventDefault，
        // 会连着把外链的 Enter 打开、按钮的 Space 触发点击一起吃掉，详情反而弹出来。
        // 用 target 守卫统一挡住"来自嵌套控件的按键"，比在每个嵌套控件的 onKeyDown 里
        // 各自补 stopPropagation 更省心——以后网格里再加新的嵌套控件也不用记得补这一刀。
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(item, { intent: 'read' })
      }}
      className="group block w-full cursor-pointer rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {/* nestedSurface：转发帖的引用块是一张真的 Card（见下面 post-card-quote），靠 acrylic
          的嵌套面机制自动退一档着色——半透明的嵌套色叠在本卡的嵌套色之上，合成出来就比外层
          浅一档，层界自然可见，不需要描边。这个声明放在本卡上而不是继续蹭外面那个
          data-nested-surface 的根 div（那层是给本卡自己退色用的），意图才留在它该在的地方。 */}
      <Card nestedSurface className={cn('flex flex-col overflow-hidden p-0', HOVER_FLOAT)}>
        {cover ? (
          <CardMedia
            ratio={ratio}
            src={cover.src}
            alt={cover.alt ?? ''}
            // 点封面 = 冲着媒体来的：详情页照旧自己播起来（列表行里这一格是内联播放，
            // 网格里是"进详情页播"——两种布局的媒体点击都通向播放，只是落点不同）。
            // 音频卡的圆按钮自己吃掉了点击（stopPropagation），不会走到这里。
            onClick={(event) => {
              event.stopPropagation()
              onOpen(item, { intent: 'watch' })
            }}
            onNaturalSize={(w, h) => {
              // 已经学到过就不再 bump——否则同一张图每次挂载都白重渲染一次。
              if (getMediaSize(cover.src)) return
              rememberMediaSize(cover.src, w, h)
              bumpLearned((n) => n + 1)
            }}
          >
            {isVideo ? (
              <span
                data-slot="post-card-video-badge"
                aria-label={t('timeline.play')}
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white shadow-sm">
                  <PlayIcon className="size-4 translate-x-px fill-current" />
                </span>
              </span>
            ) : null}
            {/* 音频条目：封面上直接给播放控制——播客卡点一下就播是网格里最自然的动作，
                而且沿用 onPlayAudio 的队列语义（把周围的音频条目排在它后面）。
                按钮本身只占字形大小、居中悬浮，不是 `absolute inset-0` 撑满整张封面——
                撑满会让"点封面任意处"全变成播放音频，封面里最大的一块地方就不再干
                "打开详情"这件卡片的主职责了。和列表行 InlineAudioPreview 的 size-10
                圆按钮对齐：同一个音频条目在两种布局下的点击行为不该分叉。外层这个
                inset-0 的 div 只用来居中，自己不接 onClick，点在按钮以外的地方会照常
                冒泡到卡片根节点打开详情。 */}
            {!isVideo && audioControl ? (
              <div className="absolute inset-0 flex items-center justify-center">{audioControl}</div>
            ) : null}
            {typeof durationS === 'number' ? (
              <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] tabular-nums text-white">
                {mmss(durationS)}
              </span>
            ) : null}
            {/* 这里曾经有一个 hover 浮出的「打开原文」。它搬进右键菜单了（和列表行同一份
                ItemContextMenu）——一个动作在两种布局里有两个不同的入口，是用户第一眼就撞上的
                不一致。触屏也不再是死路：Radix 的 ContextMenu 自带长按。 */}
          </CardMedia>
        ) : null}

        <div className="flex flex-col gap-1 px-3 pb-2.5 pt-2.5">
          {/* self-stretch 是承重的：acrylic 的 CardTitle 自带 `self-center`（给 CardHeader 那种
              横排布局垂直居中用的），而这里的父容器是 flex-col——交叉轴变成水平，标题盒子于是
              缩到文字宽度再水平居中。长标题占满一行看不出来，短标题就飘在卡片中间，和左对齐的
              摘要/作者行错开（实测 leftGap 40.7px vs 正文 12px）。MediaCard、MovieChannel 的
              卡片标题、以及上游 CardMediaOverlay 里都是同一道 self-stretch，本卡漏了。 */}
          {title ? <CardTitle className="self-stretch line-clamp-2 whitespace-normal">{title}</CardTitle> : null}
          {summary ? (
            <CardDescription className={cn('whitespace-normal', title ? 'line-clamp-2' : 'line-clamp-3')}>
              {summary}
            </CardDescription>
          ) : null}
          {/* 转发/回复帖的原帖 —— 卡中卡。实测雪球那条流 55/55 条都是转发，本帖往往只是
              一句「你好好看看王宁自己说的吧」，脱离原帖根本读不懂；原来卡片只画本帖那句，
              原帖整个不见。这里不自己描边造框，用 acrylic 的嵌套 Card（上一层 nestedSurface
              已经声明），层界由材质给。
              line-clamp-3 必须和估高器的 MAX_QUOTE_LINES 是同一个数——本文件顶上那条
              「凡是影响高度的取值两端同源」在这里同样成立（masonry.ts 头注列了三次事故）。 */}
          {quoted ? (
            <Card
              data-post-card-quote="true"
              className="mt-1.5 rounded-lg px-2.5 py-2 text-[12px] leading-snug text-muted-foreground"
            >
              <div className="line-clamp-3 whitespace-normal">
                {quoted.author ? <span className="font-medium text-foreground/70">@{quoted.author}：</span> : null}
                {quoted.text}
              </div>
            </Card>
          ) : null}
          {/* 没有封面的音频条目（大量播客 RSS 的 enclosure 不带 poster、正文里也没有图）在这里
              补上裸的圆按钮 + 时长。原来播放控件整块长在 `cover ? …` 分支里，于是同一条播客在
              列表里点一下就播（PostItemRow 的 InlineAudioPreview 只看 audioTrack，poster 是
              可选的），到了网格却退化成一张连播放入口都没有的纯文字卡——正是本文件上面那句
              「同一个音频条目在两种布局下的点击行为不该分叉」要挡的事。形状跟 InlineAudioPreview
              的无封面分支对齐。
              和列表行的一点有意差别：这里不给外层包 stopPropagation。卡片的主职责是"点哪儿都
              打开详情"，只有控件自己吃掉点击就够了。 */}
          {!cover && audioControl ? (
            <div className="mt-1 flex items-center gap-2.5">
              {audioControl}
              {typeof durationS === 'number' ? (
                <span className="text-[12px] tabular-nums text-muted-foreground">{mmss(durationS)}</span>
              ) : null}
            </div>
          ) : null}
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            <Avatar className="size-4 shrink-0">
              {avatar ? <AvatarImage src={avatar} alt="" className="object-cover" /> : null}
              <AvatarFallback>
                <LayersIcon className="size-2.5" />
              </AvatarFallback>
            </Avatar>
            <span className="truncate">{item.author || item.stream_id}</span>
            <span className="shrink-0 opacity-70">·</span>
            <span className="shrink-0 opacity-70">{formatTime(item.timestamp)}</span>
            {/* 带状态的东西留在外面——点赞/收藏藏进右键菜单就看不见自己赞没赞了
                （其余动作全在菜单里，见 ItemContextMenu）。hover 才浮出，位置和列表行对齐：
                都在那条 meta 行的末尾。 */}
            {actions.length ? (
              <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <ItemActionButtons actions={actions} />
              </div>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  )

  // 卡片上没有任何常驻动作：全在右键菜单里，和列表行同一份（两种布局是同一批内容的两个画法，
  // 动作住在哪儿不该跟着布局变）。
  return (
    <ItemContextMenu item={item} videoDl={canDownload ? videoDl : undefined}>
      {card}
    </ItemContextMenu>
  )
}
