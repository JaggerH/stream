/**
 * 「运维」那一份独立 IIFE bundle：`panel-manage.js` + `panel-manage.css`。
 *
 * 它装的是**不属于任何一个频道**的那堆事：包的安装/卸载/更新、插件启停、凭据、日志。
 * 频道自己的配置已经回到频道里了（各 Present 顶栏下的「配置」分页），剩下这些全局的没有
 * 归属，落点是 DSH 设置里的一个 Stream 分区（`settings.section` 插槽，注册在
 * dsh-plugin-stream-ui 那侧）。**两页**（分页条切换）：包与插件（`PackagesPage`）、源健康
 * （`SourceHealthList` / `SourceRepairPage`，spec 2026-09-12 §4）。
 *
 * **为什么是独立 bundle 而不是塞进主面板**：主 bundle 是**开页必载**的那一份，而这一页
 * 一次都用不到的人占绝大多数（装包、配凭据是偶发动作）。理由与影视/详情/研究那三份拆分
 * 完全相同，`React.lazy` 同样不行（IIFE 下动态 import 会静默内联回主文件，见
 * `panelBundleLoader.ts` 头注）。
 *
 * ## 独立 root 里必须自己备齐的几样
 *
 * 1. **后端地址**：`applyBackend`——这份 bundle 是另一个 JS 运行时，`lib/api.ts` 的 `LOCAL`
 *    在它里面是另一份。不 apply 就会落回 DSH 那一页的源，症状是整页读不到数据。
 * 2. **CSS**：`entry.css`（Tailwind v4 + acrylic tokens）。
 * 3. **明暗态**：`watchHostTheme`——同面板，跟着 DSH 的主题走，卸载时收回（它会往
 *    `document.body` 上挂类，那是宿主共享的一份状态）。
 * 4. **i18n**：`PackagesPage` 通篇 `useTranslation()`。不 import 那个副作用模块的话，
 *    整页显示的是原始 key。
 *
 * ## 这里**不要**再长出跳转
 *
 * `PackagesPage` 原本用 `navigateTo` 跳「组件页」/「源页」——那会写浏览器地址栏，而工作台里
 * 那条 URL 归 DSH（写它 = 劫持宿主路由，刷新落到 DSH 的 404）。两个落点现在都不存在了，
 * 那两条跳转也随之拆掉：不留一个点了没反应的键。
 *
 * ## 为什么没有频道页、也没有组件页
 *
 * **频道**的一切都有了自己的归属：建频道在侧栏；改名 / 换空间 / 订阅列表 / 能力槽位 / 删除
 * 在频道自己的「配置」分页；**导出为分享包**在频道标题菜单；**导入分享包**在这一页顶栏
 * （导入那一刻频道还不存在，没有哪张配置面能承载它）。
 *
 * **组件（Provider）的编辑面已下线**——它是给人看的东西里最不需要人看的那一类：25 个系统
 * 组件开机自动铺（`src/providers/seed.ts` 的 `ensureSystemRows`，只补缺不覆盖），日常唯一
 * 会做的动作「把一个源加进某个组件」有自己的入口（添加来源时选目的地 = 组件，见
 * `components/source/destination.ts` 的 `append-provider`）。这一页留下的是**只读那一段**：
 * 包与插件页底部的组件清单（有哪些、各挂了几个成员、哪些 parked）。
 *
 * 随之**没有 UI 入口**的是：建 / 删一个组件、`exclude`、`strategy`、callsite 绑定、匹配测试。
 * 它们仍然只是 `/api/providers` 上的普通读写，真需要就 curl，或者把它们做成 MCP 工具交给
 * 对话（今天 MCP 完全不碰 providers 表）。要把这一页整份要回来，git log 里有。
 */
