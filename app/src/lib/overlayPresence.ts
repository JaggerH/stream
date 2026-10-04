/**
 * 「主区此刻被一块全屏覆盖层占着没有」——由**产生那块覆盖层的组件自己报到**（`DetailShell`
 * 挂载/卸载时各报一次），不是从各处播放状态里挖出来的。
 *
 * 为什么必须这么倒过来：影视频道的「正在看片」不是一个状态，是**好几个**——继续观看的
 * `resuming`、作品详情里的分集播放、TMDb 详情里的播放，各自住在各自的组件里，将来还会加。
 * 逐个把它们接出来，等于每加一处播放入口就要记得接一次线；漏了不会报错，只是对话列没让位。
 * 而这些入口的共同点恰恰是**都渲染 `DetailShell`**（它就是那块 `fixed inset-0` 的覆盖层），
 * 所以判据只在那一个地方成立一次。
 *
 * **每个 bundle 各有一份**（面板主 bundle / 详情 bundle / 影视 bundle 是三个独立的 JS 运行时，
 * 模块实例不共享）。所以它只解决"同一棵树里的覆盖层"这一段，跨 bundle 的转发由各 bundle 的
 * mount 回调负责（影视那条是 `MovieMountOptions.onOverlayChange`）。时间线那条详情不用它——
 * `StreamPanel` 本来就持有 `detail` 状态、自己知道；主应用（8900）里没有订阅者，报到就是空转。
 *
 * 计数而不是布尔：同一时刻可以有两层（详情里再开个什么），先关的那一层不该把"还占着"清成 false。
 */

type Listener = () => void

let count = 0
const listeners = new Set<Listener>()

function notify(): void {
  for (const fn of listeners) fn()
}

/** 现在有没有覆盖层占着主区。 */
export function overlayOpen(): boolean {
  return count > 0
}

/** 订阅变化；返回撤订阅。 */
export function subscribeOverlay(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * 报到：一块覆盖层出现了。
 * @returns 撤销（那块覆盖层没了）。**必须调**——不调就永远停在"占着"。
 */
export function addOverlay(): () => void {
  count += 1
  if (count === 1) notify()
  let released = false
  return () => {
    // 幂等：React StrictMode 下 effect 会跑两遍 setup/cleanup，重复释放会把计数打成负数，
    // 之后真正的那一层再关就永远回不到 0。
    if (released) return
    released = true
    count -= 1
    if (count === 0) notify()
  }
}

/** 测试用：把计数清零（模块级状态跨用例会串）。 */
export function resetOverlayPresence(): void {
  count = 0
  listeners.clear()
}
