/**
 * 浏览器半边：把 Stream 的定制卡按 **wire 工具名**注册进 DSH 的 `tool.call.toolview` 槽。
 *
 * 注册契约照 `@deepseek-ai/dsh-client-ui-tool` 的 README 原文：业务包只注册 wire 工具名 +
 * 原子视图，不配对 session 事件、不重建 transcript、不管 root/subCall 拓扑。
 *
 * **generic 行不注册。** 回落是 DSH 自己的机制（未被认领的 key 走通用卡），我们在这里
 * 「注册一个转发给通用卡的组件」只会把它的能力换成更差的一份。
 */
// DSH 0.1.2 起客户端运行时按包切开，没有一个统一的 `ClientContext` 导出——它本来就只是
// cordis 的 `Context`（rc.6 那份是 `export type ClientContext = Context`）。服务那几格
// （sessions / workspaces / slots / theme / inputTriggers）各自由自己的包合并声明进来。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型 only：`ctx.sessions` / `ctx.workspaces` 的 Context 合并声明。
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// 类型 only：`ctx.uiWorkspace` 的 Context 合并声明（新会话 / 连上工作区两个动作）。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// 类型 only：`ctx.slots` 的 Context 合并声明（0.1.2 起由 ui-renderer 提供）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 类型 only：`ctx.theme` 的 Context 合并声明。
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// 类型 only：把 `sidebar.footer.action` 那条 SlotMap 合并拉进本程序，否则 register 的 key 不认识。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// 类型 only：把 `tool.call.toolview` 那条 SlotMap 合并拉进本程序，否则 register 的 key 不认识。
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// 类型 only：把 `main` / `rightbar` / `shell.overlay` 三条 SlotMap 合并拉进本程序——
// 下面 root 注册的 children 表就是按它们声明的，key 不认识就过不了编译。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// 类型 only：`conversation.chat.node`（用户消息那一格）的槽声明。
//
// **0.2.0 起这一格由 `dsh-client-ui-chat` 声明**（0.1.2 那份住在 ui-conversation 里），
// 所以我们之前手抄的那份副本（`chat/slot-contract.d.ts`）删了、改回 import 真身：
// 真身比手抄那份多了两格（`hookContext` 与 `inject`），而手抄副本最大的代价正是
// "自己写的契约校验自己写的代码"。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// 类型 only：把 `settings.section` 那条 SlotMap 合并拉进本程序。同样地，0.2.0 起
// `dsh-client-ui-settings` 与引擎同线可装，手抄的 `settings/slot-contract.d.ts` 删了。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型 only：把 `ctx.inputTriggers` 那条 Context 合并拉进本程序（`@` 引用源注册用）。
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ReactNode } from 'react'
import { itemContext } from './panel/item-context-store.ts'
import { makeStreamRefSource } from './input/stream-ref-source.ts'
import { ensureChipStyles } from './input/chip-styles.ts'
import { makeNetdiskRefSource, makeSubscriptionRefSource } from './input/reconcile-ref-sources.ts'
import { fetchRefDirs, fetchRefStreams } from './input/ref-data.ts'
import { customRows, slotKeyFor } from '../registry.ts'
import { ShellLayoutController } from './shell/layout-service.ts'
import { interceptSessionPick } from './shell/session-pick.ts'
import { currentMainSessionId } from './current-session.ts'
import { makeStreamSettingsSection } from './settings/StreamSettingsSection.tsx'
import { ShellThemePresenter } from './shell/theme-presenter.ts'
import { makeStreamShell } from './shell/StreamShell.tsx'
import { UserMessageNodeView } from './chat/UserMessageNodeView.tsx'
import { ContentSearchCard } from './cards/ContentSearchCard.tsx'
import { InboxSearchCard } from './cards/InboxSearchCard.tsx'
import { EventsCard } from './cards/EventsCard.tsx'
import { ExtractCard } from './cards/ExtractCard.tsx'
import { StreamListCard } from './cards/StreamListCard.tsx'
import { SubscribeCard } from './cards/SubscribeCard.tsx'
import { PurchaseDecideCard } from './cards/PurchaseDecideCard.tsx'
import { AgentRunCard } from './cards/AgentRunCard.tsx'
import { readBackendUrl } from './backend.ts'
import { configureBackend } from '../deep-links.ts'
import { askWhenWorkspaceReady } from './ask-conversation.ts'
import { applyAskChatOp } from './compose-into-conversation.ts'
import { takeAskFromLocation } from './ask-deep-link.ts'