import { StrictMode, useEffect, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../entry.css'
import '../i18n/index.ts'   // 副作用 import：设好 react-i18next 的全局默认实例
import { applyBackend } from '../lib/api.ts'
import { PackagesPage } from '../components/packages/PackagesPage.tsx'
import { PreviewModal } from '../components/PreviewModal.tsx'
import { PreviewContext, type PreviewTarget } from '../lib/previewStage.ts'
import { VideoStageProvider } from '../lib/videoStageProvider.tsx'
import { Toaster } from '../components/acrylic/sonner.tsx'
import { watchHostTheme } from './hostTheme.ts'
import { SourceHealthList } from '../components/source-health/SourceHealthList.tsx'
import { SourceRepairPage } from '../components/source-health/SourceRepairPage.tsx'
import type { ManageTarget } from './manage-bridge.ts'

let root: Root | undefined
let stopWatchingTheme: (() => void) | undefined

type View = { page: 'packages' } | { page: 'source-health'; sourceId?: string }

/** 宿主经 `show()` 切页时用的模块级信号（两棵树之间没有 props）。 */
let pushView: ((v: View) => void) | undefined
const toView = (t?: ManageTarget): View => (t?.view === 'source-health' ? { page: 'source-health', ...(t.sourceId ? { sourceId: t.sourceId } : {}) } : { page: 'packages' })

function ManageShell({ backend, initial }: { backend: string; initial?: ManageTarget }): ReactElement {
  // 「预览这条 Stream 的时间线效果」——弹窗要活在 VideoStageProvider 里面（预览里但凡有
  // 一条能播的视频，PostItemRow 就会调 useVideoStage()，在外面渲染直接抛、整页白）。
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  const [openVideoId, setOpenVideoId] = useState<string | null>(null)
  // 两页（包与插件 / 源健康），分页条回来了。
  const [view, setView] = useState<View>(() => toView(initial))
  useEffect(() => { pushView = setView; return () => { pushView = undefined } }, [])
  const tab = (page: View['page'], label: string): ReactElement => (
    <button
      type="button" role="tab" aria-selected={view.page === page}
      className={`px-3 py-1.5 text-[13px] ${view.page === page ? 'border-b-2 border-foreground font-semibold' : 'text-muted-foreground'}`}
      onClick={() => setView({ page })}
    >{label}</button>
  )
  return (
    <PreviewContext.Provider value={{ openPreview: setPreview }}>
    <VideoStageProvider baseUrl={backend} openId={openVideoId} onOpenIdChange={setOpenVideoId}>
    <div className="flex h-full min-h-0 flex-col text-foreground">
      <div role="tablist" className="flex gap-1 border-b px-2">{tab('packages', '包与插件')}{tab('source-health', '源健康')}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.page === 'packages' ? <PackagesPage apiBase={backend} />
          : view.sourceId ? <SourceRepairPage apiBase={backend} sourceId={view.sourceId} onBack={() => setView({ page: 'source-health' })} />
          : <SourceHealthList apiBase={backend} onOpen={(sourceId) => setView({ page: 'source-health', sourceId })} />}
      </div>
      {/* 这棵树自己的 toast 出口——它是独立 root，面板那一份的 Toaster 管不到它。 */}
      <Toaster />
      <PreviewModal target={preview} onClose={() => { setPreview(null) }} />
    </div>
    </VideoStageProvider>
    </PreviewContext.Provider>
  )
}

/**
 * 挂进宿主给的容器（DSH 设置里那个 Stream 分区自己 appendChild 的 div）。
 * @param el - 宿主容器。
 * @param opts.backend - Stream 后端的绝对地址。
 * @param opts.initial - 深链目标（独立正门开层时可能带着「打开到某个源」）。
 */
export function mount(el: HTMLElement, opts: { backend: string; initial?: ManageTarget }): void {
  applyBackend(opts.backend, opts.backend.replace(/^http/, 'ws'))
  stopWatchingTheme = watchHostTheme(el)
  root = createRoot(el)
  root.render(<StrictMode><ManageShell backend={opts.backend} initial={opts.initial} /></StrictMode>)
}

/** 已经挂着时切到某一页（独立正门：弹层开着又点了一条通知）。没挂着 = 空操作，宿主该走 mount。 */
export function show(target: ManageTarget): void {
  pushView?.(toView(target))
}

/** 卸载并交还容器（设置关掉时）。 */
export function unmount(): void {
  root?.unmount()
  root = undefined
  stopWatchingTheme?.()
  stopWatchingTheme = undefined
}
