import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertCircle, AtSign, Check, CheckCircle2, ChevronLeft, Download, HardDrive, Heart, Info, ListChecks, ListMusic, ListPlus, Loader2, MoreHorizontal, Music2, Pencil, Play, Podcast, RefreshCw, Trash2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from './acrylic/alert-dialog.tsx'
import { Searchbar } from './acrylic/searchbar.tsx'
import { toast } from './acrylic/sonner.tsx'
import { albumFromText } from '@music/album.ts'
import { api, imgUrl, type CollectedItemKeyInput, type Connection } from '../lib/api.ts'
import { fmtClock, useAudioStage, type AudioTrack } from '../lib/audioStage.ts'
import { audioResolveUrl, songTitle, toTrack } from '../lib/audioTrack.ts'
import { splitAudioStreams } from '../lib/audioStreamKind.ts'
import { buildMemberRows, filterRows, itemTrackKey, moveInOrder, myPlaylistCards, netdiskLabeller, planScopeResolution, rowCollectKey, rowOrigin, shouldBounceCollection, sortByEpisodeNo, type RowOrigin, type TrackTableRow } from '../lib/playlistScope.ts'
import { hasTrackMeta, trackMetaDescription, trackMetaFields } from '../lib/trackMeta.ts'
import { toolbarMenuItems, planDownloadAll, planExportTarget, autoDownloadEnabled, findStream, pickListRows, pickDownloadTargets, downloadBatchMessage, type ToolbarCaps } from '../lib/musicToolbar.ts'
import type { CollectedItem, Collection, Item, MusicSearchResult, ChannelView } from '../lib/types.ts'
import { SYSTEM_COLLECTIONS } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'
import { ChannelTitleMenu } from './ChannelTitleMenu.tsx'
import { ChannelConfigPanel } from './manage/ChannelConfigPanel.tsx'
import { ChannelTabs, type ChannelTab } from './manage/ChannelTabs.tsx'
import { NetdiskPanel } from './netdisk/NetdiskPanel.tsx'
import { ScrollArea } from './ui/scroll-area.tsx'
import { useSubRoute, useSubRouteLocation } from '../hooks/useSubRoute.ts'
import { useScrollMemory, scrollAreaViewport } from '../hooks/useScrollMemory.ts'
import { Button } from './acrylic/button.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './acrylic/table.tsx'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './acrylic/hover-card.tsx'
import { MediaBadge, MediaCard } from './MediaCard.tsx'
import { SubscriptionContextMenu } from './feed/SubscriptionContextMenu.tsx'
import { referenceItem } from '../lib/askExtract.ts'
import { NowPlayingBar } from './NowPlayingBar.tsx'
import { Input } from './acrylic/input.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './acrylic/popover.tsx'
import { useWs } from '../hooks/useWs.ts'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './ui/context-menu.tsx'
import { CollectionManageDialogs } from './CollectionManageDialogs.tsx'

/** VIP/付费曲：normalizer 渲染成 link media（无 audio media）。仍可点播（经 znnu resolver）。 */
function isVip(it: Item): boolean {
  const ms = it.content?.media ?? []
  return !ms.some((m) => m.kind === 'audio') && ms.some((m) => m.kind === 'link' && !!m.track_id)
}

/** Per-song album cover: free songs carry it on audio media, VIP songs on the link media. */
function itemPoster(it: Item): string | undefined {
  for (const m of it.content?.media ?? []) {
    if (m.kind === 'audio' && m.poster) return m.poster
    if (m.kind === 'link' && m.image) return m.image
    if (m.kind === 'image' && m.url) return m.url
  }
  return undefined
}

/** 歌单来源标签（封面角标）：取源**自己申报的** facility 标签（`/api/streams` 的
 *  `sources[].source.facility`，后端 `publicSource()` 的原样投影）。没有就空串——
 *  从 source id 猜站名要求前端认识每一家站，而那正是这轮搬迁要消灭的东西。 */
export function sourceLabel(s: { sources?: { source?: { facility?: { key?: string; label?: string } } }[] }): string {
  for (const x of s.sources ?? []) {
    const label = x.source?.facility?.label
    if (label) return label
  }
  return ''
}

const LIKED_PLAYLIST_ID = '__liked_songs__'
// 批量下载(下载整单 / 多选下载)的并发上限——不依赖组件任何状态,提到模块作用域别每次渲染重建。
const DOWNLOAD_BATCH_CONCURRENCY = 4

// L1 封面网格的列数来自**容器宽度**(auto-fill/minmax),不是 Tailwind 的 sm:/lg:/xl: 断点——
// 那些是**视口宽度**媒体查询,抽屉挤压 ShellInset 时容器变窄但视口不变,列数会纹丝不动,等于
// 拒绝被挤(任务8发现的缺陷)。和 MovieChannel 的封面网格用同一种写法(见该文件 grid-cols-[repeat(auto-fill,…)])。
// 两处(歌单/播客分区 + 我的播单分区)共用同一个常量,别各写各的漂移。
//
// 轨道最小宽度不是写死的 140px,而是 max(140px, (容器内容宽 - 5道gap) / 6):
// - 用容器宽度(100%,在 grid 轨道尺寸里按网格容器内容盒解析)而不是媒体查询断点,挤压才成立;
// - 但要保住旧写法(grid-cols-3/4/5/6 视口断点)原本封顶 6 列的上限——屏幕变宽是封面变大,
//   不是变多。auto-fill 天生没有列数上限,所以把"第6列"的宽度当轨道最小值撑住:容器一旦宽到
//   能塞下第7列,minmax 的第二个参数 1fr 才会被 max() 顶掉,列数停在6,多出的宽度摊给已有列。
// gap-3 = 0.75rem = 12px(Tailwind 默认间距刻度,本项目未覆盖),6 列间有 5 道 gap = 60px。
export const MUSIC_COVER_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(max(140px,calc((100%-60px)/6)),1fr))] gap-3'

// 轨道用 1fr 撑满,超过 6 列宽度的余量会摊给已有轨道——容器一旦比 6×卡片还宽(去掉侧边栏时的
// 典型场景,和 MovieChannel 的 item 撑宽是同一类问题),卡片会被拉得比封面本该有的尺寸夸张得多。
// 210px 封顶卡片自身宽度、mx-auto 把它摊在轨道里居中,轨道之间的留白靠 margin 均分,不靠拉伸卡片。
export const MUSIC_COVER_ITEM_CLASS = 'mx-auto w-full max-w-[210px]'

type MusicRoute = { kind: 'home' } | { kind: 'liked' } | { kind: 'playlist'; id: string }
  | { kind: 'collection'; id: string } | { kind: 'search'; q: string }

/** Pure pathname parser — kept separate from musicRoute() so it's testable without a DOM location. */
export function musicRouteFrom(pathname: string): MusicRoute {
  const [, first, second, ...rest] = pathname.split('/')
  if (first !== 'music') return { kind: 'home' }
  if (second === 'liked') return { kind: 'liked' }
  if (second === 'playlist' && rest[0]) return { kind: 'playlist', id: decodeURIComponent(rest[0]) }
  if (second === 'collection' && rest[0]) return { kind: 'collection', id: decodeURIComponent(rest.join('/')) }
  if (second === 'search' && rest[0]) return { kind: 'search', q: decodeURIComponent(rest.join('/')) }
  return { kind: 'home' }
}
/** Inverse of musicRoute — the path a selection lives at. Feeds useSubRoute. */
export function musicToPath(r: MusicRoute): string {
  if (r.kind === 'liked') return '/music/liked'
  if (r.kind === 'playlist') return '/music/playlist/' + encodeURIComponent(r.id)
  if (r.kind === 'collection') return '/music/collection/' + encodeURIComponent(r.id)
  if (r.kind === 'search') return '/music/search/' + encodeURIComponent(r.q)
  return '/music'
}

/** Which layer the channel shows. Split out so the loading-vs-genuinely-empty distinction is
 *  testable and can't regress. The bug it fixes: a deep-linked playlist URL refreshed cold —
 *  `channels` arrives async, so on the first frames `selStream` can't resolve yet. The old binary
 *  gate committed straight to the grid (whose own empty-state reads "还没有歌单"), so a hard refresh
 *  of /music/playlist/<id> flashed "no playlists" instead of opening the list. Mirror MovieChannel:
 *  hold a spinner while channels are still arriving, and only fall to the grid once they have. */
export type MusicLayer = 'track-list' | 'loading' | 'grid'
export function musicLayer(a: {
  sel: string | null
  selStream: boolean
  isLikedPlaylist: boolean
  channelsLoaded: boolean
  /** A user-created collection route — not a stream, so it must not depend on selStream. */
  isCollection?: boolean
}): MusicLayer {
  if (a.isCollection) return 'track-list'
  if (a.sel && (a.selStream || a.isLikedPlaylist)) return 'track-list'
  // Liked needs no channels; anything else can't be resolved until channels land — spinner, not grid.
  if (!a.channelsLoaded && !a.isLikedPlaylist) return 'loading'
  return 'grid'
}

function toastDownloadError(title: string, description: string) {
  toast.error(title, {
    description,
    action: {
      label: '复制错误',
      onClick: () => void navigator.clipboard?.writeText(description),
    },
  })
}

/** 正在播放的那一行是实心强调色(data-state="selected"),行内任何**自带颜色**的东西都得
 *  跟着上浮到白——组件的强制白只作用到 <td> 自己,管不到孙子节点,不接就是蓝底上的灰字
 *  (更糟的是 text-primary / fill-primary:蓝上加蓝,直接看不见)。钩子挂在 TableRow 自带的
 *  group/table-row 上,所以这两个常量可以随手拌进任何一层的 className。 */
const ON_ACCENT = 'group-data-[state=selected]/table-row:text-primary-foreground'
const ON_ACCENT_DIM = 'group-data-[state=selected]/table-row:text-primary-foreground/80'

/** 行内来源标记（网盘 / 付费）。形状刻意抄隔壁 VIP 小药丸——同一行里两种标记必须长得像
 *  一家人；只有异常来源才挂标，普通直链集不挂（见 rowOrigin）。 */
function OriginBadge({ origin }: { origin: RowOrigin }) {
  // 「付费」与隔壁平台 VIP 标共用琥珀色——同属"要钱才能听"这一类。
  const tone = origin.kind === 'netdisk'
    ? 'bg-sky-500/15 text-sky-500'
    : 'bg-amber-500/15 text-amber-500'
  const title = origin.kind === 'netdisk'
    ? '来自挂载的网盘目录，文件在盘里直接播'
    : '源站标记为付费集（与能不能播无关——网盘补上音频后依然是付费集）'
  return (
    <span title={title} className={cn('shrink-0 rounded px-1 py-px text-[9px] font-medium', tone,
      'group-data-[state=selected]/table-row:bg-white/20', ON_ACCENT)}>{origin.label}</span>
  )
}

/** Apple-Music-style "now playing" equalizer — three bouncing bars. Inherits color via
 *  currentColor so the caller tints it (we use the primary accent). */
function NowPlayingEq() {
  return (
    <span className="eq" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

function parseTrackKey(trackKey?: string | null): { platform: string; trackId: string } | null {
  if (!trackKey) return null
  const idx = trackKey.indexOf(':')
  if (idx <= 0) return null
  return { platform: trackKey.slice(0, idx), trackId: trackKey.slice(idx + 1) }
}

/** 这一行有没有可下载的落点。三处调用点(行内下载按钮 / 下载整单 / 多选下载)共用同一判据,
 *  别各推一份。
 *
 *  两条来路是活的：分集行有 sourceItem、曲目行(我喜欢的 / 播单里的 track 成员)有 likeRef——
 *  playlistScope.ts 的 buildMemberRows 给 track 成员就是同时写 trackKey 和 likeRef 的,
 *  给 live 分集成员写 sourceItem。所以本文件里没有任何一个行构造器会走到第三条 parseTrackKey
 *  分支。留着它是因为这个函数是从原来三处行内判据里抽出来的,抽取的意义就在于"和原判据完全
 *  等价",少一条分支就等于顺手改了行为;而且它也兜住了将来只带 trackKey 的行构造器。 */
export function canDownloadRow(row: TrackTableRow): boolean {
  return !!(row.sourceItem || row.likeRef || parseTrackKey(row.trackKey))
}

type DownloadJobState = {
  id?: number
  state: string
  attempts?: number
  lastError?: string
  downloadedBytes?: number
  totalBytes?: number
  archived?: boolean
  failedAt?: number
}

function mergeDownloadJobState(current: DownloadJobState | undefined, incoming: DownloadJobState): DownloadJobState {
  if (!current || (current.id !== undefined && incoming.id !== undefined && current.id !== incoming.id)) {
    return incoming
  }
  const currentDownloaded = current.downloadedBytes
  const incomingDownloaded = incoming.downloadedBytes
  const downloadedBytes = currentDownloaded !== undefined && incomingDownloaded !== undefined
    ? Math.max(currentDownloaded, incomingDownloaded)
    : incomingDownloaded ?? currentDownloaded
  const currentTotal = current.totalBytes
  const incomingTotal = incoming.totalBytes
  const totalBytes = currentTotal !== undefined && incomingTotal !== undefined
    ? Math.max(currentTotal, incomingTotal)
    : incomingTotal ?? currentTotal
  return {
    ...incoming,
    downloadedBytes,
    totalBytes,
    failedAt: incoming.state === 'failed' ? current.failedAt ?? incoming.failedAt : incoming.failedAt,
  }
}

function DownloadProgressStatus({ job }: { job: DownloadJobState }) {
  const downloaded = job.downloadedBytes ?? 0
  const total = job.totalBytes ?? 0
  const started = downloaded > 0
  const pct = total > 0 ? Math.max(0, Math.min(1, downloaded / total)) : started ? 0.64 : 0
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const title = started ? '下载中' : '探测下载源'
  if (!started) {
    return (
      <span className={cn('inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/75', ON_ACCENT_DIM)} title={title}>
        <Loader2 className="size-4 animate-spin" strokeWidth={2} />
      </span>
    )
  }
  return (
    <svg
      className="size-4 shrink-0 -rotate-90 text-primary"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <title>{title}</title>
      <circle
        cx="8"
        cy="8"
        r={radius}
        className="stroke-muted-foreground/25"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct)}
      />
    </svg>
  )
}

