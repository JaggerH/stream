/**
 * 中继上「扩展主动说一声」的那半，单独一个模块。
 *
 * 为什么不直接放在 `driver.ts` 里：那个模块在顶层就 `chrome.debugger.onEvent.addListener(...)`，
 * 谁 import 它谁就得先有一个完整的 chrome 环境。`sync.ts` 只是想说一句"cookie 变了"，不该因此
 * 把整条 CDP 通道拖进来（测试里第一个撞上的就是这个：import 一下就 `chrome is not defined`）。
 *
 * 所以 socket 由 `driver.ts` 在连上/断开时登记到这里，说话的人只依赖这一个小模块。
 */

interface Sendable {
  send(data: string): void
}

/** 每条扩展绑定一条连接（design D7）；本机那条的 id 是 `local`。 */
const sockets = new Map<string, Sendable>()

/** `driver` 连上/断开时调。断开传 null。缺省 = 本机绑定。 */
export function setNotifySocket(s: Sendable | null, bindingId = 'local'): void {
  if (s) sockets.set(bindingId, s)
  else sockets.delete(bindingId)
}

/** 此刻连着的全部绑定（认领要经每一条都说一声，见 `claim.ts`）。 */
export function notifySockets(): Array<[string, Sendable]> {
  return [...sockets.entries()]
}

/**
 * 「同步域里的 cookie 变了，你要的话来取」——**只报事，不带值**。
 *
 * 这是 direct 档唯一还从扩展流向后端的东西，也是 quark `__puus` 这类轮换后能秒级自愈的那条
 * 信号：没有它，后端只能等到下一次采集才发现手里那份过期了，而那时它已经吃了一个 412。
 *
 * 中继没连就静默算了（返回 false）：后端下次连上会自己拉一次全量，这条通知只负责让"已经连着"
 * 的那段时间里也别落后。它绝不能因为 Stream 没起就抛。
 */
export function notifyCookiesChanged(domains: string[], bindingId = 'local'): boolean {
  const socket = sockets.get(bindingId)
  if (!socket) return false
  try {
    socket.send(JSON.stringify({ type: 'cookies-changed', domains }))
    return true
  } catch {
    return false
  }
}
