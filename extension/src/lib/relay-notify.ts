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

let socket: Sendable | null = null

/** `driver` 连上/断开时调。断开传 null。 */
export function setNotifySocket(s: Sendable | null): void {
  socket = s
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
export function notifyCookiesChanged(domains: string[]): boolean {
  if (!socket) return false
  try {
    socket.send(JSON.stringify({ type: 'cookies-changed', domains }))
    return true
  } catch {
    return false
  }
}