function trackDownloadMenuProps({
  row,
  canDownload,
  active,
  onDownload,
}: {
  row: TrackTableRow
  canDownload: boolean
  active: boolean
  onDownload?: (row: TrackTableRow) => void
}) {
  const disabled = !canDownload || active
  return {
    disabled,
    onSelect: (e: Event) => {
      e.stopPropagation()
      if (!disabled) onDownload?.(row)
    },
  }
}

/** 「加入播单」子菜单内容——展开那一刻才拉归属+播单列表(勾选语义同 CollectButton)。
 *  Dropdown 与 ContextMenu 的 Item 组件 API 同构,由壳传入。 */
function AddToPlaylistMenuItems({ conn, collectKey, meta, anchorStreamId, MenuItem, onChanged }: {
  conn: Connection
  collectKey: CollectedItemKeyInput
  meta: { title: string; poster?: string; artist?: string; album?: string; durationS?: number; sourceUrl?: string }
  anchorStreamId: string | null
  MenuItem: typeof DropdownMenuItem | typeof ContextMenuItem
  // 右键/菜单加入或移出一个播单会动到 chip 计数(甚至当前 scope 的成员集),父级要重刷——
  // 这个组件自己不知道父级的 chips 状态,靠回调通知。
  onChanged?: () => void
}) {
  const [collections, setCollections] = useState<Collection[]>([])
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set())
  const [newLabel, setNewLabel] = useState('')
  useEffect(() => {
    let live = true
    Promise.all([api.collections(conn, 'audio'), api.whereCollected(conn, collectKey)]).then(([all, where]) => {
      if (!live) return
      setCollections([...all.filter((c) => !c.system)].sort((a, b) =>
        Number(b.anchorStreamId === anchorStreamId) - Number(a.anchorStreamId === anchorStreamId)))
      setMemberOf(new Set(where.collectionIds))
    }).catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toggle = (id: string, member: boolean) => {
    setMemberOf((prev) => { const next = new Set(prev); member ? next.delete(id) : next.add(id); return next })
    ;(member ? api.removeFromCollection(conn, id, collectKey) : api.addToCollection(conn, id, collectKey, meta))
      .then(() => onChanged?.())
      .catch(() => setMemberOf((prev) => { const next = new Set(prev); member ? next.add(id) : next.delete(id); return next }))
  }
  const create = async () => {
    const label = newLabel.trim()
    if (!label) return
    const created = await api.createCollection(conn, 'audio', label, anchorStreamId ?? undefined)
    setNewLabel('')
    setCollections((prev) => [created, ...prev])
    toggle(created.id, false)
    onChanged?.() // 新播单本身也可能锚定在当前 stream,进而多一个 chip——独立通知一次,不依赖 toggle 里那次
  }
  return (
    <>
      {collections.map((c) => {
        const member = memberOf.has(c.id)
        return (
          <MenuItem key={c.id} onSelect={(e: Event) => { e.preventDefault(); toggle(c.id, member) }}>
            <Check className={cn('size-4', member ? 'opacity-100' : 'opacity-0')} />
            <span className="truncate">{c.label}</span>
          </MenuItem>
        )
      })}
      <div className="border-t border-[var(--acr-border-soft)] px-1.5 py-1">
        <Input placeholder="新建播单…" value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void create() }}
          onClick={(e) => e.stopPropagation()} />
      </div>
    </>
  )
}

function TrackActionMenu({
  row,
  canDownload,
  job,
  isArchived,
  onDownload,
  collect,
}: {
  row: TrackTableRow
  canDownload: boolean
  job?: DownloadJobState
  isArchived: boolean
  onDownload?: (row: TrackTableRow) => void
  collect?: { conn: Connection; streamId: string | null; onChanged?: () => void }
}) {
  const active = job?.state === 'queued' || job?.state === 'running'
  const label = isArchived ? '重新下载' : active ? '下载中' : '下载到本地'
  const itemProps = trackDownloadMenuProps({ row, canDownload, active, onDownload })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="mx-auto inline-flex size-6 items-center justify-center rounded-full text-muted-foreground/70 opacity-0 transition-all hover:text-foreground group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          aria-label="歌曲操作"
          title="歌曲操作"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" size="sm" className="w-36">
        <DropdownMenuItem {...itemProps}>
          <Download />
          <span>{label}</span>
        </DropdownMenuItem>
        {collect && rowCollectKey(row, collect.streamId) && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><ListPlus /><span>加入播单</span></DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <AddToPlaylistMenuItems conn={collect.conn} collectKey={rowCollectKey(row, collect.streamId)!}
                meta={{ title: row.title, poster: row.poster, artist: row.author, album: row.album, durationS: row.durationS, sourceUrl: row.sourceUrl }}
                anchorStreamId={collect.streamId} MenuItem={DropdownMenuItem} onChanged={collect.onChanged} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TrackContextMenu({
  row,
  canDownload,
  job,
  isArchived,
  onDownload,
  collect,
  children,
}: {
  row: TrackTableRow
  canDownload: boolean
  job?: DownloadJobState
  isArchived: boolean
  onDownload?: (row: TrackTableRow) => void
  collect?: { conn: Connection; streamId: string | null; onChanged?: () => void }
  children: ReactNode
}) {
  const active = job?.state === 'queued' || job?.state === 'running'
  const label = isArchived ? '重新下载' : active ? '下载中' : '下载到本地'
  const itemProps = trackDownloadMenuProps({ row, canDownload, active, onDownload })
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent size="sm" className="w-36">
        {/* 排第一：引用是"我正指着这一集说话"，比下载更贴近右键这个手势的语义。
            走 referenceItem（塞进输入框、不发）——见 lib/askExtract.ts。 */}
        <ContextMenuItem onSelect={() => void referenceItem({ id: row.id, title: row.title, ...(row.author !== undefined ? { author: row.author } : {}) })}>
          <AtSign />
          <span>在对话中引用</span>
        </ContextMenuItem>
        <ContextMenuItem {...itemProps}>
          <Download />
          <span>{label}</span>
        </ContextMenuItem>
        {collect && rowCollectKey(row, collect.streamId) && (
          <ContextMenuSub>
            <ContextMenuSubTrigger><ListPlus /><span>加入播单</span></ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              <AddToPlaylistMenuItems conn={collect.conn} collectKey={rowCollectKey(row, collect.streamId)!}
                meta={{ title: row.title, poster: row.poster, artist: row.author, album: row.album, durationS: row.durationS, sourceUrl: row.sourceUrl }}
                anchorStreamId={collect.streamId} MenuItem={ContextMenuItem} onChanged={collect.onChanged} />
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 元数据卡的内容。**独立组件不是为了复用,是为了懒**:它的函数体只有 Radix 真把 HoverCard
 *  的 Content 挂上去才会跑,所以没被 hover 到的那些行不会为此构造任何东西——这张表 200 行以上
 *  要虚拟化,行内每一份常驻开销都会被行数乘一遍(同一个理由见 VIRTUALIZE_ROW_THRESHOLD)。 */
function TrackMetaCard({ row, baseUrl }: { row: TrackTableRow; baseUrl: string }) {
  const fields = trackMetaFields(row)
  const description = trackMetaDescription(row)
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        {row.poster && (
          <img src={imgUrl(baseUrl, row.poster)} alt="" loading="lazy" decoding="async"
            className="size-11 shrink-0 rounded-md object-cover ring-1 ring-[var(--acr-border-soft)]" />
        )}
        {/* 卡片里的标题**不截断**——表格里那一行已经截过了,来这儿就是为了看全名。 */}
        <div className="min-w-0 break-words text-[13px] font-medium leading-snug">{row.title}</div>
      </div>
      {fields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          {fields.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0 break-words text-foreground/90">{f.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {description && (
        <p className="line-clamp-6 whitespace-pre-line text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      )}
      {row.sourceUrl && (
        <a href={row.sourceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
          className="truncate text-[11px] text-primary hover:underline">
          {row.sourceUrl}
        </a>
      )}
    </div>
  )
}

/** 曲目名后面那个 info 图标。
 *
 *  平时透明,鼠标落到**行**上才显形——跟序号列那个 ▶ 同一套做法:它是"想看才看"的补充信息,
 *  常驻会把标题那一行变吵。钩子用 `group/item` 而不是 `group`:不可播的那种行只挂了前者。
 *
 *  `stopPropagation`:整行是个 role="button",不拦住的话点图标等于点行 = 直接开播。 */
function TrackInfoHover({ row, baseUrl }: { row: TrackTableRow; baseUrl: string }) {
  return (
    <HoverCard openDelay={200} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="节目信息"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 opacity-0 transition-opacity',
            'group-hover/item:opacity-100 focus-visible:opacity-100 focus-visible:outline-none hover:text-foreground',
            ON_ACCENT_DIM)}
        >
          <Info className="size-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" side="bottom" className="w-80">
        <TrackMetaCard row={row} baseUrl={baseUrl} />
      </HoverCardContent>
    </HoverCard>
  )
}

/** 一行的高度(px)。由 TableCell 的 py-2 + 36px 缩略图钉死,所有曲目行等高——所以虚拟化用
 *  固定估计而不是逐行测量:测量要给每一行挂一个 ResizeObserver,正是这里要省掉的那类开销。
 *  改了行内几何(缩略图尺寸 / 单元格 padding)要跟着改这个数,否则滚动条长度会和内容对不上。 */
const TRACK_ROW_HEIGHT = 53

/** 行数超过这个门槛才开虚拟化。
 *
 *  **阈值存在的理由不是性能,是功能**:虚拟化之后没上屏的行不在 DOM 里,浏览器自带的 Ctrl+F
 *  页内查找就找不到它们。几十首的专辑/播单用 Ctrl+F 找歌是真实用法,不能为了不存在的性能问题
 *  把它砍掉——所以短列表一律维持全量渲染。
 *
 *  200 以上则反过来,全量渲染的代价已经压过 Ctrl+F(活体实测,怡乐播客播单 1031 首):
 *  28147 个 DOM 节点,视口只装得下 17 行 → 98.4% 是白渲染的;每行还各挂一个 Radix DropdownMenu
 *  root,而 Radix 的模态菜单开/关都会往 document.body 写一次 pointer-events,在这棵 28k 节点的
 *  树上光这一下的样式重算就是 196ms,且随行数线性增长——每开一次行内菜单必卡 0.2 秒。 */
const VIRTUALIZE_ROW_THRESHOLD = 200

/** 一整行。**必须是独立的记忆化组件**:下载进度是每秒好几帧的高频更新,而 `jobs` 是整表共用的
 *  一个对象——它一变,没套 memo 的话上千行全部跟着重渲染(等于每帧重建上千个 Radix 菜单 root)。
 *  props 全是原始值 + 引用稳定的回调(稳定层见 TrackTable 里的 `latest` ref),memo 才咬得住。 */
type TrackRowProps = {
  row: TrackTableRow
  /** 序号列显示 `index + 1`。虚拟化下它来自**数据下标**,不是这一批渲染出来的顺序。 */
  index: number
  baseUrl: string
  isCurrent: boolean
  isPlaying: boolean
  isLiked: boolean
  job?: DownloadJobState
  isArchived: boolean
  canDownload: boolean
  selectMode: boolean
  selected: boolean
  onToggleLike: (row: TrackTableRow) => void
  onToggleSelect?: (row: TrackTableRow) => void
  onDownload?: (row: TrackTableRow) => void
  onPlay: (row: TrackTableRow) => void
  collect?: { conn: Connection; streamId: string | null; onChanged?: () => void }
  rowRef?: Ref<HTMLTableRowElement>
  /** 手动排序开着时才有。`isDropTarget` 只管画那条落点线,不参与计算。 */
  drag?: {
    onDragStart: (index: number) => void
    onDragEnter: (index: number) => void
    onDragEnd: () => void
    isDropTarget: boolean
  }
}

const TrackRow = memo(function TrackRow({
  row, index, baseUrl, isCurrent, isPlaying, isLiked, job, isArchived, canDownload,
  selectMode, selected, onToggleLike, onToggleSelect, onDownload, onPlay, collect, rowRef, drag,
}: TrackRowProps) {
  // 拖拽用 HTML5 原生 DnD:这张表的行数远在虚拟化阈值之下(播单是人手编的,不是几千条的流),
  // 行都在真 DOM 里,不值得为它引一个拖拽库。
  //
  // `onDragOver` 必须 preventDefault——不拦掉默认行为浏览器就判定"这里不能放",drop 永不触发,
  // 表现是拖起来了却怎么都放不下。落点用 dragenter 逐行记,而不是在 drop 里算坐标。
  const dragProps = drag
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = 'move'; drag.onDragStart(index) },
        onDragEnter: () => drag.onDragEnter(index),
        onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' },
        onDrop: (e: React.DragEvent) => { e.preventDefault(); drag.onDragEnd() },
        onDragEnd: () => drag.onDragEnd(),
      }
    : {}
  // 落点提示画在 <td> 上:<tr> 是 table 的内部盒子,box-shadow/outline 在它上面根本不绘制
  // (这张表别处的焦点态也是同一个原因走 [&>td])。
  const dropCue = drag?.isDropTarget ? '[&>td]:border-t-2 [&>td]:border-t-primary' : ''
  const thumb = row.poster ? (
    <img src={imgUrl(baseUrl, row.poster)} alt="" loading="lazy" decoding="async" className="size-9 shrink-0 rounded-md object-cover shadow-sm ring-1 ring-[var(--acr-border-soft)]" />
  ) : (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground shadow-sm ring-1 ring-[var(--acr-border-soft)]',
      'group-data-[state=selected]/table-row:bg-white/15', ON_ACCENT)}>
      <Music2 className="size-4" />
    </span>
  )
  const activeDownload = job?.state === 'queued' || job?.state === 'running'
  const recentFailure = !!job?.failedAt && Date.now() - job.failedAt < 5000
  // **在跑的排在已下载前面**：这两个状态会同时成立（点「重新下载」的那一刻这首歌就是已归档的），
  // 而绿勾在前意味着重下全程只看得见一个"已下载"，一点进度都没有——用户看到的就是"点了没反应"。
  // 已下载是**静态事实**，随时能再看到；这一轮在下、下到哪儿了是**转瞬即逝的**，让位给它。
  const trackStatus = activeDownload && job ? (
    <DownloadProgressStatus job={job} />
  ) : row.trackKey && isArchived ? (
    <span className={cn('inline-flex size-4 shrink-0 items-center justify-center text-emerald-500/90', ON_ACCENT)} title="已下载">
      <CheckCircle2 className="size-4" strokeWidth={2} />
    </span>
  ) : recentFailure ? (
    <span className={cn('inline-flex size-4 shrink-0 items-center justify-center text-destructive/90', ON_ACCENT)} title={job?.lastError ? `下载失败：${job.lastError}` : '下载失败'}>
      <AlertCircle className="size-4" strokeWidth={2} />
    </span>
  ) : null
  const rowMenu = (
    <TrackActionMenu
      row={row}
      canDownload={canDownload}
      job={job}
      isArchived={isArchived}
      onDownload={onDownload}
      collect={collect}
    />
  )
  const metaLine = row.author ? (
    <div className={cn('flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground', ON_ACCENT_DIM)}>
      {trackStatus}
      <span className="truncate">{row.author}</span>
    </div>
  ) : trackStatus ? (
    <div className={cn('flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground', ON_ACCENT_DIM)}>
      {trackStatus}
    </div>
  ) : null
  const infoHover = hasTrackMeta(row) ? <TrackInfoHover row={row} baseUrl={baseUrl} /> : null
  const likeKey = row.likeRef ? `${row.likeRef.platform}:${row.likeRef.trackId}` : row.trackKey
  const heartBtn = (
    <button
      onClick={(e) => { e.stopPropagation(); onToggleLike(row) }}
      disabled={!likeKey}
      className={cn('mx-auto inline-flex size-6 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground',
        ON_ACCENT_DIM, 'group-data-[state=selected]/table-row:hover:text-primary-foreground')}
      title={isLiked ? '取消喜欢' : '喜欢'}
    >
      {/* fill-primary 在蓝底上就是蓝填蓝——跟着一起上浮,fill 走 currentColor。 */}
      <Heart className={cn('size-4', isLiked && 'fill-primary text-primary',
        isLiked && 'group-data-[state=selected]/table-row:fill-current', isLiked && ON_ACCENT)} />
    </button>
  )
  const durationCell = (
    <span className={cn('text-right text-[12px] tabular-nums text-muted-foreground', ON_ACCENT_DIM)}>{row.durationS ? fmtClock(row.durationS) : '--:--'}</span>
  )
  const selectCell = (
    <button
      onClick={(e) => { e.stopPropagation(); onToggleSelect?.(row) }}
      aria-label={selected ? '取消选择' : '选择'}
      className={cn('mx-auto inline-flex size-4.5 items-center justify-center rounded-full border transition-colors',
        selected
          // 蓝底上勾选态要反过来:白圈白底 + 强调色的勾。
          ? 'border-primary bg-primary text-primary-foreground group-data-[state=selected]/table-row:border-primary-foreground group-data-[state=selected]/table-row:bg-primary-foreground group-data-[state=selected]/table-row:text-primary'
          : 'border-[var(--acr-border)] text-transparent hover:border-foreground/50 group-data-[state=selected]/table-row:border-primary-foreground/50')}
    >
      <Check className="size-3" strokeWidth={3} />
    </button>
  )

  if (row.track && !row.muted) {
    const rowAction = () => { selectMode ? onToggleSelect?.(row) : onPlay(row) }
    return (
      <TrackContextMenu
        row={row}
        canDownload={canDownload}
        job={job}
        isArchived={isArchived}
        onDownload={onDownload}
        collect={collect}
      >
        <TableRow
          ref={rowRef}
          role="button"
          tabIndex={0}
          {...dragProps}
          onClick={rowAction}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rowAction() } }}
          // 正在播放 = 整行实心强调色(组件的 data-state="selected"),序号位再叠一个
          // EQ 律动。行内自带颜色的子孙节点靠 ON_ACCENT / ON_ACCENT_DIM 一起上浮 ——
          // 组件的强制白只到 <td> 一层,再往下管不着。
          data-state={isCurrent ? 'selected' : undefined}
          className={cn(
            'group group/item cursor-pointer outline-none',
            // box-shadow/outline never paint on <tr> (internal table display box) — style
            // the cells instead, mirroring the same [&>td] pattern the selected state uses.
            'focus-visible:[&>td]:bg-[var(--acr-hover)] focus-visible:[&>td]:border-b-transparent',
            'focus-visible:[&>td:first-child]:rounded-l-[7px] focus-visible:[&>td:last-child]:rounded-r-[7px]',
            dropCue,
          )}
        >
          <TableCell className="text-center">
            <span className="relative flex h-5 items-center justify-center text-xs">
              {selectMode ? selectCell : isPlaying ? (
                <span className={cn('text-primary', ON_ACCENT)}><NowPlayingEq /></span>
              ) : isCurrent ? (
                <Play className={cn('size-3.5 fill-current text-primary', ON_ACCENT)} />
              ) : (
                <>
                  <span className="tabular-nums text-muted-foreground group-hover:opacity-0">{index + 1}</span>
                  <Play className="absolute size-3.5 fill-current text-foreground opacity-0 group-hover:opacity-100" />
                </>
              )}
            </span>
          </TableCell>
          <TableCell>
            <div className="flex min-w-0 items-center gap-3">
              {thumb}
              <div className="min-w-0">
                <div className={cn('flex items-center gap-1.5 text-[13px]', isCurrent ? 'font-medium text-primary' : 'text-foreground', ON_ACCENT)}>
                  <span className="truncate">{row.title}</span>
                  {row.vip && <span className={cn('shrink-0 rounded bg-amber-500/15 px-1 py-px text-[9px] font-medium text-amber-500',
                    'group-data-[state=selected]/table-row:bg-white/20', ON_ACCENT)}>VIP</span>}
                  {row.origin && <OriginBadge origin={row.origin} />}
                  {infoHover}
                </div>
                {metaLine}
              </div>
            </div>
          </TableCell>
          <TableCell className="truncate text-[12px] text-muted-foreground">{row.album}</TableCell>
          <TableCell className="text-center">{heartBtn}</TableCell>
          <TableCell className="text-right">
            <div className="flex items-center justify-end gap-1">
              {durationCell}
              {rowMenu}
            </div>
          </TableCell>
        </TableRow>
      </TrackContextMenu>
    )
  }

  return (
    <TrackContextMenu
      row={row}
      canDownload={canDownload}
      job={job}
      isArchived={isArchived}
      onDownload={onDownload}
      collect={collect}
    >
      {/* 不可播的行(缺音源/被抹掉的付费集)照样能拖——它在播单里占一个位置，用户当然可以给它换个位置。 */}
      <TableRow {...dragProps} className={cn('group/item opacity-50', dropCue)}>
        <TableCell className="text-center text-xs text-muted-foreground/60">
          {selectMode ? selectCell : index + 1}
        </TableCell>
        <TableCell>
          <div className="flex min-w-0 items-center gap-3">
            {thumb}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[13px] text-foreground/70">
                <span className="truncate">{row.title}</span>
                {row.origin && <OriginBadge origin={row.origin} />}
                {infoHover}
              </div>
              {metaLine}
            </div>
          </div>
        </TableCell>
        <TableCell className="truncate text-[12px] text-muted-foreground">{row.album}</TableCell>
        <TableCell />
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <span className="text-right text-[12px] tabular-nums text-muted-foreground">{row.durationS ? fmtClock(row.durationS) : '--:--'}</span>
            {rowMenu}
          </div>
        </TableCell>
      </TableRow>
    </TrackContextMenu>
  )
})

