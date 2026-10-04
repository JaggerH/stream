import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type Connection } from '../lib/api.ts'
import { useChannels } from '../lib/channels.tsx'
import { ADS_CHANNEL } from '../lib/items.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type Item, type Stream, type StatusInfo } from '../lib/types.ts'
import { useWs } from './useWs.ts'

/** A backend-unreachable failure (fetch rejects with TypeError, or ApiError status 0)
 *  vs a normal HTTP error — only the former should trip the connection state machine. */
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof ApiError && e.status === 0)
}

/** 一次「重新抓取」的账。`kind` 说明抓的是什么，调用方据此讲人话。
 *  - `channel`：扇出到频道成员流（`total` 条里 `failed` 条没成）
 *  - `stream`：单个流
 *  - `discover`：平台推荐（服务端自己重抓，没有逐流账）
 *  - `reload`：广告/搜索这类虚拟视图，没有上游可抓——只重读了一遍 */
export type HarvestSummary =
  | { kind: 'reload' }
  | { kind: 'channel' | 'stream'; fetched: number; written: number; failed: number; total: number }

/** Bucket key for the all-latest timeline (selected === null). */
const TIMELINE_KEY = '__timeline__'
/** Stable empty array so an un-fetched channel's `items` keeps a constant identity
 *  (no spurious re-render / memo bust downstream). */
const NO_ITEMS: Item[] = []

/** Loads streams/items/status for a connection and applies live WS deltas.
 *  `onConnectionError` fires when the primary load fails at the network level
 *  (backend unreachable) so the connection state machine can re-probe/re-align. */
