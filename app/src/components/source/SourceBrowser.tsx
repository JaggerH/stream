import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  Loader2Icon,
  Settings2Icon,
} from 'lucide-react'
import { api } from '../../lib/api.ts'
import type { Connection } from '../../lib/api.ts'
import type {
  PickSurface,
  PluginSourceListResponse,
  PluginSummary,
  SourceSummary,
} from '../../lib/types.ts'
import { facilityDocsUrl, facilityHomepageUrl, pluginCapabilityLabel, sourceDomId } from '../../lib/source.ts'
import { StreamSourceIcon } from '../StreamSourceIcon.tsx'
import { SourceItem } from '../SourceItem.tsx'
import { Badge } from '../acrylic/badge.tsx'
import { Button } from '../acrylic/button.tsx'
import { SourceCommandPalette } from './SourceCommandPalette.tsx'
import { Searchbar } from '../acrylic/searchbar.tsx'
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMeta,
  ItemMedia,
  ItemRow,
  ItemSeparator,
  ItemTitle,
} from '../acrylic/item.tsx'
import {
  ShellContent,
  ShellNavbar,
  ShellNavbarActions,
  ShellPanel,
  ShellPanelActions,
  ShellPanelDescription,
  ShellPanelHeader,
  ShellPanelTitle,
} from '../acrylic/shell.tsx'

/** 一张 macOS inset 列表卡：行装在里面，行间只有 hairline，圆角由容器裁。
 *  长列表不给每行单独描边/frosted —— 那是把几百个等重的方块摞起来，扫不动；而且半透明面叠
 *  半透明面本来就是 acrylic 明令禁止的。 */
const INSET_LIST =
  'overflow-hidden rounded-[10px] bg-[var(--acr-card-nested)] [&>*+*]:border-t [&>*+*]:border-[var(--acr-border-soft)]'
/** 行本身：透明、方角（圆角归容器裁），hover 才有填充。 */
const INSET_ROW = 'rounded-none hover:bg-[var(--acr-hover)]'
/** 一屏一屏地放行——DOM 里一次挂 500 行是实打实的开销，且没人一次读得完。 */
const PAGE = 120

/** Pure Source discovery: plugin list + group/source browse + cross-plugin search.
 *  Emits the picked SourceSummary; the parent fetches detail and opens the config Sheet.
 *
 *  信息架构（2026-07-22 改）：
 *   - **搜索优先**。页内搜索框从 navbar 角落的 h-8/w-56 次要控件提到主位；跨插件搜索不再是一个
 *     「本插件 / 全部插件」模式开关，而是 ⌘K 唤起的 SourceCommandPalette。两个作用域 = 两个入口，
 *     不是一个「得先想明白自己在哪一档」的开关。
 *   - **一种行语言**。分组以前是 4 列 78px 卡片栅格、源是行，两级视觉断裂；现在两级都是 inset
 *     列表行 + 面包屑回退（Finder 列视图的心智）。卡片栅格只有 label + count 两个字段，撑不起
 *     它的视觉成本。
 *   - **密度分层**。源行降到 size="sm"，靠 sticky 段头给节奏，而不是让几百行等重地铺开。 */
/**
 * `surface` = 打开这个选择器**是为了干什么**（见 `PickSurface`）。它被送到后端做过滤，
 * 所以每个入口都必须说出自己是哪个面：不说 = 两个面的并集，会让"给频道加来源"里混进只该当
 * Provider 成员的搜索腿。
 */