/** 撑起"没渲染的那些行"的占位 <tr>。**故意是表格行而不是绝对定位的垫片**:整张表必须还是一张
 *  真 <table>,行留在 <tbody> 里——绝对定位会让 table 布局塌掉,sticky <thead> 也跟着失效。
 *  高度/内边距/分隔线全走 inline style:TableBody 的分隔线规则(`[&_tr:not(:last-child)>td]`)
 *  权重比任何工具类都高,只有 inline 压得住。 */
function VirtualPad({ height, side }: { height: number; side: 'top' | 'bottom' }) {
  return (
    <tr aria-hidden data-testid={`track-vpad-${side}`} style={{ height, pointerEvents: 'none' }}>
      <td colSpan={5} style={{ height, padding: 0, borderBottomWidth: 0 }} />
    </tr>
  )
}

export function TrackTable({
  rows,
  queue,
  stage,
  baseUrl,
  liked,
  toggleLike,
  jobs = {},
  archived = {},
  onDownload,
  busy,
  busyText = '加载中…',
  emptyText,
  selectMode,
  selectedIds,
  onToggleSelect,
  collect,
  jumpKey,
  onReorder,
}: {
  rows: TrackTableRow[]
  queue: AudioTrack[]
  stage: ReturnType<typeof useAudioStage>
  baseUrl: string
  liked: Set<string>
  toggleLike: (row: TrackTableRow) => void
  jobs?: Record<string, DownloadJobState>
  archived?: Record<string, boolean>
  onDownload?: (row: TrackTableRow) => void
  busy?: boolean
  busyText?: string
  emptyText: string
  selectMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (row: TrackTableRow) => void
  collect?: { conn: Connection; streamId: string | null; onChanged?: () => void }
  /** Identity of the list being shown (playlist id / 'liked' / 'search'). Opening a DIFFERENT
   *  list re-arms the jump-to-now-playing below; re-renders within the same list do not. */
  jumpKey?: string
  /** 给了才开手动排序（拖拽）。下标是 `rows` 里的下标——所以**调用方必须保证 `rows` 就是那份
   *  可以整份写回去的完整名单**：过滤/收窄之后的子集不能给，那时候下标对不上真名单。 */
  onReorder?: (from: number, to: number) => void
}) {
  // ---- 引用稳定层 ----
  // 行组件套了 React.memo,但父级(MusicChannel)每次渲染都会新建 toggleLike / onDownload /
  // collect 这些 prop——引用一变 memo 就形同虚设(下载进度每秒好几帧,整表跟着重画)。把最新
  // 的那一份镜像进 ref,对外只暴露一层引用恒定的包装。
  const latest = useRef({ toggleLike, onToggleSelect, onDownload, collect, stage, queue })
  latest.current = { toggleLike, onToggleSelect, onDownload, collect, stage, queue }
  const handleToggleLike = useCallback((row: TrackTableRow) => latest.current.toggleLike(row), [])
  const toggleSelectStable = useCallback((row: TrackTableRow) => latest.current.onToggleSelect?.(row), [])
  const downloadStable = useCallback((row: TrackTableRow) => latest.current.onDownload?.(row), [])
  const onCollectChanged = useCallback(() => latest.current.collect?.onChanged?.(), [])
  const handlePlay = useCallback((row: TrackTableRow) => {
    const { stage: s, queue: q } = latest.current
    if (row.track && s.current?.id === row.track.id) s.toggle()
    else s.playQueue(q, row.playIndex, 'music')
  }, [])
  // "有没有这个能力"仍要如实传下去(canDownload / 菜单项的存在与否看的是它),所以包装器只在
  // 父级真的给了回调时才挂上。
  const handleToggleSelect = onToggleSelect ? toggleSelectStable : undefined
  const handleDownload = onDownload ? downloadStable : undefined
  const collectConn = collect?.conn
  const collectStreamId = collect?.streamId ?? null
  const stableCollect = useMemo(
    () => (collectConn ? { conn: collectConn, streamId: collectStreamId, onChanged: onCollectChanged } : undefined),
    [collectConn, collectStreamId, onCollectChanged],
  )

  // ---- 虚拟化 ----
  // 滚动容器是 ScrollArea 的 viewport(不是 Root)。用 state 而不是 ref 存它:虚拟化器要在拿到
  // 元素之后重新算一遍窗口,setState 才会触发那次重渲染,纯 ref 会停在"还没有滚动容器"。
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const scrollRootRef = useCallback((node: HTMLDivElement | null) => {
    setViewport(node ? scrollAreaViewport(node) : null)
  }, [])
  // ---- 手动排序（拖拽） ----
  // 拖起来的那一行和当前落点，都只是画面状态；真正的名单在父级手里。松手时把 (from,to) 报上去,
  // 由父级做乐观更新 + 落库 —— 表格自己不改 rows,不然就有两份"真名单"了。
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const dragStart = useCallback((i: number) => { setDragFrom(i); setDragOver(i) }, [])
  const dragEnter = useCallback((i: number) => setDragOver(i), [])
  const latestDrag = useRef({ onReorder, dragFrom, dragOver })
  latestDrag.current = { onReorder, dragFrom, dragOver }
  // dragend 和 drop 都会走到这里（拖到表格外面松手只有 dragend）——两条路都必须把状态清干净,
  // 否则那条落点线会一直留在画面上。
  const dragEnd = useCallback(() => {
    const { onReorder: fn, dragFrom: from, dragOver: to } = latestDrag.current
    if (fn && from !== null && to !== null && from !== to) fn(from, to)
    setDragFrom(null)
    setDragOver(null)
  }, [])

  const virtualized = !busy && rows.length > VIRTUALIZE_ROW_THRESHOLD
  const virtualizer = useVirtualizer({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => viewport,
    estimateSize: () => TRACK_ROW_HEIGHT,
    overscan: 10,
  })
  const virtualItems = virtualized ? virtualizer.getVirtualItems() : []
  const padTop = virtualItems.length ? virtualItems[0].start : 0
  const padBottom = virtualItems.length ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0
  const windowRows = virtualized
    ? virtualItems.map((v) => ({ row: rows[v.index], index: v.index }))
    : rows.map((row, index) => ({ row, index }))

  // Jump to the playing track when a list is OPENED (not on every re-render, and not when the
  // queue auto-advances — that would yank the viewport while the user is browsing elsewhere).
  // Armed by jumpKey.
  const currentRowRef = useRef<HTMLTableRowElement | null>(null)
  const jumpedFor = useRef<string | null>(null)
  const currentTrackId = stage.current?.id
  const currentIndex = useMemo(
    () => (currentTrackId ? rows.findIndex((r) => !r.muted && r.track?.id === currentTrackId) : -1),
    [rows, currentTrackId],
  )
  useEffect(() => {
    if (jumpedFor.current === jumpKey) return
    if (busy || !currentTrackId) return
    if (virtualized) {
      // 虚拟化下"正在播放的那一行"多半根本不在 DOM 里——scrollIntoView 永远拿到 null,静默不跳。
      // 位置只能问虚拟化器要(它按数据下标算,不依赖行有没有上屏)。
      if (currentIndex < 0 || !viewport) return
      jumpedFor.current = jumpKey ?? null
      virtualizer.scrollToIndex(currentIndex, { align: 'center' })
      return
    }
    const el = currentRowRef.current
    if (!el) return // current track isn't in this list → nothing to jump to
    jumpedFor.current = jumpKey ?? null
    el.scrollIntoView({ block: 'center' })
  }, [jumpKey, busy, currentTrackId, rows, virtualized, currentIndex, viewport, virtualizer])
  // A different list re-arms the jump.
  useEffect(() => {
    if (jumpedFor.current !== jumpKey) jumpedFor.current = null
  }, [jumpKey])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea ref={scrollRootRef} className="min-h-0 flex-1 px-2 py-1.5 pb-24 scrollbar-mac">
        {/* scrollable={false}:Table 自带的 overflow-x-auto 包裹层会抢走 sticky 的
         *  滚动容器,表头要贴的是这个 ScrollArea。材质/圆角/z 由 TableHeader sticky 出。 */}
        <Table scrollable={false} className="table-fixed">
          <TableHeader sticky>
            <TableRow>
              <TableHead className="w-8 text-center">#</TableHead>
              <TableHead>标题</TableHead>
              <TableHead className="w-[28%]">专辑</TableHead>
              <TableHead className="w-10 text-center">喜欢</TableHead>
              <TableHead className="w-[84px] text-right">时长</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
          {busy && (
            <TableRow>
              <TableCell colSpan={5} className="whitespace-normal py-16 text-center text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2"><Loader2 className="size-5 animate-spin" />{busyText}</span>
              </TableCell>
            </TableRow>
          )}
          {padTop > 0 && <VirtualPad height={padTop} side="top" />}
          {!busy && windowRows.map(({ row, index }) => {
            const job = row.trackKey ? jobs[row.trackKey] : undefined
            const likeKey = row.likeRef ? `${row.likeRef.platform}:${row.likeRef.trackId}` : row.trackKey
            const isCurrent = !!row.track && !row.muted && stage.current?.id === row.track.id
            return (
              <TrackRow
                key={row.id}
                row={row}
                index={index}
                baseUrl={baseUrl}
                isCurrent={isCurrent}
                isPlaying={isCurrent && stage.playing}
                isLiked={likeKey ? liked.has(likeKey) : false}
                job={job}
                isArchived={row.trackKey ? (archived[row.trackKey] || !!job?.archived) : false}
                canDownload={!!onDownload && canDownloadRow(row)}
                selectMode={!!selectMode}
                // 勾选态读的是 selectedIds(数据),不是"这一行在不在 DOM 里"——虚拟化之后
                // 没上屏的行照样在选中集里,批量动作也照样作用到它们(见 pickDownloadTargets)。
                selected={!!selectedIds?.has(row.id)}
                onToggleLike={handleToggleLike}
                onToggleSelect={handleToggleSelect}
                onDownload={handleDownload}
                onPlay={handlePlay}
                collect={stableCollect}
                rowRef={isCurrent ? currentRowRef : undefined}
                // 多选模式下不给拖:那时候按下一行的意思是"勾上它",两种手势抢同一个按压。
                drag={onReorder && !selectMode
                  ? { onDragStart: dragStart, onDragEnter: dragEnter, onDragEnd: dragEnd, isDropTarget: dragFrom !== null && dragOver === index && dragOver !== dragFrom }
                  : undefined}
              />
            )
          })}
          {padBottom > 0 && <VirtualPad height={padBottom} side="bottom" />}
          {!busy && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="whitespace-normal py-6 text-center text-sm text-muted-foreground">{emptyText}</TableCell>
            </TableRow>
          )}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  )
}

