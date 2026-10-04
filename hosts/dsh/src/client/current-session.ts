/**
 * 「此刻显示在对话里的那条会话是哪条」——0.2.0 起**没有现成答案**。
 *
 * `ISessions` 上原本那格 `list.getSnapshot().current` 在 0.2.0 没有了：会话服务只管目录、
 * 引用与作用域，"选中"整个概念搬去了导航（`ctx.uiWorkspace.openSession`），而
 * `UiWorkspace` 的公开面里也不回读当前那条（它在自己内部存着 `mainReference`）。
 *
 * 剩下的可推信号是**引用计数**：`SessionSummary.retainedBy` 按消费方分类计数，`mainView`
 * 就是"中央那格对话视图"这一类。这不是我们发明的判据——`@deepseek-ai/dsh-client-ui-workspace`
 * 自己的会话浏览器也是这么读的（`Object.values(list.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)`），
 * 侧栏那行的"当前"高亮就是它画的。我们只是读同一个信号，好让我们的判据和它的高亮永远一致。
 *
 * **别改成数 `ids[0]` 或看 `updatedAt` 最新**：目录顺序是用户的手动排序，跟"正在看哪条"
 * 无关。数错了的症状有两个，**都不报错**：点已经高亮的那条会话，那一栏收不起来；
 * 以及「转成文字」把句子发进了别的会话。
 *
 * 拼错来源名同样不会报错（恒为 0）。这个名字由 `@deepseek-ai/dsh-client-ui-session` 对
 * `SessionReferenceSourceMap` 的合并给出，而那个包不在本包依赖里（只为读一个字符串把它装
 * 进来不划算），所以这里按字符串读——判据由 `test/session-pick.test.ts` 用真形状的夹具钉着。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'

/** 服务自己那一格会话 id 的类型（不另引 `SessionId` 所在的包——只为类型名背一个依赖不划算）。 */
type SessionListSnapshot = ReturnType<NonNullable<Context['sessions']>['list']['getSnapshot']>
/** 一条会话的 id。 */
export type CurrentSessionId = SessionListSnapshot['ids'][number]

/** 中央对话视图那一类引用的来源名（见头注：字符串读，不做类型依赖）。 */
const MAIN_VIEW_SOURCE = 'mainView'

/** 一行会话上那格"按来源分的引用计数"（`SessionSummary.retainedBy` 的形状）。 */
type RetainedBy = Readonly<Partial<Record<string, number>>>

/**
 * 当前会话的 id。
 * @param ctx - 客户端 context（服务现取，不在装配期存）。
 * @returns 中央对话视图此刻攥着的那条会话；一条都没有时 `undefined`。
 */
export function currentMainSessionId(ctx: Context): CurrentSessionId | undefined {
  const list = ctx.sessions?.list.getSnapshot()
  if (list === undefined) return undefined
  for (const id of list.ids) {
    const row = list.byId[id]
    if (row === undefined) continue
    // `Object.entries` 而不是 `row.retainedBy[MAIN_VIEW_SOURCE]`：那格是**按字面量联合**声明的
    // 可选属性，按 string 取索引编译不过，而按字面量取又得把那个包装进来（见头注）。
    if ((Object.entries(row.retainedBy as RetainedBy).find(([source]) => source === MAIN_VIEW_SOURCE)?.[1] ?? 0) > 0) {
      return id
    }
  }
  return undefined
}
