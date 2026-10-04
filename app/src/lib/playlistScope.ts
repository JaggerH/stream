// Music 频道 detail 内「播单子列表」的纯逻辑:行的收藏键、列表内过滤、scope 成员的解析计划、
// 播单成员 → 行 + 可播队列的构建。播放唯一真相 = live item(spec §3)。
import type { CollectedItem, Item } from './types.ts'
import type { CollectedItemKeyInput } from './api.ts'
import { audioResolveUrl, toTrack } from './audioTrack.ts'
import { imgUrl } from './imageUrl.ts'
import type { AudioTrack } from './audioStage.ts'

/** Returns `${platform}:${track_id}` from the first audio/link media that carries both,
 *  or null for items with no archive reference (DRM / no-ref). */
export function itemTrackKey(it: Item): string | null {
  for (const m of it.content?.media ?? []) {
    if ((m.kind === 'audio' || m.kind === 'link') && m.platform && m.track_id) {
      return `${m.platform}:${m.track_id}`
    }
  }
  return null
}

/** 一行的来源标记。只标**不寻常**的两类——绝大多数条目是源站直链的普通集，给它们也挂标签
 *  只会变成满屏噪声，"没有标签"本身就是"正常"的意思。`label` 是给人看的字，`kind` 决定配色。 */
export interface RowOrigin {
  label: string
  kind: 'netdisk' | 'paid'
}

/**
 * 判定行的来源标记：
 * - **网盘**：由网盘目录 source（alist-audio）采进来的条目。字面用**那个成员配的目录名**
 *   （怡乐播客配的是 `…/下架` → 标「下架」）——配哪个目录是流自己的事，写死「下架」的话
 *   换个目录标签就撒谎了。取不到目录名时回落成「网盘」。
 * - **付费**：源站自己说要钱（`content.paid`，见 normalize 的注入契约）。**不看能不能播**——
 *   网盘绑定补上音频之后它依然是付费集。
 * - 其余（免费直链集、平台 VIP 曲——后者已有独立 VIP 标）→ 不标。
 */
export function rowOrigin(item: Item | undefined, netdiskLabel?: (sourceId: string) => string | undefined): RowOrigin | undefined {
  if (!item) return undefined
  const sourceId = item.source_id ?? ''
  if (sourceId.startsWith('alist:')) return { label: netdiskLabel?.(sourceId) || '网盘', kind: 'netdisk' }
  if (item.content?.paid) return { label: '付费', kind: 'paid' }
  return undefined
}

/** 从流的成员表造一个「source id → 挂载目录名」的查表，供 rowOrigin 给网盘条目取字面。 */
export function netdiskLabeller(sources: { plugin_id?: string; source_template_id?: string; params?: Record<string, unknown> }[] | undefined) {
  const byId = new Map<string, string>()
  for (const s of sources ?? []) {
    const path = typeof s.params?.path === 'string' ? s.params.path : ''
    const dir = path.replace(/\/+$/, '').split('/').pop()
    if (s.plugin_id && s.source_template_id && dir) byId.set(`${s.plugin_id}:${s.source_template_id}`, dir)
  }
  return (sourceId: string) => byId.get(sourceId)
}

/** 三位零填充的正片集号。只认三位——两位号是子节目的独立编号体系（`玄关笔记 01–65` vs
 *  正片 `001–945`），按数值混排会撞号；这条判据与归档器同源。 */
const EPISODE_NO = /^(\d{3})[.．]/

export function episodeNo(title: string): number | null {
  const m = EPISODE_NO.exec(title.trim())
  return m ? Number(m[1]) : null
}

/**
 * 按集号重排一条编号归档流（电台/播客）。**只在带集号的行之间换位，不带集号的行原地不动**——
 * 它们保持原有位置，不会被冲到列表末尾（年度特辑、子节目这类无三位号的条目就属于此类）。
 *
 * 为什么需要：这种流的自然顺序是集号，不是时间。RSS 按时间倒序发，恰好等于集号倒序，所以
 * 看起来像时间轴；而网盘补进来的下架集**没有发布时间**（AList 只给文件名和大小），落库时
 * 取的是采集时刻，于是全堆在顶端。按集号排能让它们落回本来该在的那一行。
 *
 * 半数以上的条目带集号才生效——音乐歌单这类不受影响。降序（与现有"最新在上"一致）。
 */
