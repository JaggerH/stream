/**
 * 「把运维页打开到某个源的修复页」——**跨 React root 的桥**。
 *
 * 要打开它的人在内容区那棵树里（频道配置的源行）和导航树的通知铃里，能打开它的只有宿主
 * （独立正门盖一层、DSH 走设置窗）。三处没有 context / props 可走，所以和 `channelStore` 一样
 * 做成模块级：宿主经 `register` 登记一次，谁要开就 `open`。
 *
 * 没登记（DSH 今天不登记）时 `open` 回 false——调用方据此**不画**那个点了没反应的入口。
 */
export interface ManageTarget {
  view: 'source-health'
  sourceId?: string
}

let handler: ((t?: ManageTarget) => void) | undefined

export const manageBridge = {
  register(fn: (t?: ManageTarget) => void): () => void {
    handler = fn
    return () => { if (handler === fn) handler = undefined }
  },
  open(t?: ManageTarget): boolean {
    if (!handler) return false
    handler(t)
    return true
  },
  available(): boolean {
    return handler !== undefined
  },
}