export function useInbox(
  conn: Connection,
  initialSelected: string | null = null,
  onConnectionError?: () => void
) {
  const [streams, setStreams] = useState<Stream[]>([])
  // Items are bucketed BY CHANNEL, not a single shared list. A channel switch used to keep
  // the previous channel's items on screen until the new fetch resolved (stale panel: URL/nav
  // already moved, content hadn't). Keying by channel makes the panel ALWAYS show the selected
  // channel's own data: a cached channel shows instantly, an un-fetched one reads as empty →
  // its loading overlay is consistent. A late fetch writes the key it was issued for, so it can
  // never paint into a channel the user has since left.
  const [itemsByChannel, setItemsByChannel] = useState<Record<string, Item[]>>({})
  // new items that arrived over WS while the user is reading — buffered (NOT spliced into
  // the list), surfaced as a "jump to top" pill so the feed never shifts under the user.
  const [pending, setPending] = useState<Item[]>([])
  const [status, setStatus] = useState<StatusInfo | null>(null)
  // 频道名录（谁属于哪个频道）不在这里存——它是 ChannelsProvider 的那一份。这个 hook 只读它，
  // 用来把 WS 推来的条目分流到正确的视图。自持一份的年代，任何经 patchChannel 写进 Provider
  // 的改动这里都看不见，且每次挂载要多打一次 GET /api/channels。见 lib/channels.tsx。
  const { channels, reload: reloadChannels } = useChannels()
  const [selected, setSelected] = useState<string | null>(initialSelected) // null = All Latest
  const [error, setError] = useState<string | null>(null)
  const [loadingItems, setLoadingItems] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // 频道时间线的下一页游标，按频道 key 分桶（与 itemsByChannel 同构）：异步结果落回发起时
  // 的频道，切频道后由 loadItems 的整批替换连同游标一起重置。undefined = 到底/未加载。
  const [cursorByChannel, setCursorByChannel] = useState<Record<string, string | undefined>>({})
  // the selected channel's bucket. An un-fetched channel reads as empty (NO_ITEMS), so the
  // panel shows its loading overlay rather than another channel's stale rows.
  const channelKey = selected ?? TIMELINE_KEY
  const items = itemsByChannel[channelKey] ?? NO_ITEMS
  // Write a specific channel's bucket (never disturbs the others). Callers pass the key the
  // work was issued for, so an async result lands in its own channel even after a switch.
  const setChannelItems = useCallback(
    (key: string, next: Item[] | ((prev: Item[]) => Item[])) =>
      setItemsByChannel((prev) => ({
        ...prev,
        [key]: typeof next === 'function' ? (next as (p: Item[]) => Item[])(prev[key] ?? []) : next,
      })),
    [],
  )
  // current selection key + items, read inside the WS callback without re-subscribing per delta
  const keyRef = useRef(channelKey)
  keyRef.current = channelKey
  const itemsRef = useRef<Item[]>([])
  itemsRef.current = items
  // snapshot/collection stream ids — excluded from the all-latest timeline (and its pill).
  // `mode` is the AUTHORITATIVE read-model field (mirrors scheduler.modeOf()).
  const snapshotIds = useRef<Set<string>>(new Set())
  snapshotIds.current = new Set(streams.filter((s) => s.mode === 'collection').map((s) => s.id))
  // audio (歌单) stream ids — their items belong to the music view, never the timeline/pill.
  // Audio-ness is Channel membership (Stream carries no `kind` anymore) — any stream referenced
  // by an audio-variant channel.
  const audioIds = useRef<Set<string>>(new Set())
  audioIds.current = new Set(channels.filter((c) => c.present === 'audio').flatMap((c) => c.streams.map((s) => s.id)))
  const timelineIds = useRef<Set<string>>(new Set())
  timelineIds.current = new Set(
    channels.find((c) => c.id === DEFAULT_TIMELINE_CHANNEL_ID)?.streams.map((s) => s.id) ?? []
  )
  // custom (non-system) channel ids → their member stream ids. Selecting a custom channel
  // loads its aggregated feed (api.channelItems) and WS deltas are matched against this set.
  const channelStreams = useRef<Map<string, Set<string>>>(new Map())
  channelStreams.current = new Map(
    channels.filter((t) => !t.system).map((t) => [t.id, new Set(t.streams.map((s) => s.id))])
  )

  const onLoadError = useCallback((e: unknown) => {
    setError((e as Error).message)
    if (isNetworkError(e)) onConnectionError?.()
  }, [onConnectionError])

  /** 内容那一路：流 + 状态。名录不在此列——它归 ChannelsProvider。 */
  const loadCore = useCallback(async () => {
    const [s, st] = await Promise.all([api.streams(conn), api.status(conn)])
    setStreams(s)
    setStatus(st)
  }, [conn])

  /**
   * 整份重拉：内容 + 名录。频道增删改之后（`onChannelsChanged`）走这条——新建/删除频道不经
   * `patchChannel`，Provider 那份不会自己变，得显式让它重拉一次。
   */
  const reload = useCallback(async () => {
    try {
      await Promise.all([loadCore(), reloadChannels()])
      setError(null)
    } catch (e) {
      onLoadError(e)
    }
  }, [loadCore, reloadChannels, onLoadError])

  // `force` forces a Discovery server-side re-harvest (the refresh button); the plain
  // select path serves the SWR snapshot. Keep-last: we never clear `items` here, so
  // re-selecting Discovery shows the previous snapshot instantly until the fetch resolves.
  const loadItems = useCallback(
    async () => {
      // capture the key up front: the fetch is async, and the result must land in THIS
      // channel's bucket even if the user switches away before it resolves.
      const key = selected ?? TIMELINE_KEY
      setLoadingItems(true)
      try {
        let next: Item[]
        if (selected === null) {
          const r = await api.channelItems(conn, DEFAULT_TIMELINE_CHANNEL_ID, { limit: 200 })
          next = r.items
          setCursorByChannel((p) => ({ ...p, [key]: r.next_cursor }))
        } else if (channelStreams.current.has(selected)) {
          // a custom channel (Channel) — aggregate feed across its member streams
          const r = await api.channelItems(conn, selected, { limit: 200 })
          next = r.items
          setCursorByChannel((p) => ({ ...p, [key]: r.next_cursor }))
        } else {
          // Ads is a cross-stream virtual view — fetch everything, App filters to muted.
          const stream = selected !== ADS_CHANNEL ? selected : undefined
          next = await api.items(conn, { stream, limit: 200 })
        }
        setChannelItems(key, next)
        setPending([]) // a fresh load is the new baseline — drop any buffered deltas
        setError(null)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoadingItems(false)
      }
    },
    [conn, selected, channels, setChannelItems]
  )
  /** 采**一个**源。`harvestSelected` 在当前选中的是单条订阅（非频道）时走这条。 */
  const harvestStream = useCallback(
    async (streamId: string): Promise<HarvestSummary> => {
      try {
        const r = await api.refreshStream(conn, streamId)
        await loadItems() // 抓完再读一遍，新条目才会出现在列表里
        return { kind: 'stream', fetched: r.fetched, written: r.written, failed: 0, total: 1 }
      } catch (e) {
        setError((e as Error).message)
        throw e
      }
    },
    [conn, loadItems],
  )

  /** 采一个频道下挂的**每一个**源（扇出，可能几十秒）。浮层的「全部源」与一键重采都走这条。 */
  const harvestChannel = useCallback(
    async (channelId: string): Promise<HarvestSummary> => {
      try {
        const r = await api.refreshChannel(conn, channelId)
        await loadItems()
        return { kind: 'channel', fetched: r.fetched, written: r.written, failed: r.failed, total: r.streams.length }
      } catch (e) {
        setError((e as Error).message)
        throw e
      }
    },
    [conn, loadItems],
  )

  /**
   * 真的去抓一次——导航栏那颗一键重采的语义（重采「当前看的这块」）。
   *
   * 它自己不发请求，只**判粒度**再委托给上面两个：后端只有 channel / stream 两档，
   * 两份实现一定会漂移。
   *
   * **这件事以前和「重读」是同一个函数**，`force` 标志只有 Discovery 那一条分支在读，
   * Timeline / 自定义频道 / 单个流全都把它静默丢掉，于是按钮只是把数据库重读一遍：不联网、
   * 不出新内容，看起来什么都没发生。两个动作语义不同（一个花几百毫秒读本地，一个花几十秒
   * 打全部上游），合成一个函数就一定会有一边被忘掉，所以这里拆开。
   *
   * 返回一份账，调用方据此讲人话（「抓取 N 条，新增 M 条；K 条没成」）。
   */
  const harvestSelected = useCallback(async (): Promise<HarvestSummary> => {
    const isChannel = selected === null || channelStreams.current.has(selected)
    if (selected === ADS_CHANNEL) {
      await loadItems() // 虚拟视图，没有上游可抓——只重读
      return { kind: 'reload' }
    }
    if (isChannel) return harvestChannel(selected ?? DEFAULT_TIMELINE_CHANNEL_ID)
    return harvestStream(selected)
  }, [selected, loadItems, harvestChannel, harvestStream])


  // 频道时间线续页：滚到底且持有 next_cursor 时取下一批 append。best-effort——失败保留
  // 已有，用户再滚重试；复用 loadingMore 单飞。append 去重不重排，兼容滚动记忆。
  const loadMoreChannel = useCallback(async () => {
    const key = selected ?? TIMELINE_KEY
    const isChannel = selected === null || channelStreams.current.has(selected)
    const cursor = cursorByChannel[key]
    if (!isChannel || !cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await api.channelItems(conn, selected ?? DEFAULT_TIMELINE_CHANNEL_ID, { limit: 200, cursor })
      setChannelItems(key, (prev) => {
        const have = new Set(prev.map((i) => i.id))
        return [...prev, ...r.items.filter((m) => !have.has(m.id))]
      })
      setCursorByChannel((p) => ({ ...p, [key]: r.next_cursor })) // 尾页 undefined → 停止加载
    } catch {
      // 续页失败静默：保留当前批，用户可再次滚动重试
    } finally {
      setLoadingMore(false)
    }
  }, [conn, selected, cursorByChannel, loadingMore, setChannelItems])

  // splice the buffered new items to the top (the pill click); caller scrolls to top.
  // Reveal into whichever channel is active now (keyRef), matching where the pill is shown.
  const revealPending = useCallback(() => {
    setPending((p) => {
      if (p.length) setChannelItems(keyRef.current, (cur) => [...p, ...cur.filter((i) => !p.some((x) => x.id === i.id))])
      return []
    })
  }, [setChannelItems])

  // 挂载只拉内容。名录由 ChannelsProvider 自己的 effect 拉——这里再拉一次就是同一个
  // GET /api/channels 打两遍（自持副本年代的实际行为）。
  useEffect(() => {
    void loadCore().then(() => setError(null)).catch(onLoadError)
  }, [loadCore, onLoadError])
  useEffect(() => {
    void loadItems()
  }, [loadItems])

  useWs(
    api.wsUrl(conn),
    useCallback(
      (m) => {
        if (m.type !== 'item') return
        if (selected === null && !timelineIds.current.has(m.item.stream_id)) return
        if (selected && selected !== ADS_CHANNEL) {
          const memberStreams = channelStreams.current.get(selected)
          // custom channel: keep deltas from any member stream; otherwise match the stream id
          if (memberStreams ? !memberStreams.has(m.item.stream_id) : m.item.stream_id !== selected) return
        }
        // audio streams never join the timeline/all/ads views — only their own music channel
        if (audioIds.current.has(m.item.stream_id) && selected !== m.item.stream_id) return
        // a collection-mode stream never joins the timeline or ads view — only its own
        // channel shows it (and that's loaded via its own harvest, not the pill).
        if (snapshotIds.current.has(m.item.stream_id) && selected !== m.item.stream_id) return
        // already shown → update in place (no reorder, no jump); new → buffer for the pill
        if (itemsRef.current.some((i) => i.id === m.item.id)) {
          setChannelItems(keyRef.current, (prev) => prev.map((i) => (i.id === m.item.id ? m.item : i)))
        } else {
          setPending((prev) => (prev.some((p) => p.id === m.item.id) ? prev : [m.item, ...prev]))
        }
      },
      [selected, setChannelItems]
    )
  )

  return { streams, items, pending, revealPending, status, selected, setSelected, error, reload, harvestSelected, harvestStream, harvestChannel, loadingItems, loadMoreChannel, loadingMore }
}
