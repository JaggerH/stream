// 贴文列表的唯一入口：一批 items + 一个 layout。App.tsx 里原本有两段一模一样的
// panelItems.map(...)（时间线一段、全局搜索一段），现在都收敛到这里——布局是这一层的事，
// 页面只管把 items 和 handler 递进来。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Item as StreamItem } from '../../lib/types.ts'
import type { PostLayout } from '../../lib/layoutPref.ts'
import type { OpenDetailOptions } from '../../lib/openDetail.ts'
import { assignColumns, cardMetrics, columnCountFor, TARGET_CARD_WIDTH, type MasonryState } from '../../lib/masonry.ts'
import { cn } from '../../lib/utils.ts'
import { foldFeed, foldedLabel, leadLabel, toggleExpanded } from '../../lib/storyFold.ts'
import { ItemGroup } from '../acrylic/item.tsx'
import { PostCard } from './PostCard.tsx'
import { PostItemRow } from './PostItemRow.tsx'

interface PostFeedProps {
  items: StreamItem[]
  layout: PostLayout
  /** 当前这批 items 属于哪个频道（App 里就是 layoutChannelId）。只用来判"这次 layout 变化
   *  是不是切频道带来的"——见下面 scrollTo 那个 effect 的守卫，不参与渲染。 */
  channelId: string
  onOpen: (item: StreamItem, opts?: OpenDetailOptions) => void
  onPlayAudio?: (item: StreamItem) => void
  className?: string
}

/** 容器实测宽 → 列数。jsdom / 首帧还没测出来时宽度是 0，columnCountFor 自己会把 0 也
 *  夹到 MIN_COLUMNS，不需要在这里再判一次 width>0。 */
function useColumnLayout(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // 只用 ResizeObserver 的回调喂 width，不再额外用 el.clientWidth 读一次首帧：
    // clientWidth 含 padding、entry.contentRect 不含，两条路径量的不是同一个盒子模型，
    // 一旦这个容器将来加了 padding 的 className，首帧和后续帧就会对不上。ResizeObserver
    // 在 observe() 之后本来就会同步触发一次初始回调，用它做唯一真相源即可。
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  const colCount = columnCountFor(width)
  // 列宽只用于估高，不用于布局（列宽真值由 flex-1 决定），所以粗算即可；也没有扣掉列间距
  // gap-3，这个误差对每一列都一样、系统性偏移，只影响列底参差几像素，可接受不修。
  const colWidth = width > 0 ? width / colCount : TARGET_CARD_WIDTH
  return { colCount, colWidth }
}

function useMasonry(items: StreamItem[], colCount: number, colWidth: number) {
  // prevRef 从没被显式清空过——它能一直保持"正确"，是因为这个 hook 只在 WaterfallFeed 里用，
  // 而 WaterfallFeed 在 layout 切回 list 时会整体卸载：组件卸载=这份 ref 连同它所在的 fiber
  // 一起消失，下次切回 waterfall 是全新的 useRef(null)。这件事不明显但是承重的——谁把这个
  // hook 挪到外层常驻组件里、让它跨 list/waterfall 切换存活，这条"隐式重置"就没了，prevRef
  // 会带着上一轮 waterfall 的列状态污染下一轮。
  const prevRef = useRef<MasonryState | null>(null)
  return useMemo(() => {
    const state = assignColumns(items.map(cardMetrics), colCount, colWidth, prevRef.current ?? undefined)
    // 在 useMemo 里写 ref：StrictMode 的双跑是幂等的——第二遍看到 items 仍是上一次的
    // 完整前缀，增量段为空，返回同一份结果。
    prevRef.current = state
    return state
  }, [items, colCount, colWidth])
}

/**
 * 「另有 N 条同源」那一枚。**收起来的数目必须摆在明面上**——一行只写标题、不说还藏着几条，
 * 用户看到的就是内容凭空少了。点它就地展开，再点收起。
 */
function SameStoryToggle({
  n, expanded, lead, onToggle,
}: { n: number; expanded: boolean; lead: string | null; onToggle: () => void }) {
  return (
    <div className="flex w-full items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
      <button
        type="button"
        data-slot="same-story-toggle"
        onClick={onToggle}
        className="flex items-center gap-1 text-left hover:text-foreground"
      >
        <span aria-hidden>{expanded ? '▾' : '▸'}</span>
        {foldedLabel(n, expanded)}
      </button>
      {/* 「谁先发」——这是同一条内容出现在多个源里之后，来源唯一还剩的用处。 */}
      {lead && <span data-slot="same-story-lead" className="text-[11px] opacity-70">{lead}</span>}
    </div>
  )
}

