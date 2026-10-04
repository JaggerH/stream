/**
 * 面板里的动作落到对话上的**三种形态**，一个入口。
 *
 * 之前只有一种：`askInNewConversation`——开一条会话、把话发出去。那对「转成文字」「让 AI 整理」
 * 是对的（说完就等它干活），但对**引用**是错的：引用之后用户还要接着说下一句
 * （"这个 @春典JARGON 跟 @/quark/… 对一下"），所以引用必须是**塞进输入框、不发**。
 *
 * | 形态 | 干什么 | 谁在用 |
 * |---|---|---|
 * | `send` | 开一条会话，把整句发出去 | 转成文字 / 让 AI 整理 |
 * | `compose` | 往当前会话的草稿**追加**一段文字，不发 | 右键引用一条订阅 |
 * | `ref-item` | 往草稿插一条**内容引用**（占位符 + codec），不发 | 右键引用一条内容 |
 *
 * ## 为什么引用一条内容不能用 compose 顶替
 *
 * `compose` 插进去的是死文字，模型看到什么就是什么。而一条内容要**随附正文**——那份正文得在
 * **发送那一刻**现取（用户可能插完又滚了几屏、开了别的详情）。这正是 `@` 引用那条路已经解决的
 * 问题：`insertReference` 插的是一个有身份的占位符，发送时由源的 `codec.serialize` 现取内容
 * （见 `input/stream-ref-source.ts` 的头注）。所以这里复用同一套机制，不另造第二份序列化。
 *
 * ## 追加而不是覆盖
 *
 * `SessionInput.setDraft` 收的是**整份新草稿**，直接写就等于把用户正在打的字抹掉。
 * 所幸草稿是可读的（`input.state.getSnapshot().draft`），所以这里读了再拼。
 * **别改成直接 setDraft(text)**——那个 bug 不会报错，只会让用户打了一半的话凭空消失。
 *
 * ## 落到哪条会话
 *
 * `send` 沿用老行为（`connectWorkspace` 自带复用：有空会话就用那条，否则新建）。
 * `compose` / `ref-item` **优先落在当前正开着的那条**——往草稿里塞东西的语义就是"我正看着的
 * 这场对话"，为它新开一条会话，用户会眼睁睁看着自己的上下文被换掉。
 *
 * "当前那条"与"切过去"两件事在 0.2.0 都换了来源：前者没有现成的 `current` 了（改从引用
 * 计数推，判据住 `current-session.ts`），后者从 `ctx.sessions.open` 挪到了
 * `ctx.uiWorkspace.openSession`（选择归导航）。
 */
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型 only：`ctx.sessions` / `ctx.workspaces` 的 Context 合并声明（理由同 ask-conversation.ts）。
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// 类型 only：`ctx.uiWorkspace` 那一格（`connectWorkspace` / `openSession` 0.1.2 起住这儿）。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { currentMainSessionId } from './current-session.ts'
import { recentWorkspaceId } from './workspace-pick.ts'
import { STREAM_REF_SOURCE_NAME } from './input/stream-ref-source.ts'

/** 面板递过来的一次动作。 */
export type AskChatOp =
  | { kind: 'send'; text: string }
  | { kind: 'compose'; text: string }
  | { kind: 'ref-item'; id: string; label: string }

/** `ctx.conversation` 上我们用到的那两格（不 import DSH 的类型合并，理由同 ask-conversation.ts）。 */
interface ConversationFace {
  send(text: string): Promise<void>
  input: {
    for(actx: unknown): {
      setDraft(text: string): void
      insertReference(
        ref: { source: string; ref: string; label: string; clipboardText: string },
        span: { start: number; end: number; draftRev: number },
      ): boolean
      state: { getSnapshot(): { draft: string; draftRev: number } }
    }
  }
}

const conversationOf = (ctx: unknown): ConversationFace | undefined =>
  (ctx as { conversation?: ConversationFace }).conversation

/**
 * 追加时的分隔：空草稿不加空格；已经以空白结尾也不加（用户自己敲的那个空格要留着）。
 * @param draft - 当前草稿。
 * @param text - 要追加的那段。
 */
export function appendToDraft(draft: string, text: string): string {
  if (draft === '') return text
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`
}

/** 目标会话：当前开着的那条优先，没有就走"连上工作区"（它自带空会话复用）。 */
async function targetSession(ctx: ClientContext, preferCurrent: boolean): Promise<string> {
  const uiWorkspace = ctx.uiWorkspace
  if (uiWorkspace === undefined || conversationOf(ctx) === undefined) {
    throw new Error('对话服务还没就位（工作台刚起来时会有这么一小会儿），过几秒再试')
  }
  if (preferCurrent) {
    const current = currentMainSessionId(ctx)
    if (current !== undefined) return current
  }
  const workspaceId = recentWorkspaceId(ctx)
  if (workspaceId === undefined) throw new Error('还没有工作区可用——先在左侧选一个工作区')
  const id = await uiWorkspace.connectWorkspace(workspaceId)
  uiWorkspace.openSession(id)
  return id
}

/**
 * 执行一次面板动作。
 * @param ctx - 插件根 context（服务调用时现取，不在装配期存）。
 * @param op - 要做的事。
 */
export async function applyAskChatOp(ctx: ClientContext, op: AskChatOp): Promise<void> {
  const sessionId = await targetSession(ctx, op.kind !== 'send')
  const scope = createScope(ctx, sessionId as never)
  try {
    const conversation = conversationOf(scope.ctx)
    if (conversation === undefined) throw new Error('对话服务不在（DSH 的 ui-conversation 没装上？）')
    if (op.kind === 'send') {
      await conversation.send(op.text)
      return
    }
    const input = conversation.input.for(scope.ctx)
    const { draft, draftRev } = input.state.getSnapshot()
    if (op.kind === 'compose') {
      input.setDraft(appendToDraft(draft, op.text))
      return
    }
    // 先把分隔空格补上（引用紧贴着上一个字会连成一坨），**补完重新读一次快照**——
    // `draftRev` 是 CAS 的凭据，绝不能靠"setDraft 大概把它加了 1"去猜：那是在赌别人家的
    // 内部实现，猜错就是把引用插到错的位置上，而且不会报错。
    if (draft !== '' && !/\s$/.test(draft)) input.setDraft(`${draft} `)
    const now = input.state.getSnapshot()
    // 零宽 span 钉在草稿末尾：`insertReference` 的语义是"把这段 span 换成一条引用"，
    // start === end 就是纯插入。CAS 不过（用户在这两拍之间又敲了字）返回 false，
    // 那正是我们要的：宁可不插，也不要插到错的位置上。
    const at = now.draft.length
    const ok = input.insertReference(
      {
        source: STREAM_REF_SOURCE_NAME,
        ref: op.id,
        label: op.label,
        clipboardText: `@${op.label}`,
      },
      { start: at, end: at, draftRev: now.draftRev },
    )
    if (!ok) throw new Error('输入框刚好在这一拍变了，引用没插进去——再点一次')
  } finally {
    // 这个 scope 只为这一次动作而铸；用完就拆，别把 fiber 挂在插件生命期上攒着。
    scope.fiber.dispose()
  }
}
