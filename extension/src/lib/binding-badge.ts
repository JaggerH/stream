/**
 * 弹窗右上角那颗徽标：**全部绑定**（本机 + 已配对的）合起来看。
 *
 * 以前它只看本机那条中继，所以「本机没 Stream、只配对了远处一台」的机器上会一直显示
 * offline——明明任务在跑，徽标却说没连上。纯函数，不碰 chrome.*：输入是 SW 回的每条绑定
 * 的在线状态（`bindings-status`），输出是可直接渲染的文案与成色。
 *
 * 哪些绑定算数：有地址、没被实例撤销、也不是别的 profile 的。没填地址的本机绑定还没成为
 * 一个可连的目标，撤销/别的 profile 的绑定则是**按设计**不连——把它们算进分母，徽标就会
 * 永远停在「1 connected · 1 offline」，而用户什么都做错了。
 */

export interface BindingOnlineState {
  baseUrl: string
  connected: boolean
  revoked?: boolean
  foreignNode?: boolean
}

export interface BindingBadge {
  label: string
  /** 与 relay-health 同一套成色：ok 绿、warn 黄、bad 红。 */
  tone: 'ok' | 'warn' | 'bad'
}

export function isActiveBinding(b: BindingOnlineState): boolean {
  return Boolean(b.baseUrl) && !b.revoked && !b.foreignNode
}

/**
 * @param bindings 每条绑定的在线状态；null = 还在查（SW 往返未回）。
 *   **null 绝不能画成 connected**：查询要走一次 SW 往返（SW 睡着时还得等它醒），
 *   先亮一颗绿点再翻黄，比诚实地说 "checking…" 更容易被读成"好着呢"。
 */
export function bindingBadge(bindings: BindingOnlineState[] | null): BindingBadge {
  if (bindings === null) return { label: 'checking…', tone: 'warn' }
  const active = bindings.filter(isActiveBinding)
  const up = active.filter((b) => b.connected).length
  if (active.length === 0 || up === 0) return { label: 'offline', tone: 'bad' }
  if (up === active.length) return { label: `${up} connected`, tone: 'ok' }
  return { label: `${up} connected · ${active.length - up} offline`, tone: 'warn' }
}