/** 一张卡只吃 owner payload 里的 `block`（`ToolCallOwnerProps` 的冻结节点）。 */
export type StreamCard = (props: { block: ToolCallBlock }) => ReactNode

/**
 * 注册表里 `treatment: 'custom'` 的行 → 组件。
 *
 * **这张表和 `registry-table.json` 必须逐格对上**：json 里某行写着 custom 却在这里查不到
 * 组件，就是一个注册不上的 key（静默回落通用卡，没有任何一处会喊）。这条由本包的
 * `test/registry.test.ts` 钉住。
 */
export const CARDS: Readonly<Record<string, StreamCard>> = {
  content_search: ContentSearchCard,
  // 存量（inbox_search）和现搜（content_search）是两件事，两张卡：共用一张会把
  // 「我订过的」和「刚搜到的」混成一个样子，而那正是这个工具存在的理由。
  inbox_search: InboxSearchCard,
  extract: ExtractCard,
  get_events: EventsCard,
  stream_list: StreamListCard,
  stream_subscribe: SubscribeCard,
  // 和 stream_subscribe 是同一件事的两种入口，回执形状一样——共用同一张卡，
  // 别做第二张会漂移的（注册表那一行的 why 就是这么写的）。
  subscribe_source: SubscribeCard,
  // 购买决策 job：`purchase_decide` 只回"已发起"，回执经 `get_agent_run` 取——两张卡共用
  // 同一个 ReceiptView，对比表只有一份。
  purchase_decide: PurchaseDecideCard,
  get_agent_run: AgentRunCard,
}

/**
 * 需要的服务：槽注册 + 主题（壳反转后主题投影归我们做，见 shell/theme-presenter.ts）。
 *
 * **只有这两个进硬 inject**，侧栏「新会话」用的 `uiWorkspace` 走调用时现取。理由和下面
 * 那段软 inject 一样、而且更重：硬 inject 是**装载门，且是双向的**——那个服务重挂一次，
 * 本插件就跟着被卸载重装；而本插件扛着整页布局壳，卸掉的那一瞬间整页是空的。
 * `uiWorkspace` 自己 inject 了 `remote.directoryPicker`（`@deepseek-ai/dsh-client-ui-workspace`
 * 的 `inject` 列表），比 `slots`/`theme` 长一截依赖链，赌不起。
 */
export const inject = ['slots', 'theme']