export function SourceBrowser({ conn, onPick, surface, onOpenPackage }: {
  conn: Connection
  onPick: (s: SourceSummary) => void
  surface?: PickSurface
  /** 「这是什么包」的落点。**不传就不画那颗键**——以前它写地址栏跳「包」页，那在老版 UI 里
   *  成立；工作台里 URL 归 DSH，而且从频道配置页的「添加来源」弹出来时也没有"包页"可跳。 */
  onOpenPackage?: (pluginId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(true)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 只活在内存里：这棵树跑在工作台里（频道配置页的「添加来源」就是它），地址栏归 DSH，
  // 谁往里写谁就劫持了宿主路由（刷新落到 DSH 的 404）。
  const [plugin, setPlugin] = useState<string | null>(null)
  const [sourceList, setSourceList] = useState<PluginSourceListResponse | null>(null)
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [group, setGroup] = useState<string | null>(null)

  const activePlugin = useMemo<PluginSummary | null>(() => {
    if (!plugins.length) return null
    return plugins.find((p) => p.id === plugin) ?? plugins[0]
  }, [plugin, plugins])
  const pluginRoutes = sourceList?.sources ?? []
  const sourceGrouping = sourceList?.plugin.sourceGrouping
  // rsshub 的分组键就是 namespace/facility——才有「站点跳转」和「RSSHub 路由说明」可给。
  const isFacilityGroup = sourceGrouping?.resolver === 'adapter.groupByNamespace'
  const sourceGroups = sourceList?.groups ?? []
  const activeGroup = group === null ? null : sourceGroups.find((f) => f.key === group) ?? { key: group, label: group, count: sourceList?.total ?? pluginRoutes.length }
  const activeGroupSourceCount = sourceList?.total ?? activeGroup?.count ?? pluginRoutes.length
  const showGroups = !!sourceGrouping?.enabled && group === null && sourceGroups.length > 0
  const pluginCategories = sourceList?.facets.categories.length ? sourceList.facets.categories : activePlugin?.topCategories ?? []

  useEffect(() => {
    let alive = true
    setPluginsLoading(true)
    api.plugins(conn).then((result) => {
      if (!alive) return
      setPlugins(result)
      setPlugin((cur) => (cur && !result.some((p) => p.id === cur) ? null : cur))
    }).catch(() => {}).finally(() => {
      if (alive) setPluginsLoading(false)
    })
    return () => { alive = false }
  }, [])
  // mirror the selected plugin into the URL (/plugins/<id>) so a refresh restores it

  useEffect(() => {
    if (!activePlugin) return
    let alive = true
    const limit = query.trim() ? 60 : group !== null ? 500 : 200
    setSourcesLoading(true)
    api.pluginSources(conn, activePlugin.id, { query, limit, group: group ?? undefined, surface }).then((result) => {
      if (!alive) return
      setSourceList(result)
    }).catch(() => {}).finally(() => {
      if (alive) setSourcesLoading(false)
    })
    return () => { alive = false }
  }, [activePlugin?.id, query, group, surface])

  // ⌘K = 跨插件搜索。⌘B 已经归 sidebar，⌘K 是空的。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function openPlugin(ns: string) {
    setPlugin(ns)
    setQuery('')
    setGroup(null)
  }

  function renderSourceRow(source: SourceSummary) {
    return (
      <SourceItem
        key={source.id}
        htmlId={sourceDomId(source)}
        source={source}
        size="sm"
        variant="default"
        className={INSET_ROW}
        onClick={() => onPick(source)}
        actions={
          <>
            {source.badges?.includes('needs_config') ? <Badge variant="secondary" size="sm" className="text-amber-500/90">需配置</Badge> : null}
            {source.badges?.includes('nsfw') ? <Badge variant="secondary" size="sm" className="text-pink-500/90">NSFW</Badge> : null}
            <ChevronRightIcon className="size-4 text-muted-foreground" />
          </>
        }
      />
    )
  }

  return (
    <>
      <ShellPanel variant="list" className="w-[22rem]">
        <ShellPanelHeader className="h-[49px] px-3">
          <ShellPanelTitle>我的插件</ShellPanelTitle>
          <ShellPanelActions>
            <ShellPanelDescription>{plugins.length} plugins</ShellPanelDescription>
          </ShellPanelActions>
        </ShellPanelHeader>
        <ShellContent padding="flush" className="scrollbar-mac relative">
          <section aria-label="我的插件">
            <div data-slot="source-plugin-list">
              {plugins.map((p, index) => {
                const active = activePlugin?.id === p.id
                const nextPlugin = plugins[index + 1]
                const showSeparator =
                  nextPlugin && !active && activePlugin?.id !== nextPlugin.id
                return (
                  <Fragment key={p.id}>
                    <Item
                      asChild
                      size="xs"
                      selected={active}
                      className={[
                        'w-full cursor-pointer rounded-none transition-colors',
                        active ? 'hover:bg-primary' : 'hover:bg-[var(--acr-card-nested)]',
                      ].join(' ')}
                    >
                      <button type="button" onClick={() => openPlugin(p.id)} className={`w-full items-start px-3 py-2 ${p.enabled === false ? 'opacity-55' : ''}`}>
                        <ItemContent className="flex min-w-0 flex-col">
                          <ItemRow className="h-4 items-center gap-1.5">
                            <ItemTitle className="min-w-0 flex-1 text-[13px] font-semibold leading-4">
                              {p.name}
                            </ItemTitle>
                            {/* 停用是**只读信号**：开关在「包」页。留着它是因为一个停用的包，
                                它的源不会被注册——不说的话用户会以为自己配的源坏了。 */}
                            {p.enabled === false ? (
                              <Badge variant="secondary" size="sm" className="text-muted-foreground">已停用</Badge>
                            ) : null}
                            <ItemMeta className="text-[11px] leading-4">
                              {p.sourceCount} sources
                            </ItemMeta>
                          </ItemRow>
                          <ItemDescription className="mt-1 text-[11px] leading-[13px]">
                            {p.tagline || p.description || (p.capabilities.length ? p.capabilities.join(' / ') : '暂无 sources')}
                          </ItemDescription>
                          {p.description && p.description !== p.tagline ? (
                            <ItemDescription className="mt-1 text-[11px] leading-[13px]">
                              {p.description}
                            </ItemDescription>
                          ) : null}
                        </ItemContent>
                      </button>
                    </Item>
                    {showSeparator ? <ItemSeparator /> : null}
                  </Fragment>
                )
              })}
              {!pluginsLoading && plugins.length === 0 ? (
                <Item variant="muted" className="m-3">
                  <ItemContent>
                    <ItemTitle>暂无插件</ItemTitle>
                    <ItemDescription>当前没有可用的信息源插件。</ItemDescription>
                  </ItemContent>
                </Item>
              ) : null}
            </div>
          </section>
          {pluginsLoading ? (
            <div
              data-slot="source-plugin-loading-overlay"
              className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--acr-panel)]/70 backdrop-blur-sm"
            >
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </ShellContent>
      </ShellPanel>

      <ShellPanel variant="detail" data-nested-surface="true">
        <ShellNavbar className="h-[49px] gap-2 px-2">
          {/* 返回 + 面包屑：两级导航（插件 → 分组）就地回答「我在哪、怎么出去」。 */}
          {group !== null ? (
            <button
              type="button"
              data-slot="source-back-slot"
              aria-label="返回上一级"
              onClick={() => setGroup(null)}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <ChevronLeftIcon className="size-5" />
            </button>
          ) : (
            <span data-slot="source-back-slot" aria-hidden="true" className="size-8 shrink-0" />
          )}
          <nav aria-label="位置" className="flex min-w-0 shrink items-center gap-1 text-[12px] text-muted-foreground">
            <span className="truncate">{activePlugin?.name ?? ''}</span>
            {activeGroup ? (
              <>
                <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
                <span className="truncate text-foreground">{activeGroup.label}</span>
              </>
            ) : null}
          </nav>
          <ShellNavbarActions className="min-w-0 flex-1">
            {/* 搜索是这一页的主路径（源可以有几百上千个），所以它占满可用宽度而不是缩在角落。
                组件是 acrylic Searchbar（全站唯一的搜索框形态，size="large" 是 49px 顶栏里的
                那一档）；⌘K 走它内建的 `shortcut` 槽，不再自己搭一个键帽。那个键帽仍然可点
                （kbd 是 pointer-events-none，所以按钮自己把 pointer-events 收回来），但
                `tabIndex={-1}`——它挂在 aria-hidden 的 kbd 里，可聚焦元素不许待在那儿；
                键盘用户走的是本页全局绑的 ⌘K。 */}
            <Searchbar
              data-slot="source-discovery-search"
              size="large"
              className="w-full min-w-0 max-w-[26rem]"
              value={query}
              onChange={(event) => {
                const val = event.target.value
                setQuery(val)
                if (val.trim()) setGroup(null)
              }}
              onClear={() => setQuery('')}
              placeholder={activePlugin ? `搜索 ${activePlugin.name} 的源` : '搜索源'}
              aria-label={activePlugin ? `搜索 ${activePlugin.name} 的源` : '搜索源'}
              shortcut={
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setPaletteOpen(true)}
                  title="搜索全部插件的源"
                  // 负外边距把点击区撑回整个键帽（否则可点的只有 16×15 的那两个字符）。
                  className="pointer-events-auto -mx-1.5 -my-0.5 px-1.5 py-0.5 font-mono transition-colors hover:text-foreground"
                >
                  ⌘K
                </button>
              }
            />
          </ShellNavbarActions>
        </ShellNavbar>
        <ShellContent padding="flush" className="scrollbar-mac relative px-3 py-3">
          <section aria-label="插件源详情" className="min-h-full">
            <div>
              {activePlugin && group === null ? (
                <section aria-label="插件说明" className="mb-4 px-2">
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[15px] font-semibold leading-5">{activePlugin.name}</div>
                        {activePlugin.tagline ? (
                          <div className="mt-0.5 text-[12px] leading-4 text-muted-foreground">{activePlugin.tagline}</div>
                        ) : null}
                      </div>
                      {/* 这一页只管找源。开关、配置、容器状态全在「包」页——同一件事在两个地方
                          各写一份实现，迟早说法不一致。跳过去靠搜索预填，不新造一个选中态。 */}
                      {onOpenPackage === undefined ? null : (
                        <Button
                          variant="secondary"
                          size="small"
                          className="shrink-0"
                          onClick={() => { onOpenPackage(activePlugin.id) }}
                        >
                          <Settings2Icon />这是什么包
                        </Button>
                      )}
                    </div>
                    {activePlugin.enabled === false ? (
                      <div className="text-[11px] text-amber-500/90">
                        已停用：它的源不再注册。要重新打开它，去「包」页。
                      </div>
                    ) : null}
                    {activePlugin.description ? (
                      <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{activePlugin.description}</p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {activePlugin.capabilities.map((capability) => (
                        <Badge key={capability} variant="secondary" size="sm">
                          {pluginCapabilityLabel(capability)}
                        </Badge>
                      ))}
                    </div>
                    {pluginCategories.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {pluginCategories.slice(0, 8).map((category) => (
                          <span key={category.key} className="rounded-md bg-[var(--acr-chip)] px-2 py-1 text-[11px] text-muted-foreground">
                            {category.label} · {category.count}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}
              {/* 分组的标题/计数已经进了面包屑和 sticky 段头，这里只剩分组独有的外链。 */}
              {activeGroup && isFacilityGroup ? (
                <section aria-label="Source 分组说明" className="mb-3 flex flex-wrap items-center gap-3 px-2 text-[12px]">
                  {facilityHomepageUrl(activeGroup.key) ? (
                    <a
                      href={facilityHomepageUrl(activeGroup.key)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                    >
                      <ExternalLinkIcon className="size-3.5" />访问站点
                    </a>
                  ) : null}
                  <a
                    href={facilityDocsUrl(activeGroup.key)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    <BookOpenIcon className="size-3.5" />RSSHub 路由说明
                  </a>
                </section>
              ) : null}
              {showGroups ? (
                <SectionedList
                  ariaLabel="源分组"
                  heading={`${query.trim() ? '搜索结果' : '全部分组'} · ${sourceGroups.length}`}
                  count={sourceGroups.length}
                  renderRow={(i) => {
                    const f = sourceGroups[i]
                    return (
                      <Item key={f.key} asChild size="sm" className={`cursor-pointer ${INSET_ROW}`}>
                        <button type="button" onClick={() => setGroup(f.key)} className="w-full">
                          <ItemMedia variant="image" className="rounded-[6px] bg-[var(--acr-chip)]">
                            <StreamSourceIcon id={f.key || 'unclassified'} name={f.label} />
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle className="font-semibold">{f.label}</ItemTitle>
                          </ItemContent>
                          <ItemMeta>{f.count} 个源</ItemMeta>
                          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                        </button>
                      </Item>
                    )
                  }}
                />
              ) : (
                <SectionedList
                  ariaLabel="源列表"
                  heading={activeGroup ? `${activeGroup.label} · ${activeGroupSourceCount} 个源` : `${pluginRoutes.length} 个源`}
                  count={pluginRoutes.length}
                  empty={!sourcesLoading && pluginRoutes.length === 0 ? '没有匹配的源' : undefined}
                  renderRow={(i) => renderSourceRow(pluginRoutes[i])}
                />
              )}
            </div>
          </section>
          {sourcesLoading ? (
            <div
              data-slot="source-loading-overlay"
              className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--acr-panel)]/70 backdrop-blur-sm"
            >
              <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </ShellContent>
      </ShellPanel>
      {/* 同一个选择器的"跨插件搜"那一半——面必须跟左边列表一致，否则搜索框会把刚滤掉的端回来。 */}
      <SourceCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} conn={conn} onPick={onPick} surface={surface} />
    </>
  )
}

/**
 * 一段带 sticky 段头的 inset 列表，行按 PAGE 一屏一屏地放。
 *
 * sticky 段头是这一页的节奏来源：滚到哪儿都知道「这是什么、有多少」，同时承担 Apple 说的 scroll
 * edge effect —— 浮层与内容相接处用模糊过渡，而不是一条 1px 分割线。
 * 增量渲染用 IntersectionObserver 哨兵：500 行一次性进 DOM 是真实开销，而且没人一次读得完。
 */
function SectionedList({
  ariaLabel,
  heading,
  count,
  empty,
  renderRow,
}: {
  ariaLabel: string
  heading: string
  count: number
  empty?: string
  renderRow: (index: number) => ReactNode
}) {
  const [shown, setShown] = useState(PAGE)
  const sentinel = useRef<HTMLDivElement | null>(null)

  // 列表内容换了（换插件 / 换分组 / 改搜索词）就回到第一屏。
  useEffect(() => { setShown(PAGE) }, [heading, count])

  useEffect(() => {
    const node = sentinel.current
    if (!node || shown >= count) return
    if (typeof IntersectionObserver === 'undefined') { setShown(count); return } // jsdom 等无 IO 环境：直接全量
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(count, n + PAGE))
    }, { rootMargin: '400px' })
    io.observe(node)
    return () => io.disconnect()
  }, [shown, count])

  if (empty) {
    return (
      <section aria-label={ariaLabel} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
        {empty}
      </section>
    )
  }

  return (
    <section aria-label={ariaLabel} className="px-1">
      {/* scroll edge effect：不铺底色，只留一层向下渐隐的模糊。
          曾经写成 bg-[var(--acr-panel)]/80 —— 那是面板自己的底（dark 下 #1c1c1e 全不透明），
          浮在面板上再刷一遍就是一条实心灰带，acrylic 下则是半透明面叠半透明面。 */}
      <div className="sticky top-0 z-10 -mx-1 mb-1.5 px-3 py-1.5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
        />
        <span className="relative text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">{heading}</span>
      </div>
      <div className={INSET_LIST}>
        {Array.from({ length: Math.min(shown, count) }, (_, i) => renderRow(i))}
      </div>
      {shown < count ? <div ref={sentinel} aria-hidden="true" className="h-8" /> : null}
    </section>
  )
}