export function PostFeed({
  items, layout, channelId, onOpen, onPlayAudio, className,
}: PostFeedProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  // 同质内容归堆：同一件事只占一行，其余收起来。展开状态是纯 UI 的（不落盘）——
  // 它是"我现在想多看两眼"，不是一个需要记住的决定。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const { rendered, hidden, membersOf } = useMemo(() => foldFeed(items, expanded), [items, expanded])
  const toggle = (groupId: string) => setExpanded((prev) => toggleExpanded(prev, groupId))
  // 记的是"上一次生效的 (layout, channelId)"而不是一个"是否首次运行"的布尔位——原因见下面
  // effect 里的比较：值比较天然对 React StrictMode 的挂载双跑幂等（两次调用看到的值相同，
  // 比较结果一样，不会像"翻转一次布尔位"那样被双跑戳穿）。
  const prevRef = useRef({ layout, channelId })

  // 切换布局把滚动容器拉回顶部：两种布局的滚动位置没有任何对应关系，硬映射只会落在一个
  // 随机位置——那比回到顶部更让人迷路。
  //
  // 但有两种情况必须跳过，它们是同一个碰撞的两副面孔：这个组件挂载在的 DOM 节点，正是
  // App.tsx 用 listScrollRef 记忆滚动位置的那个节点（closest('[data-slot="shell-content"]')
  // 找到的就是它），App.tsx 在 useLayoutEffect(deps: [listKey]) 里用 el.scrollTop = 记住的值
  // 恢复位置。被动 effect（这里的 useEffect）排在 layout effect 之后执行，同一次 commit 里
  // 两边都触发时，后跑的这一下必然赢：
  //   1. **挂载**：App 刚恢复完位置，这里立刻 scrollTo({top:0}) 把它冲掉；
  //   2. **切频道**：布局是按频道存的（见 lib/layoutPref.ts），两个频道存的布局不同时，
  //      listKey 变 → App 恢复位置，而同一次 commit 里 layout 也从 list 变成了 waterfall，
  //      于是这里又把它冲掉。「hn 存瀑布流、时间线是列表」来回切，两个方向的滚动记忆全丢。
  // 所以守卫必须同时覆盖这两个：只有**频道没变、纯粹是用户按了布局开关**时才拉回顶部。
  // 频道变了的那一次，滚动位置的归属权在 App 的按频道记忆里，不在这里。
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { layout, channelId }
    if (prev.layout === layout) return
    if (prev.channelId !== channelId) return
    const scroller = rootRef.current?.closest('[data-slot="shell-content"]') as HTMLElement | null
    scroller?.scrollTo?.({ top: 0 })
  }, [layout, channelId])

  if (layout === 'list') {
    // 列表行没有动作条：这条内容的动作（转成文字 / 打开原文 / 下载）全在行的**右键菜单**里
    // （PostItemRow 自己包 ItemContextMenu，不经这里），所以行处理器里没有它们那几格。
    const rowHandlers = { onOpen, onPlayAudio }
    return (
      <div ref={rootRef} className={className}>
        <ItemGroup className="w-full gap-0">
          {rendered.map((item, index) => {
            const groupId = item.storyGroup?.isRep ? item.storyGroup.id : undefined
            const n = groupId ? hidden.get(groupId) ?? 0 : 0
            return (
              <div key={item.id} className="w-full">
                <PostItemRow item={item} last={index === rendered.length - 1 && n === 0} {...rowHandlers} />
                {groupId && (n > 0 || expanded.has(groupId)) && (
                  <SameStoryToggle
                    n={n}
                    expanded={expanded.has(groupId)}
                    lead={leadLabel(item, membersOf.get(groupId) ?? [])}
                    onToggle={() => toggle(groupId)}
                  />
                )}
              </div>
            )
          })}
        </ItemGroup>
      </div>
    )
  }

  // 卡片没有常驻动作条，行那一套动作在网格里没有入口——所以只往下传这两个 handler。
  return (
    <WaterfallFeed
      rootRef={rootRef}
      items={rendered}
      hidden={hidden}
      membersOf={membersOf}
      expanded={expanded}
      onToggleGroup={toggle}
      handlers={{ onOpen, onPlayAudio }}
      className={className}
    />
  )
}

function WaterfallFeed({
  rootRef, items, hidden, membersOf, expanded, onToggleGroup, handlers, className,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>
  items: StreamItem[]
  hidden: Map<string, number>
  membersOf: Map<string, StreamItem[]>
  expanded: ReadonlySet<string>
  onToggleGroup: (groupId: string) => void
  handlers: Pick<PostFeedProps, 'onOpen' | 'onPlayAudio'>
  className?: string
}) {
  const { colCount, colWidth } = useColumnLayout(rootRef)
  const { columns } = useMasonry(items, colCount, colWidth)
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])

  return (
    <div ref={rootRef} data-slot="post-feed-masonry" className={cn('flex w-full items-start gap-3', className)}>
      {columns.map((ids, col) => (
        <div key={col} data-slot="post-feed-column" className="flex min-w-0 flex-1 flex-col gap-3">
          {ids.map((id) => {
            const item = byId.get(id)
            if (!item) return null
            const groupId = item.storyGroup?.isRep ? item.storyGroup.id : undefined
            const n = groupId ? hidden.get(groupId) ?? 0 : 0
            return (
              <div key={id} className="flex flex-col">
                <PostCard item={item} {...handlers} />
                {groupId && (n > 0 || expanded.has(groupId)) && (
                  <SameStoryToggle
                    n={n}
                    expanded={expanded.has(groupId)}
                    lead={leadLabel(item, membersOf.get(groupId) ?? [])}
                    onToggle={() => onToggleGroup(groupId)}
                  />
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