/**
 * 客户端插件体。
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  // Stream 后端地址：host 半经页面常量下发（这条线的三条候选路与取舍见 `src/wire.ts`）。
  // **开局读一次就够**——它是页面级常量，页面在这一份就不会变；换了地址是换一次页面。
  // 没下发时 `backend` 是 undefined：壳照常接管整页（对话/侧栏不受影响），主区画一句
  // 人话说明，深链降级成不可点的文本。**绝不**回落到某个写死的地址去赌。
  const backend = readBackendUrl()
  configureBackend(backend)

  // 用户消息气泡：接管它，好把句子里的 `「标题」(item:xxx)` 画成一枚卡片式标记
  // （文法见 `chat/refs.ts`，为什么敢接见 `chat/UserMessage.tsx` 头注）。
  //
  // `priority: -1` —— keyed 槽的同一格可以叠，**最低的那个渲染**（ui-slots 的 register
  // 文档）。不给 priority 就是和 ui-conversation 的注册撞在同一格同一优先级上，那会
  // **抛错**（它刻意 fail-loud，免得两个渲染件默默打架）。
  //
  // `slots.inject` 而不是直接 register：这个槽由 ui-conversation 的 chat view 声明，它比
  // 我们晚就位是常态——直接 register 会落进一个还不存在的槽里，安静地什么都不发生。
  for (const key of ['user', 'steering'] as const) {
    ctx.slots.inject('conversation.chat.node', () =>
      ctx.slots.register({ name: 'conversation.chat.node', key, priority: -1 }, UserMessageNodeView))
  }

  for (const row of customRows) {
    const Component = CARDS[row.tool]
    // 表里说 custom、这里却没有组件：跳过而不是抛——一个渲染包不该把整个工作台的
    // 插件装载搞崩。真正的守卫在测试里（registry.test.ts），那里是红的。
    if (Component === undefined) continue
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: slotKeyFor(row) }, Component))
  }

  // DSH 设置里的「Stream」分区：包/插件/组件那一堆**全局**运维（不属于任何频道或会话）的家。
  // 为什么在设置里而不是侧栏，见 `settings/StreamSettingsSection.tsx` 头注。
  //
  // `slots.inject` 而不是直接 register：这个槽由设置那张壳（ui-settings-general）声明，它比
  // 我们晚就位是常态——直接 register 会落进一个还不存在的槽里，安静地什么都不发生。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'stream', order: 20, label: () => 'Stream' },
      makeStreamSettingsSection(backend),
    ))

  // ── 壳反转（spec §14 穿刺）：接管 root，Stream 为主面、对话为侧面。
  // profile 已把 ui-layout 那一行关掉（重复声明子槽会 throw，两个 root 壳不能共存），
  // 它的四件职责全数接过来：`ctx.layout` 服务（ui-sidebar / ui-conversation /
  // ui-sidebar-right 的硬 inject 门）、根标准座位（`panelInfo`）、主题投影、root 注册 +
  // 子槽声明。
  //
  // `hasMainPanel` **现取**注册表：`selectPanel` 的校验要问"这格 key 注册过没有"，而注册表
  // 是活的（插件随装载/卸载进出，ui-schedule 与 ui-plugin-manager 各注册一格），存下来就
  // 冻住了那一刻的答案。
  const layout = new ShellLayoutController(
    (id) => ctx.slots.entries('main').some((entry) => entry.options.key === id),
  )
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    // 根标准座位：`usePanelInfo` 的供体（ui-layout 自己那一行 `provideRoot` 随它一起被关了）。
    // 注册进 `main` 的全局面板读的就是这一格——缺了它们判不出"我是不是当前那格"，
    // 表现是那排图标永不点亮，且没有任何一处会报错。
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      // kind/scope 必须与原声明逐字一致——消费方按这份契约注册，改了它们就落不进来。
      // `main` / `rightbar` / `shell.overlay` 抄 ui-layout 的 root 声明（0.2.0 把原来的
      // `conversation` / `details` 两格重划成了 `main`（keyed）/ `rightbar`）；
      // sidebar 那三个内缝抄 ui-sidebar：侧栏也是我们的壳件（见 StreamShell 头注），
      // 不声明 `sidebar` 本身——ui-sidebar 的注册等不到那个声明，安静休眠；
      // 它的插槽件（工作区浏览器/设置/脚下动作）经这三个缝落进我们的侧栏。
      children: {
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    }, makeStreamShell(
      layout,
      backend,
      () => {
        // 先把对话列露出来再建：收着的时候点新会话，会话真建出来了但一个字都看不见——
        // 和"点了没反应"长得一样。
        layout.revealConversation()
        // **调用时现取**（`ctx.get`，不经硬 inject）：这个服务比本插件晚就位、还可能重挂，
        // 存下来就冻住了那一刻的答案。不在场时按钮点下去什么也不做——比整页空白好。
        ctx.get('uiWorkspace')?.startSession()
      },
      async (op) => {
        // 现读，不是装配期存下来：这三个服务比本插件晚就位是常态（见上面那段 inject）。
        if (convCtx === undefined) throw new Error('对话服务还没就位（工作台刚起来时会有这么一小会儿），过几秒再试')
        await applyAskChatOp(convCtx, op)
      },
    ))
    return () => {
      disposeRegistration()
      disposePanelInfo()
      // 还挂着的那趟导航要中止掉：它的 await 结束后不能接着动一个已经拆了的壳。
      layout.dispose()
      disposeService()
    }
  }, 'stream-ui: layout service + root takeover')

  // ── 「转成文字」要用到的四个服务（sessions / conversation / workspaces / uiWorkspace）。
  // workspaces 是名册（挑工作区要读它），uiWorkspace 是导航（connectWorkspace 在它身上）。
  //
  // **必须先声明再取**：cordis 的 context 会拦住没声明过的服务访问
  // （`cannot get property "sessions" without inject`）——活体撞过，表现是点转成文字弹一句
  // 这个错。走**软 inject**（`ctx.inject(deps, cb)`）而不是把它们写进上面那个硬 `inject`：
  // 硬 inject 是装载门，任何一个不在场整个插件装不上，而这个插件扛着整页布局壳——
  // 为一个动作赌上整页空白，代价不成比例。
  //
  // 服务在场时把那个 scoped ctx 存下来给按钮用；不在场时它是 undefined，按钮点下去抛人话
  // （面板那侧会弹 toast），而不是崩一片。**取的时候现读**，别在装配期把服务本身存下来。
  let convCtx: ClientContext | undefined
  const asked = takeAskFromLocation()
  ctx.inject(['sessions', 'conversation', 'workspaces', 'uiWorkspace'], (scoped) => {
    scoped.effect(() => {
      convCtx = scoped as ClientContext
      // 进门时地址栏上带着一句话（8900 的「转成文字」跳过来时就是这样）：开一条对话发出去。
      // 读参数在 apply 开头就做完了（读一次就抹掉，刷新不重发），发在这里——要等这三个
      // 服务到齐，也要等工作区名册就位。
      const stopAsk = asked === undefined ? undefined : askWhenWorkspaceReady(scoped as ClientContext, asked)
      // 点会话行 → 布局（打开对话栏 / 再点一次收起）。截在服务上而不是 DOM 上，理由见
      // session-pick.ts 头注（0.2.0 起截的是 `uiWorkspace.openSession`，不是 `sessions.open`）。
      const stopPick = interceptSessionPick(
        scoped.uiWorkspace,
        // 现取而不是存下来：高亮跟着选中变，存一次就把"点的是不是当前那条"钉死在第一下。
        () => currentMainSessionId(scoped),
        (isCurrentRow) => { layout.pickRow('conversation', isCurrentRow) },
      )
      return () => {
        stopPick()
        stopAsk?.()
        convCtx = undefined
      }
    }, 'stream-ui: conversation services')
  })

  // ── 对话输入框里的 `@` 引用：把「我正在看的这条」插进草稿（见 input/stream-ref-source.ts）。
  //
  // **不写进上面那个 `inject`**：`inject` 是硬门，`inputTriggers` 没起来整个插件就装不上，
  // 而这个插件还扛着整页布局壳——为一个锦上添花的引用源赌上整页空白，代价不成比例。
  // `ctx.inject(deps, cb)` 是软的：服务在场才跑这一段，不在场安静休眠。
  ctx.inject(['inputTriggers'], (scoped) => {
    // 引用格子的宽度/省略号修补（见 input/chip-styles.ts 的头注）。挂在这里而不是模块顶层：
    // 有引用源才有引用格子，两件事同生同灭。
    ensureChipStyles()
    scoped.effect(
      () => scoped.inputTriggers.registerSource(makeStreamRefSource(itemContext)),
      'stream-ui: @ reference source',
    )
    // 另外两组：`@` 一条订阅、`@` 一个网盘目录（spec 2026-08-25-reconcile-as-conversation §5）。
    // 它们是"把一条订阅和一个网盘目录接起来"那句话的两半——说完这两个 `@`，AI 手里就有
    // 开一次整理需要的全部东西（`reconcile_open`），不用再猜、也不用再搜。
    //
    // **后端地址缺席就整组不注册**：这两组的候选全靠问后端，没有地址时注册出来的是两个
    // 恒空的分组——用户打 `@` 看到自己的分组标题下什么都没有，比压根没有这一组更像坏了。
    const backend = readBackendUrl()
    if (backend !== undefined) {
      scoped.effect(
        () => scoped.inputTriggers.registerSource(
          makeSubscriptionRefSource((signal) => fetchRefStreams(backend, signal)),
        ),
        'stream-ui: @ subscription source',
      )
      scoped.effect(
        () => scoped.inputTriggers.registerSource(
          makeNetdiskRefSource((dir, signal) => fetchRefDirs(backend, dir, signal)),
        ),
        'stream-ui: @ netdisk dir source',
      )
    }
  })

  ctx.effect(() => {
    const presenter = new ShellThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'stream-ui: theme presenter')
}
