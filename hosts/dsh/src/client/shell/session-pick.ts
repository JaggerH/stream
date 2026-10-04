/**
 * 「点会话行」这一下的截获点。
 *
 * 侧栏下半截那份会话名单**不是我们画的**——它是 DSH 的 ui-workspace 落进 `sidebar.workspaces`
 * 缝里的插槽件，行的 onClick 我们够不着。但那个 onClick 是**无条件**调
 * `uiWorkspace.openSession(行的 id)` 的（`@deepseek-ai/dsh-client-ui-workspace` 编译产物里
 * SessionRow 的 onClick → `browserInjected.open` → `uiWorkspace.openSession`），没有
 * "已经是当前就不调"的守卫。所以点**已高亮那条**的那一下会照样走到这个方法上——
 * 包一层就够，不用去 DOM 上按类名做捕获拦截（它的类名是编译期 hash 的，随引擎升级就变）。
 *
 * **0.2.0 换的两件事都不是重命名，别照着老写法找回来：**
 *
 * 1. 载体从 `ctx.sessions.open` 挪到了 **`ctx.uiWorkspace.openSession`**：`ISessions` 里
 *    已经没有"选中"这个概念了（它只管目录/引用/作用域），选择归导航。
 * 2. "哪条是当前那条"不再有人回答（`SessionListState` 里没有 `current`），得自己推——
 *    见 `current-session.ts`，判据那侧有头注。
 *
 * 包的是行为不是样式，仍然是耦合：DSH 哪天给行的 onClick 加上 `if (id !== current)` 守卫，
 * 这个手势就**静默失效**（点了没反应，不报错、不降级）。我们这层的测试钉不住那一层，
 * 所以下面装不上时要吵（console.warn）——它是唯一会喊的一处。
 */

/** 我们用得着的那一小块导航面（`Id` 是引擎那边的 branded SessionId）。 */
export interface SessionNavigationFace<Id> {
  openSession(target: Id): void
}

/**
 * 把 `uiWorkspace.openSession` 包一层：转发之前先把"点的是不是当前那条"报给布局。
 *
 * **总是转发**给原方法——我们只在旁边加一件事（布局），不改 DSH 自己的选中语义；
 * 点当前那条时 `openSession(同一个 id)` 在它那边本来就是无副作用的重复选中。
 *
 * @param navigation - `ctx.uiWorkspace` 实例。
 * @param currentId - 现取"此刻高亮的是哪条"（**每次点击时调**：存下来就冻住了点第一下时的答案）。
 * @param onPick - 收到一下点击（`isCurrentRow` = 点的就是此刻高亮那条）。
 * @returns 还原原方法的 disposer。
 */
export function interceptSessionPick<Id>(
  navigation: SessionNavigationFace<Id>,
  currentId: () => Id | undefined,
  onPick: (isCurrentRow: boolean) => void,
): () => void {
  const original = navigation.openSession
  const owned = Object.prototype.hasOwnProperty.call(navigation, 'openSession')
  const patched = (target: Id): void => {
    onPick(target === currentId())
    original.call(navigation, target)
  }
  let installed = false
  try {
    navigation.openSession = patched
    installed = navigation.openSession === patched
  } catch {
    // 冻结/只读对象上的赋值在严格模式下**抛**（不是静默失败）——两种都算装不上。
    installed = false
  }
  if (!installed) {
    // 装不上（服务被冻结/代理拦了写）。布局照常能用，只是"再点一次收起对话栏"这一个手势没了——
    // 这类缺席不吵就永远没人知道。
    console.warn('[stream-ui] uiWorkspace.openSession 包不上，"再点一次收起对话栏"不可用')
    return () => {}
  }
  return () => {
    if (navigation.openSession !== patched) return // 别人后来又包了一层，还原会把他那层抹掉
    if (owned) navigation.openSession = original
    else delete (navigation as { openSession?: unknown }).openSession
  }
}