export function sortByEpisodeNo<T>(items: T[], titleOf: (item: T) => string): T[] {
  const slots: number[] = []
  const numbered: { item: T; no: number }[] = []
  items.forEach((item, i) => {
    const no = episodeNo(titleOf(item))
    if (no !== null) {
      slots.push(i)
      numbered.push({ item, no })
    }
  })
  if (numbered.length * 2 <= items.length) return items
  numbered.sort((a, b) => b.no - a.no)
  const out = items.slice()
  slots.forEach((slot, k) => { out[slot] = numbered[k].item })
  return out
}

export interface TrackTableRow {
  id: string
  title: string
  author?: string
  album?: string
  poster?: string
  durationS?: number
  track?: AudioTrack
  playIndex: number
  vip?: boolean
  /** 来源/可播性标记，见 rowOrigin */
  origin?: RowOrigin
  trackKey?: string | null
  likeRef?: { platform: string; trackId: string }
  sourceUrl?: string
  muted?: boolean
  sourceItem?: Item
  // scope 行(chip 收窄)的 id 是合成的 `episode:<stream>:<itemId>`/track 键,不是原始 itemId——
  // rowCollectKey 不能从 row.id 重新拼收藏键,必须原样带真身份走(见 playlistScope.rowCollectKey)。
  collectKey?: CollectedItemKeyInput
}

/** 行的收藏键:优先用行自带的 collectKey(scope 行——row.id 是 `episode:<stream>:<itemId>` 这样
 *  的合成 key,不是原始 itemId,不能拿来重新拼 episode key,必须原样带真身份走);否则走老路:
 *  平台曲目走 track(和「我的喜欢」同一命名空间——同一首歌别造两个身份),无平台引用的分集走
 *  episode(itemId=row.id,这时 row.id 才真的是原始 itemId)。没有 stream 上下文的 episode 行
 *  (搜索结果里不存在)返回 null。 */
export function rowCollectKey(
  row: { id: string; likeRef?: { platform: string; trackId: string }; collectKey?: CollectedItemKeyInput },
  streamId: string | null,
): CollectedItemKeyInput | null {
  if (row.collectKey) return row.collectKey
  if (row.likeRef) return { kind: 'track', platform: row.likeRef.platform, trackId: row.likeRef.trackId }
  if (streamId) return { kind: 'episode', streamId, itemId: row.id }
  return null
}

/** detail 内搜索:title/author/album 包含匹配,大小写不敏感,空查询原样返回。纯前端——detail 已是完整历史。 */
export function filterRows<T extends { title: string; author?: string; album?: string }>(rows: T[], q: string): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((r) => [r.title, r.author, r.album].some((s) => s?.toLowerCase().includes(needle)))
}

/** 选中一个子列表后,成员分三路(spec §3):当前 stream 的分集直接在已加载 items 里找;
 *  跨 stream 的分集按 streamId 分组等补拉;track 成员不依赖 stream(经 resolve 播放)。 */
export function planScopeResolution(members: CollectedItem[], currentStreamId: string): {
  liveItemIds: string[]
  fetchStreams: Map<string, string[]>
  trackMembers: CollectedItem[]
} {
  const liveItemIds: string[] = []
  const fetchStreams = new Map<string, string[]>()
  const trackMembers: CollectedItem[] = []
  for (const m of members) {
    if (m.kind === 'track') { trackMembers.push(m); continue }
    if (m.kind !== 'episode' || !m.itemId || !m.streamId) continue // 防御:坏快照跳过
    if (m.streamId === currentStreamId) liveItemIds.push(m.itemId)
    else fetchStreams.set(m.streamId, [...(fetchStreams.get(m.streamId) ?? []), m.itemId])
  }
  return { liveItemIds, fetchStreams, trackMembers }
}

/** 播单成员 → 可渲染的行 + 可播队列。chips 收窄和播单详情两条路共用同一份——同一身份在两处
 *  各自推导正是上一轮 scope-key 损坏 bug 的成因(见 2026-07-24 podcast-episode-collections spec)。
 *  播放真相 = live item:快照只做展示兜底,取不到 live item 的成员灰置(muted)但保留行。 */
