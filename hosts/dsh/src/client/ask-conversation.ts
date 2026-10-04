/**
 * 「开一条对话，把这句话发进去」—— 面板里的转成文字点下去落在这里。
 *
 * 三步，用的全是 DSH 自己的公共面，没有一处 DOM 手术：
 *   1. `ctx.workspaces.connectWorkspace(ws)` 拿到目标会话（**它自带复用**：这个工作区里
 *      已经有一条空会话就用那条，否则在 host 上新建一条——和侧栏「新会话」逐字同源）；
 *   2. `ctx.uiWorkspace.openSession(id)` 切过去（0.2.0 起选择住导航，`ISessions` 上
 *      那格 `open` 已经没有了）；
 *   3. `createScope(ctx, id).ctx.conversation.send(text)` 发第一句。
 *
 * **第 3 步为什么要 createScope**：`ctx.conversation` 是 scope-addressed 的——它按调用方
 * context 上的 agent tag 决定发给哪条会话。插件根 ctx 上没有那个 tag，直接 `send` 要么发错
 * 地方要么什么都不做。`createScope(ctx, sessionId)` 就是官方铸这个 tag 的那把工具。
 *
 * **失败必须响**：整条路上任何一步失败都会表现为"点了没反应"，而它和"工作台还没连上"、
 * "面板坏了"长得一模一样。所以这里的每个出口都抛，由面板那一侧接住弹 toast
 * （`app/src/lib/askExtract.ts` 会 await 这个 promise）。
 */
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型 only：`ctx.sessions` / `ctx.workspaces` 这两格是这两个包对 cordis `Context` 的合并声明，
// 不拉进来编译期就看不见它们（DSH 0.1.2 起客户端运行时按包切开，没有一个统一的 ClientContext）。
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// 类型 only：`ctx.uiWorkspace` 那一格（`connectWorkspace` / `startSession` 0.1.2 起住这儿）。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { recentWorkspaceId, workspaceRosterReady } from './workspace-pick.ts'

/**
 * `ctx.conversation` 上我们用到的那一格。
 *
 * **不 import `@deepseek-ai/dsh-client-ui-conversation` 的类型合并**：那会给这个包多一条
 * 只为一个方法签名而存在的依赖，而这一格的契约小到可以逐字抄（`send(text)`，见该包的
 * `IConversation`）。代价是"DSH 改了这个签名我们不会在编译期发现"——所以下面取服务时
 * 做了在场判断，缺了就抛人话，而不是 undefined 上点方法崩一片。
 */
interface ConversationFace {
  send(text: string): Promise<void>
}

/** 从一个（scope 过的）context 上取 conversation 服务。 */
function conversationOf(ctx: unknown): ConversationFace | undefined {
  return (ctx as { conversation?: ConversationFace }).conversation
}

/**
 * 在一条新会话里发出这句话。
 * @param ctx - 插件根 context（**调用时才从它上面取服务**，不在装配期存下来：
 *   sessions / conversation 都可能比本插件晚一步就位，存下来就冻住了那一刻的答案）。
 * @param text - 发出去的整句。
 */
export async function askInNewConversation(ctx: ClientContext, text: string): Promise<void> {
  const uiWorkspace = ctx.uiWorkspace
  if (uiWorkspace === undefined || conversationOf(ctx) === undefined) {
    throw new Error('对话服务还没就位（工作台刚起来时会有这么一小会儿），过几秒再试')
  }
  // 目标工作区：当前会话所在的那个优先，其次最近改动过的（判据只有一份，见 workspace-pick.ts）。
  // 两个都没有 = 用户还没有工作区，这时候不能替他挑一个——`connectWorkspace` 只受理名册里的 id。
  const workspaceId = recentWorkspaceId(ctx)
  if (workspaceId === undefined) {
    throw new Error('还没有工作区可用——先在左侧选一个工作区，再转成文字')
  }
  const sessionId = await uiWorkspace.connectWorkspace(workspaceId)
  // 切过去（0.2.0：选择归导航，不是 `sessions.open`——见头注第 2 步）。
  uiWorkspace.openSession(sessionId)
  const scope = createScope(ctx, sessionId)
  try {
    const conversation = conversationOf(scope.ctx)
    if (conversation === undefined) throw new Error('对话服务不在（DSH 的 ui-conversation 没装上？）')
    await conversation.send(text)
  } finally {
    // 这个 scope 只为发这一句而铸；发完就拆，别把 fiber 挂在插件生命期上攒着。
    scope.fiber.dispose()
  }
}

/**
 * 深链那一档用的版本：**等工作区名册就位再发**。
 *
 * 从 8900 跳过来时页面刚起，名册还没到、挑不出工作区——这时直接发必然抛
 * 「还没有工作区可用」，而用户什么也没做错，只是来得早。所以这里订阅名册，等到
 * 它 `phase: 'ready'` 那一刻再发一次；订阅**发完/出错就撤**，不留常驻监听。
 *
 * @param ctx - 插件根 context。
 * @param text - 发出去的整句。
 * @returns 撤订阅的函数（插件卸载时调它——不然页面切走之后还可能凭空发出一条消息）。
 */
export function askWhenWorkspaceReady(ctx: ClientContext, text: string): () => void {
  let done = false
  let stop: (() => void) | undefined
  const attempt = (): void => {
    if (done) return
    if (!workspaceRosterReady(ctx) || recentWorkspaceId(ctx) === undefined) return
    done = true
    stop?.()
    void askInNewConversation(ctx, text).catch((e: unknown) => {
      // 这一档没有 toast 可用（深链发生在面板挂起来之前）。console 是这里唯一的出口，
      // 至少让"跳过来一片安静"在控制台留下原因。
      console.error('[stream-ui] 深链那一句没发出去：', e)
    })
  }
  stop = ctx.workspaces?.list.subscribe(attempt)
  attempt()
  return () => { done = true; stop?.() }
}