/** ⋯ 菜单每一项的图标(spec §2 的菜单表逐项列了图标语义)。放在 map 里而不是塞进
 *  toolbarMenuItems 的返回值,是为了让 musicToolbar.ts 保持纯数据、不 import React。 */
const TOOLBAR_MENU_ICONS: Record<string, ReactNode> = {
  downloadAll: <Download />,
  sync: <RefreshCw />,
  netdisk: <HardDrive />,
  exportM3u: <ListMusic />,
  rename: <Pencil />,
  remove: <Trash2 />,
}

/**
 * L2 曲目表的顶部动作区——台面上恒定就三件：播放全部 / 多选 / ⋯。
 *
 * 收敛之前这里按列表类型换三套按钮(普通歌单 6 个、播单 3 个、我喜欢的 2 个)，同一个动作
 * 换个歌单就换个位置，用户没法预测；而且 destructive 的「删除」跟高频的「播放全部」同级并排。
 * 现在差异全部沉进 ⋯ 菜单，菜单项按「回调传没传」出现——传了就是有这项能力。
 */
export function TrackListToolbar({
  playDisabled, onPlayAll, selectMode, onToggleSelectMode,
  onDownloadAll, sync, onNetdisk, onRename, onRemove, onExportM3u,
}: {
  playDisabled: boolean
  onPlayAll: () => void
  selectMode: boolean
  onToggleSelectMode: () => void
  onDownloadAll?: () => void
  sync?: { on: boolean; onToggle: () => void }
  onNetdisk?: () => void
  onRename?: () => void
  onRemove?: () => void
  onExportM3u?: () => void
}) {
  const caps: ToolbarCaps = {
    downloadAll: !!onDownloadAll,
    sync: sync ? { on: sync.on } : null,
    netdisk: !!onNetdisk,
    rename: !!onRename,
    remove: !!onRemove,
    exportM3u: !!onExportM3u,
  }
  const entries = toolbarMenuItems(caps)
  // 勾选态挪到行尾:shadcn 的 CheckboxItem 自带一条 32px 的前置勾选槽(指示器绝对定位在 left-2),
  // 而这个菜单**每一项都自带前置图标**,两者抢同一个位置——普通项得跟着补 pl-8 才对得齐,结果整列
  // 内容被推到左边 37px 处、右边只剩 8px,看着就是没左对齐。前置槽让给图标,✓ 放行尾:
  // 隐藏自带指示器(它是 CheckboxItem 的第一个 span),自己在 children 末尾渲染一个 ml-auto 的 ✓。
  // 共用组件不动——别处还靠它现在的几何。
  const CHECK_TRAILING = '[&>span:first-child]:hidden pl-2 pr-2'
  const run: Record<string, (() => void) | undefined> = {
    downloadAll: onDownloadAll,
    sync: sync?.onToggle,
    netdisk: onNetdisk,
    rename: onRename,
    remove: onRemove,
    exportM3u: onExportM3u,
  }
  return (
    <>
      <Button size="small" disabled={playDisabled} onClick={onPlayAll}>
        <Play className="size-4" /> 播放全部
      </Button>
      {/* 「多选」是个开关,但它开着只表现为换个颜色——读屏用户拿不到这个状态,得靠 aria-pressed 说。 */}
      <Button size="small" variant={selectMode ? 'default' : 'neutral'} aria-pressed={selectMode} onClick={onToggleSelectMode}>
        <ListChecks className="size-4" /> 多选
      </Button>
      {entries.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="small" variant="neutral" aria-label="更多操作">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" size="sm" className="w-44">
            {entries.map((e) => {
              if (e.kind === 'separator') return <DropdownMenuSeparator key={e.key} />
              const icon = TOOLBAR_MENU_ICONS[e.key]
              if (e.kind === 'checkbox') {
                return (
                  // e.preventDefault():Radix 默认选中即关菜单,勾选态刚翻过来菜单就没了,用户看不到
                  // 自己那一下有没有生效。开关类的项必须留在原地把勾亮给用户看;普通项照旧关。
                  <DropdownMenuCheckboxItem key={e.key} checked={e.checked} className={CHECK_TRAILING}
                    onSelect={(ev) => { ev.preventDefault(); run[e.key]?.() }}>
                    {icon}{e.label}
                    {e.checked && <Check className="ml-auto size-3.5" />}
                  </DropdownMenuCheckboxItem>
                )
              }
              return (
                <DropdownMenuItem key={e.key} variant={e.destructive ? 'destructive' : 'default'}
                  onSelect={() => run[e.key]?.()}>
                  {icon}{e.label}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
}

/** 多选浮动操作条——frosted 悬浮语言同 NowPlayingBar(spec §5.2)。
 *  动作长在这条上而不是顶部工具栏,是因为它们作用的对象是"选中的这些行"——控件要挨着
 *  它作用的东西(apple-design §16 grouping & mapping)。 */
export function SelectionBar({ conn, count, anchorStreamId, onPick, onDownload, onCancel }: {
  conn: Connection
  count: number
  anchorStreamId: string | null
  onPick: (collectionId: string) => void   // 选中既有播单或新建后回调,由父级发批量请求
  onDownload: () => void
  onCancel: () => void
}) {
  const [open, setOpen] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [newLabel, setNewLabel] = useState('')
  useEffect(() => {
    if (!open) return
    // 弹层打开才拉列表——锚定本 stream 的排前面
    api.collections(conn, 'audio').then((all) => {
      const sorted = [...all.filter((c) => !c.system)].sort((a, b) =>
        Number(b.anchorStreamId === anchorStreamId) - Number(a.anchorStreamId === anchorStreamId))
      setCollections(sorted)
    }).catch(() => setCollections([]))
  }, [open, conn, anchorStreamId])
  const create = async () => {
    const label = newLabel.trim()
    if (!label) return
    const created = await api.createCollection(conn, 'audio', label, anchorStreamId ?? undefined)
    setNewLabel(''); setOpen(false); onPick(created.id)
  }
  return (
    <div className="pointer-events-auto absolute bottom-24 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-[var(--acr-panel)] px-4 py-2 shadow-[0_0_0_1px_rgba(190,190,190,0.16),0_16px_48px_rgba(0,0,0,0.45)] backdrop-blur-xl">
      <span className="text-[13px] tabular-nums">已选 {count} 首</span>
      <Button size="small" variant="neutral" onClick={onDownload}>
        <Download className="size-4" /> 下载
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="small"><ListPlus className="size-4" /> 加入播单</Button>
        </PopoverTrigger>
        <PopoverContent align="center" side="top" className="w-56 p-1.5">
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto scrollbar-mac">
            {collections.map((c) => (
              <button key={c.id} onClick={() => { setOpen(false); onPick(c.id) }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--acr-hover)]">
                <ListMusic className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.anchorStreamId === anchorStreamId && <span className="text-[10px] text-muted-foreground">本节目</span>}
              </button>
            ))}
            {collections.length === 0 && <div className="px-2 py-2 text-[12px] text-muted-foreground">还没有播单。</div>}
          </div>
          <div className="mt-1 border-t border-[var(--acr-border-soft)] pt-1.5">
            <Input placeholder="新建播单…" value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void create() }} />
          </div>
        </PopoverContent>
      </Popover>
      <Button size="small" variant="ghost" onClick={onCancel}>取消</Button>
    </div>
  )
}

/**
 * 歌单 (Audio Channel) view — Apple-Music-style two levels:
 *  L1 = grid of subscribed playlists/stations (cover cards, hover ▶ to play the whole list);
 *  L2 = the selected playlist's track list (with a back button). A persistent floating
 *  NowPlayingBar sits at the bottom and is the global transport.
 */
export function MusicChannel({ conn, channels, onChannelsChanged, onReload }: { conn: Connection; channels: ChannelView[]; onChannelsChanged?: () => void; onReload: () => void }) {
  const stage = useAudioStage()
  const [tab, setTab] = useState<ChannelTab>('content')
  const subRouteLocation = useSubRouteLocation()
  const initialMusicRoute = musicRouteFrom(subRouteLocation.pathname())
  const uniqueStreams = useMemo(() => {
    const seen = new Set<string>()
    const res: typeof channels[number]['streams'] = []
    for (const t of channels) {
      for (const s of t.streams) {
        if (!seen.has(s.id)) {
          seen.add(s.id)
          res.push(s)
        }
      }
    }
    return res
  }, [channels])
  // L1 网格的分栏:歌单 / 播客。判据(以及它为什么只能反着认歌单)见 audioStreamKind.ts。
  const gridSections = useMemo(() => splitAudioStreams(uniqueStreams), [uniqueStreams])
  // 锚点名查表——「我的播单」分区里锚定播单的卡片副标要标"锚在哪档节目"。
  const streamLabelById = useMemo(
    () => new Map(uniqueStreams.map((s) => [s.id, s.description || s.id])),
    [uniqueStreams],
  )
  // The in-channel selection lives in a path via useSubRoute (deep-link + refresh + back/forward
  // for free in the main app, and no hand-rolled pushState/popstate to drift). `sel` (which
  // playlist) and `searchedQuery` (the active search) are DERIVED from that route, not independent
  // state. 路径存哪由外层决定——主应用是地址栏，工作台面板里是内存（见 useSubRoute 头注）。
  const { selection: route, navigate } = useSubRoute<MusicRoute>(musicRouteFrom, musicToPath)
  const sel = route.kind === 'playlist' ? route.id : route.kind === 'liked' ? LIKED_PLAYLIST_ID : null // null = L1 grid; set = L2 track list
  const isCollection = route.kind === 'collection'
  const selCollection = route.kind === 'collection' ? route.id : null
  const searchedQuery = route.kind === 'search' ? route.q : ''
  // Remember the L1 playlist grid's scroll: entering a playlist / search unmounts it, so the
  // position is kept in useScrollMemory's module store and restored when the grid remounts.
  const gridScrollRef = useScrollMemory<HTMLDivElement>('music:grid', scrollAreaViewport)
  const [musicQuery, setMusicQuery] = useState(initialMusicRoute.kind === 'search' ? initialMusicRoute.q : '')
  const [filterQuery, setFilterQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [musicResults, setMusicResults] = useState<MusicSearchResult[]>([])
  const [autoplay, setAutoplay] = useState(false) // entered via a card's ▶ → play the whole list
  const [items, setItems] = useState<Item[]>([])
  const [likedTracks, setLikedTracks] = useState<CollectedItem[]>([])
  const [loading, setLoading] = useState(false)
  const [itemsSel, setItemsSel] = useState<string | null>(null) // which playlist `items` belongs to
  const [jobs, setJobs] = useState<Record<string, DownloadJobState>>({}) // `${platform}:${track_id}` → latest queue row
  const [archived, setArchived] = useState<Record<string, boolean>>({}) // `${platform}:${track_id}` → archived locally
  const [sync, setSync] = useState(false)
  const [exportResult, setExportResult] = useState<{ written: number; skipped: number; path?: string } | null>(null)
  /** 「网盘」菜单项打开的那个全景面板（挂载 / 整理 / 配对情况都在里面）。 */
  const [netdiskOpen, setNetdiskOpen] = useState(false)
  const [liked, setLiked] = useState<Set<string>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 子列表 chips(spec §3/§5.4):playlists=锚定本 stream 的播单,scopeId=选中的 chip(null=全部),
  // scopeMembers=选中播单的快照成员,extraItems=跨 stream 成员补拉到的 live item(按 item.id 存)。
  const [playlists, setPlaylists] = useState<Collection[]>([])
  const [scopeId, setScopeId] = useState<string | null>(null)
  const [scopeMembers, setScopeMembers] = useState<CollectedItem[] | null>(null)
  const [extraItems, setExtraItems] = useState<Map<string, Item>>(new Map())
  const [renaming, setRenaming] = useState<Collection | null>(null)
  const [renameLabel, setRenameLabel] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [deleting, setDeleting] = useState<Collection | null>(null)
  const [deleteSaving, setDeleteSaving] = useState(false)
  // L1「我的播单」分区的数据源——自建播单(system 为空),锚定的和全局的都在。
  const [audioCollections, setAudioCollections] = useState<Collection[]>([])
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [newPlaylistLabel, setNewPlaylistLabel] = useState('')
  const lastJobStates = useRef<Record<string, string>>({})
  // Mirror `jobs` into a ref so the safety-net poll interval (set up per [conn, visibleRefs])
  // can read the live job state without a stale closure.
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  // Mirror `sel` into a ref so refreshPlaylists (called both from the stream-switch effect and
  // imperatively after add/rename/delete) can tell a stale in-flight response for a PREVIOUS
  // stream apart from the current one — switching streams quickly must not let an old
  // api.collections(prevSel) resolve late and overwrite the new stream's chips.
  const selRef = useRef(sel)
  selRef.current = sel
  // 「我的喜欢」现在读写统一收藏系统的 col_audio_liked 系统列表(见 collections/store.ts 头注),
  // 不再是独立的 LikedSongsStore。行内心形按钮特意**不用** CollectButton——那是弹层交互,一个
  // 播放列表能有 2000 首曲目(见下面 api.items limit),给每一行挂一个 CollectButton 会在挂载时
  // 各自打一次 GET /api/collected/:key,量级直接炸;这里维持 parent 管一份 Set + 单击直切的老
  // 交互,只是底层换成统一存储。CollectButton 的多列表面板留给音乐这边量级小的场景(如详情页级
  // 收藏),不下沉到密集行。
  const refreshLiked = () => {
    api.collectionItems(conn, SYSTEM_COLLECTIONS.audioLiked).then((items) => {
      setLiked(new Set(items.map((i) => `${i.platform}:${i.trackId}`)))
      setLikedTracks(items)
    }).catch(() => {})
  }
  const toggleLike = (row: TrackTableRow) => {
    const ref = row.likeRef ?? parseTrackKey(row.trackKey)
    if (!ref) return
    const key = `${ref.platform}:${ref.trackId}`
    const wasLiked = liked.has(key)
    setLiked((prev) => {
      const next = new Set(prev)
      wasLiked ? next.delete(key) : next.add(key)
      return next
    })
    const itemKey = { kind: 'track' as const, platform: ref.platform, trackId: ref.trackId }
    if (wasLiked) {
      setLikedTracks((prev) => prev.filter((t) => `${t.platform}:${t.trackId}` !== key))
      api.removeFromCollection(conn, SYSTEM_COLLECTIONS.audioLiked, itemKey).catch(refreshLiked)
      return
    }
    const optimistic: CollectedItem = {
      key: `track:${ref.platform}:${ref.trackId}`,
      kind: 'track',
      domain: 'audio',
      platform: ref.platform,
      trackId: ref.trackId,
      title: row.title,
      artist: row.author,
      album: row.album,
      poster: row.poster,
      durationS: row.durationS,
      sourceUrl: row.sourceUrl,
      firstCollectedAt: Date.now(),
    }
    setLikedTracks((prev) => [optimistic, ...prev.filter((t) => `${t.platform}:${t.trackId}` !== key)])
    api.addToCollection(conn, SYSTEM_COLLECTIONS.audioLiked, itemKey, {
      title: row.title,
      artist: row.author,
      album: row.album,
      poster: row.poster,
      durationS: row.durationS,
      sourceUrl: row.sourceUrl,
    }).then((saved) => {
      setLikedTracks((prev) => [saved, ...prev.filter((t) => `${t.platform}:${t.trackId}` !== key)])
    }).catch(refreshLiked)
  }

  useEffect(() => {
    refreshLiked()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn])

  const refreshAudioCollections = () => {
    api.collections(conn, 'audio')
      .then((all) => setAudioCollections(all.filter((c) => !c.system)))
      .catch(() => setAudioCollections([]))
  }
  useEffect(() => {
    refreshAudioCollections()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn])

  // load a playlist's tracks when entering it (L2)
  useEffect(() => {
    setSelectMode(false); setSelectedIds(new Set())
    if (!sel || sel === LIKED_PLAYLIST_ID) { setItems([]); setItemsSel(sel); setFilterQuery(''); return }
    let live = true
    setLoading(true)
    setSync(autoDownloadEnabled(findStream(channels, sel)))
    setJobs({})
    setArchived({})
    setFilterQuery('')
    api.items(conn, { stream: sel, limit: 2000 })
      .then((r) => live && setItems(r))
      .catch(() => live && setItems([]))
      .finally(() => { if (live) { setLoading(false); setItemsSel(sel) } })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, sel])

  // channels 常常在 L2 已经打开之后才异步到货(深链/刷新进入时尤其如此)——上面那个 effect 只在
  // [conn, sel] 变化时跑一次 autoDownloadEnabled(findStream(...)),若那一刻 channels 还没到,
  // findStream 返回 undefined、sync 被锁定成 false,且不随 channels 到货重新计算,复现「UI 说关
  // 后端说开」这个本任务本该修掉的 bug(只是触发面更窄)。这条 effect 只做这一件事——channels
  // 到货后重新对齐 sync,不碰 items/loading 等一次性入场状态。
  // 依赖必须是派生出来的布尔值,不是 channels 数组引用本身:channels 由 App.tsx 在渲染体里
  // .filter() 出来,AppView 每次渲染都是新引用,若依赖数组写 channels 会导致这条 effect 在
  // 与 channels 内容无关的每次父组件渲染上重跑,把用户刚点击的乐观更新冲掉。
  const serverAutoDownload = autoDownloadEnabled(findStream(channels, sel))
  useEffect(() => {
    if (!sel || sel === LIKED_PLAYLIST_ID) return
    setSync(serverAutoDownload)
  }, [serverAutoDownload, sel])

  // 进入/离开一个 stream → 重拉本 stream 锚定的子列表,并把 chip 选中态清空(避免带着上一个
  // stream 的 scopeId 进新 stream)。refreshPlaylists 定义在下面(取代 Task 6 的空占位),闭包
  // 在 effect 真正执行(paint 之后)时才解引用,定义顺序不影响正确性。
  useEffect(() => {
    refreshPlaylists()
    setScopeId(null)
    setScopeMembers(null)
    setExtraItems(new Map())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, sel])

  // 选中一个 chip → 拉该播单的快照成员,再按 planScopeResolution 的计划补拉跨 stream 的 live item。
  // 单个 stream 拉挂了不整锅端(spec §6)——对应成员在 scopeRows 里落灰置分支,不是整体失败。
  useEffect(() => {
    setExtraItems(new Map()) // 换 chip(或清空)时先丢上一个 chip 补拉的跨 stream item,别让它跨 scope 残留
    // 浮动条上的「已选 N 首」必须和多选动作实际操作的集合是同一批——chip 一换,上一个 chip 里
    // 勾的行大概率不在新 scope 里了,继续留着选中态只会让数字撒谎,所以一并清空。
    setSelectedIds(new Set())
    if (!scopeId || !sel) { setScopeMembers(null); return }
    let live = true
    api.collectionItems(conn, scopeId).then(async (members) => {
      if (!live) return
      setScopeMembers(members)
      const plan = planScopeResolution(members, sel)
      const fetched = new Map<string, Item>()
      await Promise.all([...plan.fetchStreams.keys()].map(async (sid) => {
        const its = await api.items(conn, { stream: sid, limit: 2000 }).catch(() => [] as Item[])
        for (const it of its) fetched.set(it.id, it)
      }))
      if (live) setExtraItems(fetched)
    }).catch(() => { if (live) { setScopeMembers([]); toast.error('播单成员加载失败') } })
    return () => { live = false }
  }, [conn, scopeId, sel])

  // 播单详情(L2 collection):成员可能散落在任意多个 stream(甚至没有当前 stream)——
  // planScopeResolution 传空串,所有 episode 成员自然落进 fetchStreams 逐个补拉(spec §4)。
  const [collectionMembers, setCollectionMembers] = useState<CollectedItem[] | null>(null)
  const [collectionItems, setCollectionItems] = useState<Map<string, Item>>(new Map())
  const [collectionMeta, setCollectionMeta] = useState<Collection | null>(null)
  // meta(api.collections,整表+find)和 members(api.collectionItems,单表)是两个独立请求,谁先落地
  // 无先后保证——不能拿"members 已到但 meta 还是 null"当"这个 id 不存在"的证据(新建的空播单
  // 的 members 响应通常比整表 collections 先回来)。collectionMetaLoaded 只在 .then(整表成功拉到,
  // 无论 find 到没到)里置真;.catch(网络失败)绝不置真——一次 meta 请求失败不等于"播单不存在",
  // 旗标永远停在"还没解析"比误判成"不存在"更安全,守卫因此不会因为一次网络抖动就把人踢回 L1。
  const [collectionMetaLoaded, setCollectionMetaLoaded] = useState(false)
  useEffect(() => {
    setFilterQuery('') // 换到另一个播单(或离开)清掉上一个的列表内过滤——不然 A 打过的关键词带进 B
    if (!selCollection) {
      setCollectionMembers(null); setCollectionItems(new Map()); setCollectionMeta(null); setCollectionMetaLoaded(false)
      return
    }
    let live = true
    setCollectionMembers(null)
    setCollectionItems(new Map()) // 换 id 时也清跨 stream 补拉的 item——同 extraItems 那条"别让它跨 scope 残留"
    setCollectionMetaLoaded(false) // 换 id 时先复位——别让上一个播单"已解析"的旗标被新 id 误读
    api.collections(conn, 'audio')
      .then((all) => {
        if (!live) return
        // 系统列表(如「我的喜欢」)不是普通播单——排除掉,让手打 URL 落进下面的 bad-id 守卫退回 L1,
        // 不能被当成一条可重命名/删除的自建播单打开(spec §2:系统卡没有这两个动作)。
        setCollectionMeta(all.find((c) => c.id === selCollection && !c.system) ?? null)
        setCollectionMetaLoaded(true)
      })
      .catch(() => { if (live) toast.error('播单信息加载失败') })
    api.collectionItems(conn, selCollection).then(async (members) => {
      if (!live) return
      setCollectionMembers(members)
      const plan = planScopeResolution(members, '')   // 空当前 stream → 全部走补拉
      const fetched = new Map<string, Item>()
      await Promise.all([...plan.fetchStreams.keys()].map(async (sid) => {
        const its = await api.items(conn, { stream: sid, limit: 2000 }).catch(() => [] as Item[])
        for (const it of its) fetched.set(it.id, it)
      }))
      if (live) setCollectionItems(fetched)
    }).catch(() => { if (live) { setCollectionMembers([]); toast.error('播单加载失败') } })
    return () => { live = false }
  }, [conn, selCollection])

  const { collectionRows, collectionTracks } = useMemo(() => {
    if (!collectionMembers) return { collectionRows: null as TrackTableRow[] | null, collectionTracks: [] as AudioTrack[] }
    const { rows, tracks } = buildMemberRows(collectionMembers, (id) => collectionItems.get(id), conn.baseUrl)
    return { collectionRows: rows, collectionTracks: tracks }
  }, [collectionMembers, collectionItems, conn.baseUrl])

  // 深链到不存在的 id → 退回 L1(spec §6)。判定逻辑抽成纯函数 shouldBounceCollection(见
  // playlistScope.ts)——上一轮就是因为这条判断内联在 effect 里出了 Critical race(meta/members
  // 无序、network 失败误判成"不存在"),抽出来才能单测钉住。
  useEffect(() => {
    if (shouldBounceCollection({ selCollection, membersLoaded: collectionMembers !== null, metaLoaded: collectionMetaLoaded, meta: collectionMeta })) {
      navigate({ kind: 'home' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selCollection, collectionMembers, collectionMetaLoaded, collectionMeta])

  // busy = we've entered a playlist whose tracks aren't loaded yet. Derived from render state
  // (not the loading flag, which a useEffect only flips after paint) so the spinner shows on the
  // very first frame of L2 — no flash of the empty-state message.
  const busy = isCollection ? collectionMembers === null : (sel != null && sel !== LIKED_PLAYLIST_ID && itemsSel !== sel)

  // 网盘条目的标签取自它挂载的那个目录名（`…/下架` → 「下架」）。selStream 在下面才声明，
  // 这里直接从 channels 取同一条流，免得为一个标签把声明顺序整个搬家。
  const netdiskLabel = useMemo(
    () => netdiskLabeller(channels.flatMap((t) => t.streams).find((s: { id: string }) => s.id === sel)?.sources),
    [channels, sel],
  )

  const { rows, playableTracks } = useMemo(() => {
    const playableTracks: AudioTrack[] = []
    // 集号重排必须发生在**这里**(items 层),不能只排表格行:行和播放队列是同一趟产出的,
    // 只排行会让队列仍按旧序走——点第一首之后"下一首"跳到别处。
    const rows = sortByEpisodeNo(items, songTitle).map((item) => {
      const track = toTrack(item, conn.baseUrl)
      const playIndex = track ? playableTracks.push(track) - 1 : -1
      return { item, track, playIndex }
    })
    return { rows, playableTracks }
  }, [items, conn.baseUrl])

  const tableRows = useMemo<TrackTableRow[]>(
    () => rows.map(({ item, track, playIndex }) => {
      const trackKey = itemTrackKey(item)
      return {
        id: item.id,
        title: songTitle(item),
        author: typeof item.author === 'string' ? item.author : undefined,
        album: albumFromText(item.content?.text),
        poster: track?.poster ?? itemPoster(item),
        durationS: track?.durationS,
        track: track ?? undefined,
        playIndex,
        vip: isVip(item),
        origin: rowOrigin(item, netdiskLabel),
        trackKey,
        likeRef: parseTrackKey(trackKey) ?? undefined,
        sourceUrl: item.url,
        muted: !track,
        sourceItem: item,
      }
    }),
    [rows]
  )

  // auto-play the whole list once its tracks load (when entered via a card's ▶ button)
  useEffect(() => {
    if (autoplay && !loading && playableTracks.length > 0) {
      stage.playQueue(playableTracks, 0, 'music')
      setAutoplay(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, loading, playableTracks])

  const selStream = findStream(channels, sel)
  const isLikedPlaylist = sel === LIKED_PLAYLIST_ID
  // `channels` (the audio channel + its playlists) arrives async; empty = still loading, since the
  // default-audio system channel is always present once loaded (even with zero playlists).
  const layer = musicLayer({ sel, selStream: !!selStream, isLikedPlaylist, channelsLoaded: channels.length > 0, isCollection: route.kind === 'collection' })

  // 面板里挂载/取消挂载了目录之后：后端已经 PATCH 过成员并触发重采，这里只负责把条目重拉一遍
  // 让新集出现（挂载本身连同报错提示都在面板里，见 NetdiskPanel）。
  async function reloadItemsAfterNetdiskChange() {
    if (!selStream) return
    const r = await api.items(conn, { stream: selStream.id, limit: 2000 }).catch(() => null)
    if (r) setItems(r)
  }
  // 「生成 m3u」——目标(Stream / Collection / 都不是)由 planExportTarget 判定，和
  // 「下载整单」的 planDownloadAll 是同一个形状：判定是纯函数、执行留在这里。
  const exportTarget = planExportTarget({ isCollection, isLikedPlaylist, streamId: sel, collectionId: selCollection })
  const exportM3u = async () => {
    if (!exportTarget) return
    try {
      const result = exportTarget.kind === 'collection'
        ? await api.exportCollectionPlaylist(conn, exportTarget.id)
        : await api.exportStreamPlaylist(conn, exportTarget.id)
      setExportResult(result)
    } catch {
      toast.error('生成 m3u 失败')
    }
  }
  // likedTracks 只从 col_audio_liked(纯 track 分支)拉,platform/trackId 按构造必然有值——
  // CollectedItem 的类型是三种 kind 共用的判别式,这里断言窄化回 track 分支的实际形状。
  const likedAudioTracks = useMemo(
    () => likedTracks.map((r): AudioTrack => ({
      id: `liked:${r.platform}:${r.trackId}`,
      kind: 'music',
      url: audioResolveUrl(conn.baseUrl, { platform: r.platform!, trackId: r.trackId! }),
      title: r.title,
      author: r.artist,
      // AudioTrack.poster 是展示就绪的（见 audioStage.ts 上的契约）。
      poster: r.poster ? imgUrl(conn.baseUrl, r.poster) : undefined,
      durationS: r.durationS,
    })),
    [conn.baseUrl, likedTracks]
  )
  const likedRows = useMemo<TrackTableRow[]>(
    () => likedTracks.map((result, index) => ({
      id: `liked:${result.platform}:${result.trackId}`,
      title: result.title,
      author: result.artist,
      album: result.album,
      poster: result.poster,
      durationS: result.durationS,
      track: likedAudioTracks[index],
      playIndex: index,
      trackKey: `${result.platform}:${result.trackId}`,
      likeRef: { platform: result.platform!, trackId: result.trackId! },
      sourceUrl: result.sourceUrl,
    })),
    [likedTracks, likedAudioTracks]
  )
  // 子列表 chip 选中的行集(spec §3):播放唯一真相=live item——当前 stream 的分集直接在已加载
  // items 里找,跨 stream 的分集在 extraItems 里找(上面的 effect 补拉);找不到 live item(源
  // stream 被删/换 id)→ muted:true 灰置展示,不静默消失。track 成员不依赖 stream,经 resolve 播。
  const itemsById = useMemo(() => new Map(items.map((it) => [it.id, it])), [items])
  const { scopeRows, scopeTracks } = useMemo(() => {
    if (!scopeMembers) return { scopeRows: null as TrackTableRow[] | null, scopeTracks: [] as AudioTrack[] }
    const { rows, tracks } = buildMemberRows(scopeMembers, (id) => itemsById.get(id) ?? extraItems.get(id), conn.baseUrl)
    return { scopeRows: rows, scopeTracks: tracks }
  }, [scopeMembers, itemsById, extraItems, conn.baseUrl])
  // L2 列表内搜索:纯前端过滤已加载的完整历史(spec §5.1)。行的 playIndex 指向全量
  // playableTracks,过滤只收窄可见行,不动播放队列语义。chip 收窄的范围(scopeRows)与文本过滤
  // 可叠加:先按 chip 收窄,再在收窄后的行集里做文本过滤。
  const filteredTableRows = useMemo(
    () => filterRows(pickListRows({ collectionRows, scopeRows, isLikedPlaylist, likedRows, tableRows }), filterQuery),
    [collectionRows, scopeRows, isLikedPlaylist, likedRows, tableRows, filterQuery]
  )

  /**
   * 手动排序只在**自建播单**里给，且**搜索框是空的时候**才给。
   *
   * 后者不是保守，是正确性：搜过之后表格里是名单的一个子集，行下标和真名单对不上，照着它写回去
   * 会把没显示的那些成员顺序搅乱——而用户完全看不到自己搞坏了什么。整份名单写回去的前提就是
   * 手里这份**就是**整份名单。
   *
   * 「我的喜欢」这类系统列表暂不给：它的行走的是另一条数据源（likedTracks），不是 collectionMembers,
   * 拖出来的下标映射不到成员键。要给它得先把那条路并过来，不在这一轮里。
   */
  const reorderMembers = useMemo(() => {
    // 自建播单和「我的喜欢」是**同一种东西**——两边的成员都是 api.collectionItems 拉回来的
    // CollectedItem[]，行也都按同一顺序一一对应，所以只是"这一屏的成员名单存在哪个 state 里"
    // 不同，不存在两条数据源。
    const target = isCollection && selCollection && collectionMembers
      ? { id: selCollection, members: collectionMembers, set: setCollectionMembers }
      : isLikedPlaylist
        ? { id: SYSTEM_COLLECTIONS.audioLiked, members: likedTracks, set: setLikedTracks }
        : null
    // 搜索框有字时不给拖：那时表格里是名单的**子集**，行下标对不上真名单，整份写回去会把没显示的
    // 那些搅乱——而用户完全看不见自己搞坏了什么。
    if (!target || filterQuery.trim()) return undefined
    const { id, members, set } = target
    return (from: number, to: number) => {
      const next = moveInOrder(members, from, to)
      if (next === members) return
      set(next) // 乐观：拖完立刻定在那儿，不等一个网络往返
      api.reorderCollection(conn, id, next.map((m) => m.key)).catch((e: unknown) => {
        set(members) // 失败就弹回去——留着一个其实没存下来的顺序比报错更糟
        toast.error('排序没保存', { description: e instanceof Error ? e.message : String(e) })
      })
    }
  }, [isCollection, selCollection, collectionMembers, isLikedPlaylist, likedTracks, filterQuery, conn])
  const activeTracks = collectionRows ? collectionTracks : scopeRows ? scopeTracks : isLikedPlaylist ? likedAudioTracks : playableTracks
  const searchTracks = useMemo(
    () => musicResults.map((r): AudioTrack => ({
      id: r.id,
      kind: 'music',
      url: audioResolveUrl(conn.baseUrl, { platform: r.platform, trackId: r.trackId }),
      title: r.title,
      author: r.artist,
      // AudioTrack.poster 是展示就绪的（见 audioStage.ts 上的契约）。
      poster: r.poster ? imgUrl(conn.baseUrl, r.poster) : undefined,
      durationS: r.durationS,
    })),
    [conn.baseUrl, musicResults]
  )
  const searchRows = useMemo<TrackTableRow[]>(
    () => musicResults.map((result, index) => ({
      id: result.id,
      title: result.title,
      author: result.artist,
      album: result.album,
      poster: result.poster,
      durationS: result.durationS,
      track: searchTracks[index],
      playIndex: index,
      trackKey: `${result.platform}:${result.trackId}`,
      likeRef: { platform: result.platform, trackId: result.trackId },
      sourceUrl: result.sourceUrl,
    })),
    [musicResults, searchTracks]
  )
  const visibleRows = isLikedPlaylist ? likedRows : searchedQuery ? searchRows : tableRows
  const visibleRefs = useMemo(
    () => visibleRows
      .map((row) => row.likeRef ?? parseTrackKey(row.trackKey))
      .filter((ref): ref is { platform: string; trackId: string } => !!ref),
    [visibleRows]
  )

  useEffect(() => {
    if (visibleRefs.length === 0) {
      setArchived({})
      return
    }
    let live = true
    api.archiveStatus(conn, visibleRefs).then((r) => {
      if (live) setArchived(r.archived)
    }).catch(() => {
      if (live) setArchived({})
    })
    return () => { live = false }
  }, [conn, visibleRefs])

  const refreshDownloadState = async (opts: { notify?: boolean } = {}) => {
    const r = await api.downloadJobs(conn)
    const nextJobs: Record<string, DownloadJobState> = {}
    const titles = new Map(visibleRows.map((row) => [row.trackKey, row.title]))
    const nextArchived = visibleRefs.length ? (await api.archiveStatus(conn, visibleRefs)).archived : {}
    const latestJobs = new Map<string, (typeof r.jobs)[number]>()
    for (const j of r.jobs) {
      const key = `${j.platform}:${j.track_id}`
      const prev = latestJobs.get(key)
      if (!prev || j.id > prev.id) latestJobs.set(key, j)
    }
    for (const [key, j] of latestJobs) {
      nextJobs[key] = {
        id: j.id,
        state: j.state,
        attempts: j.attempts,
        lastError: j.last_error,
        downloadedBytes: j.downloaded_bytes,
        totalBytes: j.total_bytes,
        archived: j.archived,
        failedAt: j.state === 'failed'
          ? jobs[key]?.id === j.id ? jobs[key]?.failedAt : (lastJobStates.current[key] === 'queued' || lastJobStates.current[key] === 'running') ? Date.now() : undefined
          : undefined,
      }
      if (opts.notify) {
        const prev = lastJobStates.current[key]
        const wasActive = prev === 'queued' || prev === 'running'
        if (wasActive && j.state === 'done' && !j.archived && !nextArchived[key]) {
          toastDownloadError('归档失败', `${titles.get(key) ?? key}：归档文件不存在或已被移动`)
        } else if (wasActive && j.state === 'failed') {
          toastDownloadError('下载失败', `${titles.get(key) ?? key}${j.last_error ? `：${j.last_error}` : ''}`)
        }
      }
    }
    lastJobStates.current = Object.fromEntries(Object.entries(nextJobs).map(([key, job]) => [key, job.state]))
    setJobs((prev) => {
      const next = { ...prev }
      const seen = new Set(Object.keys(nextJobs))
      for (const [key, job] of Object.entries(nextJobs)) {
        next[key] = mergeDownloadJobState(prev[key], job)
      }
      for (const [key, job] of Object.entries(prev)) {
        if (!seen.has(key) && (job.state === 'queued' || job.state === 'running' || job.failedAt)) {
          next[key] = job
        }
      }
      return next
    })
    setArchived((prev) => ({ ...prev, ...nextArchived }))
  }

  // Job updates arrive live over the WebSocket (useWs below); this interval is only a
  // safety-net that refetches while a job is still queued/running, to recover from a
  // dropped WS frame. An idle playlist polls nothing. The one-shot tick on mount/visibleRefs
  // change refreshes state + notify titles for the newly visible rows.
  useEffect(() => {
    let live = true
    const tick = () => refreshDownloadState({ notify: true }).catch(() => {})
    tick()
    const iv = setInterval(() => {
      if (!live) return
      const active = Object.values(jobsRef.current).some((j) => j.state === 'queued' || j.state === 'running')
      if (active) tick()
    }, 5000)
    return () => { live = false; clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, visibleRefs])

  useWs(
    api.wsUrl(conn),
    useCallback((m) => {
      if (m.type !== 'audio-download') return
      const key = `${m.job.platform}:${m.job.track_id}`
      setJobs((prev) => {
        const nextJob = mergeDownloadJobState(prev[key], {
          id: m.job.id,
          state: m.job.state,
          attempts: m.job.attempts,
          lastError: m.job.last_error,
          downloadedBytes: m.job.downloaded_bytes,
          totalBytes: m.job.total_bytes,
          archived: m.job.archived,
          failedAt: m.job.state === 'failed'
            ? prev[key]?.id === m.job.id ? prev[key]?.failedAt : Date.now()
            : undefined,
        })
        const current = prev[key]
        if (
          current?.id === nextJob.id &&
          current.state === nextJob.state &&
          current.attempts === nextJob.attempts &&
          current.lastError === nextJob.lastError &&
          current.downloadedBytes === nextJob.downloadedBytes &&
          current.totalBytes === nextJob.totalBytes &&
          current.archived === nextJob.archived &&
          current.failedAt === nextJob.failedAt
        ) return prev
        return { ...prev, [key]: nextJob }
      })
      if (m.job.archived) setArchived((prev) => ({ ...prev, [key]: true }))
    }, [])
  )
  useEffect(() => {
    const failed = Object.entries(jobs).filter(([, job]) => job.state === 'failed' && job.failedAt)
    if (!failed.length) return
    const delay = Math.max(250, Math.min(...failed.map(([, job]) => Math.max(0, 5000 - (Date.now() - (job.failedAt ?? 0))))))
    const timer = setTimeout(() => {
      const now = Date.now()
      setJobs((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [key, job] of Object.entries(next)) {
          if (job.state === 'failed' && job.failedAt && now - job.failedAt >= 5000) {
            delete next[key]
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, delay)
    return () => clearTimeout(timer)
  }, [jobs])
  // Submit the search box → navigate to the search route (empty query returns to the grid).
  // The actual fetch is driven by the route below, so button, Enter, deep-link and back/forward
  // all take the same path.
  const runMusicSearch = (nextQuery?: string) => {
    const q = (nextQuery ?? musicQuery).trim()
    if (!q) { navigate({ kind: 'home' }); return }
    setMusicQuery(q)
    navigate({ kind: 'search', q })
  }
  // Fetch results whenever the searched query (from the URL) changes — covers typing+Enter,
  // a /music/search/<q> deep-link, and browser back/forward onto a search. Keep the input box in
  // sync with the URL's query so a restored search shows its terms.
  useEffect(() => {
    if (!searchedQuery) { setMusicResults([]); setSearching(false); return }
    setMusicQuery(searchedQuery)
    let live = true
    setSearching(true)
    api.musicSearch(conn, searchedQuery)
      .then((r) => { if (live) setMusicResults(r) })
      .catch(() => { if (live) setMusicResults([]) })
      .finally(() => { if (live) setSearching(false) })
    return () => { live = false }
  }, [conn, searchedQuery])
  // 只负责"把这一行送进队列"：乐观置 queued、发请求、失败回滚。不刷新、不弹 toast——
  // 刷新和提示由调用方决定,因为单行和批量在这两件事上要求相反(见 downloadRow / runDownloadBatch)。
  const enqueueRow = async (
    row: TrackTableRow,
    opts: { skipArchived?: boolean; optimistic?: boolean; force?: boolean } = {},
  ): Promise<{ ok: true; enqueued: number } | { ok: false; error?: unknown }> => {
    const ref = row.likeRef ?? parseTrackKey(row.trackKey)
    if (!row.sourceItem && !ref) return { ok: false }
    const key = row.trackKey
    // 乐观置 queued 只对单行按钮成立——批量路径请求发出前并不知道后端会不会因为"已下载过"
    // 直接跳过,预置一片 queued 灯再回滚,正是"点一下整单就像触发了几十个下载"的观感来源。
    // 批量的真相由整批跑完那一次 refreshDownloadState + WS 的 job 事件来画。
    if (key && opts.optimistic) setJobs((prev) => {
      const current = prev[key]
      if (current?.state === 'queued' || current?.state === 'running') return prev
      return { ...prev, [key]: { state: 'queued' } }
    })
    try {
      const r = await api.download(conn, row.sourceItem
        ? { itemId: row.sourceItem.id, skipArchived: opts.skipArchived, force: opts.force }
        : {
          track: {
            platform: ref!.platform,
            trackId: ref!.trackId,
            title: row.title,
            artist: row.author,
            // 专辑名只有这一行手里有（从 item 的「专辑：X」解析出来的）——后端下载 provider
            // 解析不出它。不传就等于告诉后端"这首歌没有专辑"，写进文件的 ID3 里那一栏就是空的。
            album: row.album || undefined,
            pageUrl: row.sourceUrl,
          },
          skipArchived: opts.skipArchived,
          force: opts.force,
        })
      return { ok: true, enqueued: r.enqueued }
    } catch (e) {
      if (key) setJobs((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      return { ok: false, error: e }
    }
  }
  // 行内下载按钮：一行一次,立刻刷状态、失败立刻点名。**不带 skipArchived、恒带 force**——
  // 已下载的歌这个菜单项写的就是「重新下载」,那是用户的明确意图。不跳过入队还不够:归档层
  // 自己还有一道"文件在盘且质量不更差就跳过"的闸,不显式 force 的话这一趟跑完是 skipped,
  // 字节没动、标签也没重写(skipped 不写标签),用户看到的就是"点了没反应"。
  // 没下载过的行传 force 是空操作(没有东西可跳过),所以不必先去问 archived 状态。
  const downloadRow = async (row: TrackTableRow) => {
    const r = await enqueueRow(row, { optimistic: true, force: true })
    if (r.ok) { await refreshDownloadState().catch(() => {}); return }
    if ('error' in r) {
      toastDownloadError('加入下载队列失败', r.error instanceof Error ? r.error.message : row.title)
    }
  }
  // 批量下载(下载整单 / 多选下载)共用的跑批。两件事和单行不同：
  // (1) 并发要有上限——refreshDownloadState 每次是 downloadJobs + archiveStatus 两个请求,
  //     按老写法每行下完立刻刷一次,300 首的「我喜欢的」就是 300 次刷新;所以队列只开 4 条腿,
  //     并且整批跑完只刷**一次**状态(enqueueRow 本身仍是逐行 setJobs,这一步没有合并)。
  // (2) 不逐行弹红字,跑完按真实结果汇总成一条(见 downloadBatchMessage)。
  // (3) 带 skipArchived——队列的 single-flight 只挡"排队中/在跑"的同一首,挡不住**已经下完**的,
  //     不带这一条,一份大半已归档的「我喜欢的」会被整份重下。判断归属后端:前端那份 archived
  //     缓存只覆盖 likedRows/tableRows/搜索结果(见 visibleRows),播单那条路它是空的,不能信。
  const runDownloadBatch = async (targets: TrackTableRow[], skipped: number) => {
    let succeeded = 0
    let failed = 0
    let archivedAlready = 0
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const row = targets[cursor++]
        const r = await enqueueRow(row, { skipArchived: true })
        if (!r.ok) { failed++; continue }
        r.enqueued > 0 ? succeeded++ : archivedAlready++
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(DOWNLOAD_BATCH_CONCURRENCY, targets.length) }, () => worker())
    )
    await refreshDownloadState().catch(() => {})
    const msg = downloadBatchMessage({ succeeded, failed, skipped, archived: archivedAlready })
    msg.kind === 'success' ? toast.success(msg.text) : toast.error(msg.text)
  }
  const toggleSelectRow = (row: TrackTableRow) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(row.id) ? next.delete(row.id) : next.add(row.id)
      return next
    })
  }
  // 拉本 stream 锚定的子列表(chips)——「我的喜欢」没有 stream 上下文,不适用。捕获调用当下的
  // sel,响应落地时和 selRef.current(当前 sel)比对——快速切换 stream 时,前一个 stream 的
  // 请求可能晚于新 stream 的请求落地,比对不过就丢弃,不覆盖新 stream 已经显示的 chips。
  const refreshPlaylists = () => {
    if (!sel || isLikedPlaylist) { setPlaylists([]); return }
    const forStream = sel
    api.collections(conn, 'audio', forStream)
      .then((pls) => { if (forStream === selRef.current) setPlaylists(pls) })
      .catch(() => { if (forStream === selRef.current) setPlaylists([]) })
  }
  const confirmRenamePlaylist = async () => {
    if (!renaming) return
    const label = renameLabel.trim()
    if (!label) return
    setRenameSaving(true)
    try {
      await api.renameCollection(conn, renaming.id, label)
      // 正在看的就是这个播单的详情页(collectionMeta)——它的 effect 只 key 在 [conn, selCollection],
      // 改名不会让它重拉,标题会一直停在旧名字直到用户离开再回来。直接乐观改写本地 meta,不等重拉。
      if (selCollection === renaming.id) setCollectionMeta((m) => (m ? { ...m, label } : m))
      setRenaming(null)
      refreshPlaylists()
      refreshAudioCollections()
    } catch {
      toast.error('重命名失败')
    } finally {
      setRenameSaving(false)
    }
  }
  const confirmDeletePlaylist = async () => {
    if (!deleting) return
    const id = deleting.id
    setDeleteSaving(true)
    try {
      await api.deleteCollection(conn, id)
      if (scopeId === id) setScopeId(null)
      const wasOpenCollection = selCollection === id
      setDeleting(null)
      refreshPlaylists()
      if (wasOpenCollection) navigate({ kind: 'home' })
      refreshAudioCollections()
    } catch {
      toast.error('删除失败')
    } finally {
      setDeleteSaving(false)
    }
  }
  // 「下载整单」的落点：普通歌单且没被 chip 收窄时走整单端点(一次请求);其余情况(chip 收窄、
  // 播单、我喜欢的)背后没有一个能表达这批成员的 stream,只能逐行下。
  // 注意：这里故意不叠加 filterQuery——「下载整单」指的是整个列表,不是搜索框当前收窄出来的
  // 可见子集,所以和 filteredTableRows 共用 pickListRows 但不再过一遍 filterRows。
  const downloadAllRows = pickListRows({ collectionRows, scopeRows, isLikedPlaylist, likedRows, tableRows })
  // chip 已经点下去、成员(api.collectionItems)还没落地的那个窗口里,scopeRows 还是 null,
  // pickListRows 会暂时落回整条 stream 的曲目——这时候点「下载整单」下的是一批用户根本没在看的
  // 东西(几百首)。收窄中就先不给这一项,等成员到货再出现。
  const scopePending = !!scopeId && !scopeRows
  const downloadAll = () => {
    const plan = planDownloadAll({ isCollection, isLikedPlaylist, scopeId, streamId: sel })
    if (plan.kind === 'stream') {
      // 整单端点也要跳过已下载的——这条路一直在全量重下,只是「我喜欢的」把它照出来了。
      api.download(conn, { stream: plan.streamId, skipArchived: true })
        .then((r) => {
          const msg = downloadBatchMessage({ succeeded: r.enqueued, failed: 0, skipped: 0, archived: r.skipped })
          msg.kind === 'success' ? toast.success(msg.text) : toast.error(msg.text)
          void refreshDownloadState().catch(() => {})
        })
        .catch(() => toast.error('加入下载队列失败'))
      return
    }
    const { targets, skipped } = pickDownloadTargets({ rows: downloadAllRows, canDownload: canDownloadRow })
    if (targets.length === 0) { toast.error('这个列表里没有可下载的曲目'); return }
    void runDownloadBatch(targets, skipped)
  }
  // 浮动条上的两个动作(加入播单 / 下载)都从**没过搜索框**的整份列表里挑选中行——条上写的
  // 「已选 N 首」数的就是 selectedIds 本身,动作作用的集合必须和那个数字说的是同一批,
  // 否则勾完 10 首再在搜索框里打两个字,点下去只动 4 首而提示一个字都不解释。
  const addSelectedTo = async (collectionId: string) => {
    const streamCtx = !isLikedPlaylist && sel ? sel : null
    const chosen = downloadAllRows.filter((r) => selectedIds.has(r.id))
    const items = chosen.flatMap((r) => {
      const key = rowCollectKey(r, streamCtx)
      return key ? [{ key, title: r.title, poster: r.poster, artist: r.author, album: r.album, durationS: r.durationS, sourceUrl: r.sourceUrl }] : []
    })
    if (items.length === 0) return
    try {
      await api.addToCollectionBatch(conn, collectionId, items)
      toast.success(`已加入播单：${items.length} 首`)
      setSelectMode(false); setSelectedIds(new Set())
      refreshPlaylists() // 刷新 chips 计数(刚加入的成员可能落在某个已有子列表里)
      refreshAudioCollections() // L1「我的播单」卡片的计数同样要跟着动,否则回到 L1 那张卡还停在旧数字
    } catch { toast.error('加入播单失败') }
  }
  // 多选下载:选中行里能下的入队(限流跑批),下不了的(源 stream 被删的灰置行)静静跳过并在
  // 跑完的提示里点明,免得用户以为整批都进了队列。选的范围同样是整份列表,理由见 addSelectedTo 上方。
  const downloadSelected = () => {
    const { targets, skipped } = pickDownloadTargets({
      rows: downloadAllRows, canDownload: canDownloadRow, selection: { ids: selectedIds, idOf: (r) => r.id },
    })
    if (targets.length === 0) { toast.error('选中的曲目都没有可下载的来源'); return }
    void runDownloadBatch(targets, skipped)
    setSelectMode(false); setSelectedIds(new Set())
  }
  // 行内「加入播单」子菜单(TrackActionMenu/TrackContextMenu 的 collect.onChanged)动到的也是同一批
  // 计数——chips(refreshPlaylists)和 L1 卡片(refreshAudioCollections)必须一起刷,理由同上。
  const refreshAfterCollectChange = () => { refreshPlaylists(); refreshAudioCollections() }
  // 「+ 新建播单」——不带 anchorStreamId,创建的是全局播单(不锚在任何一档节目)。
  const createGlobalPlaylist = async () => {
    const label = newPlaylistLabel.trim()
    if (!label) return
    try {
      const created = await api.createCollection(conn, 'audio', label)
      setCreatingPlaylist(false); setNewPlaylistLabel('')
      setAudioCollections((prev) => [...prev, created])
      toast.success(`已创建播单：${label}`)
    } catch { toast.error('创建播单失败') }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {layer === 'loading' ? (
        /* channels still arriving — hold a spinner so a deep-linked playlist/refresh never flashes
         * the grid's "还没有歌单" empty-state before the selection can resolve. */
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> 载入中…
        </div>
      ) : layer === 'track-list' ? (
        /* ===== L2: a playlist's track list ===== */
        <>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Button icon size="large" variant="neutral" aria-label="返回" onClick={() => navigate({ kind: 'home' })}>
              <ChevronLeft />
            </Button>
            {(() => {
              // 播单(collection)不是任何一档节目的封面——恒用 ListMusic 占位图标(spec §4)。
              const cover = isCollection ? undefined : isLikedPlaylist ? likedTracks[0]?.poster : selStream?.image ?? playableTracks[0]?.poster
              return cover ? (
                /* 三个分支的来源不同（likedTracks 是 AudioTrack、selStream.image 是源站原图），
                   但 imgUrl 幂等，无脑包一层就都对——此前只有 liked 那一支包了，另外两支
                   遇到防盗链图床就是一张空白。 */
                <img src={imgUrl(conn.baseUrl, cover)} alt="" className="size-12 shrink-0 rounded-md object-cover" />
              ) : (
                <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  {isLikedPlaylist ? <Heart className="size-5 fill-primary text-primary" /> : <ListMusic className="size-5" />}
                </span>
              )
            })()}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-bold">
                {isCollection ? collectionMeta?.label ?? '播单' : isLikedPlaylist ? '我喜欢的歌曲' : selStream?.description || selStream?.id}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {isCollection
                  ? filterQuery
                    ? `${filteredTableRows.length} / ${collectionRows?.length ?? 0} 首`
                    : `${collectionRows?.length ?? 0} 首`
                  : filterQuery
                    ? `${filteredTableRows.length} / ${isLikedPlaylist ? likedTracks.length : rows.length} 首`
                    : `${isLikedPlaylist ? likedTracks.length : rows.length} 首`}
              </div>
            </div>
            <Searchbar
              size="large"
              className="w-56 max-w-[48%] shrink-0"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              onClear={() => setFilterQuery('')}
              placeholder="搜索本列表"
              aria-label="在列表内搜索"
            />
            <TrackListToolbar
              playDisabled={activeTracks.length === 0}
              onPlayAll={() => stage.playQueue(activeTracks, 0, 'music')}
              selectMode={selectMode}
              onToggleSelectMode={() => { setSelectMode(!selectMode); setSelectedIds(new Set()) }}
              onDownloadAll={!scopePending && downloadAllRows.some(canDownloadRow) ? downloadAll : undefined}
              sync={selStream && !isLikedPlaylist && !isCollection ? {
                on: sync,
                onToggle: () => {
                  if (!sel) return
                  const next = !sync
                  setSync(next)
                  api.setSync(conn, sel, next).catch(() => setSync(!next))
                },
              } : undefined}
              onNetdisk={selStream && !isLikedPlaylist && !isCollection ? () => setNetdiskOpen(true) : undefined}
              onExportM3u={exportTarget ? exportM3u : undefined}
              onRename={isCollection && collectionMeta
                ? () => { setRenaming(collectionMeta); setRenameLabel(collectionMeta.label) }
                : undefined}
              onRemove={isCollection && collectionMeta ? () => setDeleting(collectionMeta) : undefined}
            />
          </div>
          {!isCollection && playlists.length > 0 && (
            <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-4 py-2 scrollbar-mac">
              <Button size="mini" variant={!scopeId ? 'default' : 'neutral'} className="rounded-full" onClick={() => setScopeId(null)}>全部</Button>
              {playlists.map((p) => (
                <ContextMenu key={p.id}>
                  <ContextMenuTrigger asChild>
                    <Button size="mini" variant={scopeId === p.id ? 'default' : 'neutral'} className="rounded-full"
                      onClick={() => setScopeId(scopeId === p.id ? null : p.id)}>
                      {p.label}{typeof p.itemCount === 'number' ? ` (${p.itemCount})` : ''}
                    </Button>
                  </ContextMenuTrigger>
                  <ContextMenuContent size="sm" className="w-32">
                    <ContextMenuItem onSelect={() => { setRenaming(p); setRenameLabel(p.label) }}><Pencil /><span>重命名</span></ContextMenuItem>
                    <ContextMenuItem variant="destructive" onSelect={() => setDeleting(p)}><Trash2 /><span>删除播单</span></ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          )}
          {selStream && !isLikedPlaylist && (
            <NetdiskPanel
              apiBase={conn.baseUrl}
              open={netdiskOpen}
              onOpenChange={setNetdiskOpen}
              streamId={selStream.id}
              streamTitle={selStream.description || selStream.id}
              onChanged={() => { void reloadItemsAfterNetdiskChange() }}
            />
          )}
          <TrackTable
            rows={filteredTableRows}
            queue={activeTracks}
            stage={stage}
            baseUrl={conn.baseUrl}
            liked={liked}
            toggleLike={toggleLike}
            jobs={jobs}
            archived={archived}
            onDownload={downloadRow}
            busy={busy}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelectRow}
            jumpKey={sel ?? undefined}
            onReorder={reorderMembers}
            collect={{ conn, streamId: !isLikedPlaylist && sel ? sel : null, onChanged: refreshAfterCollectChange }}
            emptyText={
              isCollection
                ? (filterQuery ? '没有匹配的曲目。' : '这个播单还是空的——去某个播客里用「加入播单」把节目收进来。')
                : filterQuery
                  ? '没有匹配的节目。'
                  : isLikedPlaylist ? '还没有喜欢的歌曲。' : '这个歌单还没有曲目（等待下次抓取）。'
            }
          />
          <AlertDialog open={!!exportResult} onOpenChange={(open) => { if (!open) setExportResult(null) }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{exportResult?.written ? '已生成 m3u' : '未生成 m3u'}</AlertDialogTitle>
                <AlertDialogDescription>
                  写入 {exportResult?.written ?? 0} 首
                  {exportResult && exportResult.skipped > 0 ? `，跳过 ${exportResult.skipped} 首（还没有本地文件）` : ''}
                  {exportResult?.path ? <>。文件位置：<br /><code className="break-all">{exportResult.path}</code></> : '。没有可写入的曲目，未生成文件。'}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction onClick={() => setExportResult(null)}>好</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        /* ===== L1: grid of playlists / stations ===== */
        <>
        {/* 顶栏照 DSH 对话页那条 navbar：标题行 32px + 上留白 12px，没有图标也没有下边框。 */}
        <div className="flex h-8 shrink-0 items-center gap-2 px-4 pt-3 pb-0 box-content">
          <ChannelTitleMenu
            title={channels[0]?.label ?? channels[0]?.description ?? '歌单'}
            onRefresh={onReload}
            // 恰好一个频道时才给导出：多个的时候"导出哪一个"没有答案（判据同下面那条分页）。
            exportChannel={channels.length === 1 ? { conn, id: channels[0]!.id } : undefined}
            className="min-w-0 flex-1"
          />
          <Searchbar
            size="large"
            className="w-56 max-w-[48%] shrink-0"
            value={musicQuery}
            onChange={(e) => setMusicQuery(e.target.value)}
            onClear={() => setMusicQuery('')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runMusicSearch()
            }}
            placeholder="搜索歌曲 / 歌手"
            aria-label="搜索歌曲或歌手"
          />
        </div>
        {/* 标题栏正下方那条「内容 | 配置」——配置从齿轮开的抽屉改成了分页，见 ChannelTabs 头注。
            没有频道对象（名录还没回来）时不画：配置页没有对象可配。 */}
        {channels[0] ? <ChannelTabs value={tab} onChange={setTab} /> : null}
        {tab === 'config' && channels[0] ? (
          // **只在配置页开着时挂**：它组件体里就调 `useChannels()`，常挂着会强迫每一个宿主
          // 都套一层 `ChannelsProvider`（含只想画个歌单网格的测试）。
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
        <div className="flex min-h-0 flex-1 flex-col">
          {searchedQuery ? (
            <TrackTable
              rows={searchRows}
              queue={searchTracks}
              stage={stage}
              baseUrl={conn.baseUrl}
              liked={liked}
              toggleLike={toggleLike}
              jobs={jobs}
              archived={archived}
              onDownload={downloadRow}
              busy={searching}
              busyText="搜索中…"
              jumpKey={`search:${searchedQuery}`}
              collect={{ conn, streamId: null }}
              emptyText="没有找到歌曲。"
            />
          ) : (
            <ScrollArea ref={gridScrollRef} className="h-full p-4 pb-24 scrollbar-mac">
              {/* 分区一:我自己攒的播单——恒渲染(至少有「我喜欢的歌曲」)，且排在最前：
                  它是这一页里唯一「自己攒的」东西，订阅来的歌单/播客随采集增长，把它压在下面
                  就得先滚过一屏别人的东西才找得到自己的。 */}
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[13px] font-semibold text-muted-foreground">我的播单</span>
                {creatingPlaylist ? (
                  <Input
                    autoFocus
                    className="h-6 w-40 text-[12px]"
                    placeholder="播单名,回车创建"
                    value={newPlaylistLabel}
                    onChange={(e) => setNewPlaylistLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void createGlobalPlaylist(); if (e.key === 'Escape') { setCreatingPlaylist(false); setNewPlaylistLabel('') } }}
                    onBlur={() => { setCreatingPlaylist(false); setNewPlaylistLabel('') }}
                  />
                ) : (
                  <button
                    onClick={() => setCreatingPlaylist(true)}
                    className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                  >+ 新建播单</button>
                )}
              </div>
              <div data-testid="music-liked-grid" className={MUSIC_COVER_GRID_CLASS}>
                {/* 我喜欢的歌曲:从分区一原样搬来的那张卡 */}
                <div className={MUSIC_COVER_ITEM_CLASS}>
                <MediaCard
                  onOpen={() => navigate({ kind: 'liked' })}
                  ariaLabel="我喜欢的歌曲"
                  src={likedTracks[0]?.poster ? imgUrl(conn.baseUrl, likedTracks[0].poster) : undefined}
                  ratio="1 / 1"
                  fallback={<Heart className="size-10 fill-primary text-primary" />}
                  caption="overlay"
                  title="我喜欢的歌曲"
                >
                  {/* The track count moves INTO the badge. Every other tile's badge is its source
                      label, which the description used to repeat verbatim — so the description is
                      gone channel-wide (see the grid below) and this tile's one piece of real
                      extra information rides the badge instead of being lost with it. */}
                  <MediaBadge className="right-1.5 top-1.5 tabular-nums">{likedTracks.length} 首</MediaBadge>
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/25 group-hover:opacity-100">
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate({ kind: 'liked' }); if (likedAudioTracks.length) stage.playQueue(likedAudioTracks, 0, 'music') }}
                      aria-label="播放"
                      className="pointer-events-auto flex size-14 items-center justify-center rounded-full border border-white/40 bg-white/20 text-white shadow-xl backdrop-blur-md transition-transform duration-200 hover:scale-110 hover:bg-white/30"
                    >
                      <Play className="size-6 translate-x-0.5 fill-current" />
                    </button>
                  </div>
                </MediaCard>
                </div>
                {myPlaylistCards(audioCollections, streamLabelById).map((card) => {
                  const coll = audioCollections.find((c) => c.id === card.id)!
                  return (
                    <ContextMenu key={card.id}>
                      <ContextMenuTrigger asChild>
                        <div className={MUSIC_COVER_ITEM_CLASS}>
                          <MediaCard
                            onOpen={() => navigate({ kind: 'collection', id: card.id })}
                            ariaLabel={card.label}
                            ratio="1 / 1"
                            fallback={<ListMusic className="size-9" />}
                            caption="overlay"
                            title={card.label}
                            subtitle={card.subtitle}
                          >
                            <MediaBadge className="right-1.5 top-1.5 tabular-nums">{card.itemCount} 首</MediaBadge>
                          </MediaCard>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent size="sm" className="w-32">
                        <ContextMenuItem onSelect={() => { setRenaming(coll); setRenameLabel(coll.label) }}><Pencil /><span>重命名</span></ContextMenuItem>
                        <ContextMenuItem variant="destructive" onSelect={() => setDeleting(coll)}><Trash2 /><span>删除播单</span></ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  )
                })}
              </div>
              {/* 分区二/三:订阅来的源,按 audioStreamKind 分成歌单和播客两栏。两类的卡片形状
                  完全一样(点开都是 L2 曲目表),分区只是给眼睛降噪——所以共用同一个渲染函数,
                  只有占位图标不同。空的那一类整栏不渲染,不留空标题。 */}
              {uniqueStreams.length === 0 ? (
                /* channels have loaded (the grid layer only renders past the loading spinner) but the
                 * audio channel holds no subscribed sources — the genuine empty-state, distinct from "loading". */
                <>
                  <div className="mt-6 mb-1.5 text-[13px] font-semibold text-muted-foreground">歌单 / 播客</div>
                  <div className="px-1 py-3 text-[13px] text-muted-foreground">
                    还没有歌单。去「添加来源」把音乐/电台源加为歌单。
                  </div>
                </>
              ) : (
                <>
                  {([
                    { key: 'music', label: '歌单', list: gridSections.playlists, icon: <ListMusic className="size-9" /> },
                    { key: 'podcast', label: '播客', list: gridSections.podcasts, icon: <Podcast className="size-9" /> },
                  ] as const).filter((sec) => sec.list.length > 0).map((sec) => (
                    <div key={sec.key}>
                      <div className="mt-6 mb-1.5 text-[13px] font-semibold text-muted-foreground">{sec.label}</div>
                      <div className={MUSIC_COVER_GRID_CLASS}>
                        {sec.list.map((s) => {
                          const badge = sourceLabel(s)
                          return (
                            <SubscriptionContextMenu key={s.id} id={s.id} label={s.description || s.id}>
                            <div className={MUSIC_COVER_ITEM_CLASS}>
                            <MediaCard
                              onOpen={() => navigate({ kind: 'playlist', id: s.id })}
                              ariaLabel={s.description || s.id}
                              src={s.image ? imgUrl(conn.baseUrl, s.image) : undefined}
                              ratio="1 / 1"
                              fallback={sec.icon}
                              caption="overlay"
                              title={s.description || s.id}
                            >
                              {/* No description: it was `badge` verbatim, i.e. the same source label the
                                  badge already shows one corner away. */}
                              {badge && (
                                <MediaBadge className="right-1.5 top-1.5">{badge}</MediaBadge>
                              )}
                              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/25 group-hover:opacity-100">
                                <button
                                  onClick={(e) => { e.stopPropagation(); navigate({ kind: 'playlist', id: s.id }); setAutoplay(true) }}
                                  aria-label="播放"
                                  className="pointer-events-auto flex size-14 items-center justify-center rounded-full border border-white/40 bg-white/20 text-white shadow-xl backdrop-blur-md transition-transform duration-200 hover:scale-110 hover:bg-white/30"
                                >
                                  <Play className="size-6 translate-x-0.5 fill-current" />
                                </button>
                              </div>
                            </MediaCard>
                            </div>
                            </SubscriptionContextMenu>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </>
              )}

            </ScrollArea>
          )}
        </div>
        )}
        </>
      )}

      {layer === 'track-list' && selectMode && selectedIds.size > 0 && (
        <SelectionBar conn={conn} count={selectedIds.size} anchorStreamId={!isLikedPlaylist && sel ? sel : null}
          onPick={(id) => void addSelectedTo(id)}
          onDownload={() => downloadSelected()}
          onCancel={() => { setSelectMode(false); setSelectedIds(new Set()) }} />
      )}

      {/* 重命名/删除播单——L1「我的播单」卡片和 L2 chips 共用同一套确认框(hoisted 到 layer 判断外)。 */}
      <CollectionManageDialogs
        renaming={renaming}
        deleting={deleting}
        renameLabel={renameLabel}
        onRenameLabelChange={setRenameLabel}
        onCloseRename={() => setRenaming(null)}
        onCloseDelete={() => setDeleting(null)}
        onConfirmRename={() => void confirmRenamePlaylist()}
        onConfirmDelete={() => void confirmDeletePlaylist()}
        renameSaving={renameSaving}
        deleteSaving={deleteSaving}
        renameTitle="重命名播单"
        renameDesc="修改这个子列表的显示名称。"
        nameLabel="播单名称"
        deleteTitle="删除播单"
        deleteBody={(label) => `将删除「${label}」这个子列表；其中的分集/曲目仍留在原 stream 里，不会被删除。此操作不可撤销。`}
      />

      {/* 常驻的播放条。**配置页不画**：它是 `fixed` 定位的，贴的是整个页面的底边而不是这块
          内容区（见 PanelMusicChannel 头注），在一屏配置表单上浮着一条播放器只是遮挡——
          那一页跟"正在播什么"没有任何关系。切回内容页它就回来，播放本身不受影响。 */}
      {tab === 'config' ? null : <NowPlayingBar conn={conn} />}

    </div>
  )
}