export function buildMemberRows(
  members: CollectedItem[],
  lookup: (itemId: string) => Item | undefined,
  baseUrl: string,
): { rows: TrackTableRow[]; tracks: AudioTrack[] } {
  const tracks: AudioTrack[] = []
  const rows = members.map((m): TrackTableRow => {
    if (m.kind === 'track') {
      const track: AudioTrack = { id: `scope:${m.platform}:${m.trackId}`, kind: 'music',
        url: audioResolveUrl(baseUrl, { platform: m.platform!, trackId: m.trackId! }),
        // AudioTrack.poster 是展示就绪的（见 audioStage.ts 上的契约）——收藏快照里的 m.poster
        // 是源站原始地址，在这里过一遍代理；同一行的 row.poster 保持原样（表格行自己在渲染时包）。
        title: m.title, author: m.artist, poster: m.poster ? imgUrl(baseUrl, m.poster) : undefined, durationS: m.durationS }
      return { id: track.id, title: m.title, author: m.artist, album: m.album, poster: m.poster,
        durationS: m.durationS, track, playIndex: tracks.push(track) - 1,
        trackKey: `${m.platform}:${m.trackId}`, likeRef: { platform: m.platform!, trackId: m.trackId! }, sourceUrl: m.sourceUrl,
        collectKey: { kind: 'track', platform: m.platform!, trackId: m.trackId! } }
    }
    const live = lookup(m.itemId!)
    const track = live ? toTrack(live, baseUrl) : null
    // row.id = m.key(合成串,给 React key/UI 用),真收藏身份单独放 collectKey——m.streamId 是这个
    // 成员自己的原 stream(可能跨 stream),rowCollectKey 绝不能从 row.id 或当前 sel 重新拼。
    return { id: m.key, title: m.title, author: m.artist, album: m.album,
      poster: track?.poster ?? m.poster, durationS: track?.durationS ?? m.durationS,
      track: track ?? undefined, playIndex: track ? tracks.push(track) - 1 : -1,
      trackKey: live ? itemTrackKey(live) : null, sourceUrl: m.sourceUrl, muted: !track, sourceItem: live,
      origin: rowOrigin(live),
      collectKey: { kind: 'episode', streamId: m.streamId!, itemId: m.itemId! } }
  })
  return { rows, tracks }
}

/** 深链到不存在的播单 id → 退回 L1(spec §6)的判定,从 effect 里抽出来便于单测(上一轮的 Critical
 *  race 就出在这条判断的写法上)。meta(整表 api.collections)和 members(单表 api.collectionItems)
 *  是两个独立、无序请求——`metaLoaded=false`(还没到,或请求失败)绝不能读成"确认不存在":网络
 *  错误不是播单不在的证据,必须停在原地,只有 meta 已成功解析且确实没找到时才退回。 */
export function shouldBounceCollection(a: {
  selCollection: string | null
  membersLoaded: boolean
  metaLoaded: boolean
  meta: unknown | null
}): boolean {
  return !!a.selCollection && a.membersLoaded && a.metaLoaded && a.meta === null
}

/** L1「我的播单」分区的卡片投影:自建播单(系统列表另有专卡),锚定的带出它锚在哪档节目。 */
export function myPlaylistCards(
  collections: Array<{ id: string; label: string; system?: string; anchorStreamId?: string; itemCount?: number }>,
  streamLabelById: Map<string, string>,
): Array<{ id: string; label: string; subtitle?: string; itemCount: number }> {
  return collections
    .filter((c) => !c.system)
    .map((c) => {
      const anchor = c.anchorStreamId ? streamLabelById.get(c.anchorStreamId) : undefined
      return { id: c.id, label: c.label, subtitle: anchor ? `来自「${anchor}」` : undefined, itemCount: c.itemCount ?? 0 }
    })
}

/**
 * 把 `from` 位置那一条挪到 `to` 位置，返回一份**新**名单（原数组不动——调用方还拿着它当乐观更新
 * 失败时的回滚底本）。`to` 是"松手之后它该站的那个位置"，所以往后拖时被越过的那些自然前移一格。
 *
 * 越界下标一律原样返回：拖拽事件在虚拟化/快速拖动下**确实会给出对不上的下标**，这时候什么都不做
 * 是唯一安全的结果——把名单改成第三种样子，用户既看不懂也没法撤销。
 */
export function moveInOrder<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  const out = list.slice()
  const [moved] = out.splice(from, 1)
  out.splice(to, 0, moved)
  return out
}
