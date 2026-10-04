/**
 * dev 期的「改完自己重载」通道——**带重连的那一份**。
 *
 * WXT 的 dev 构建本来就带一个连 dev server 的 socket，收到 `wxt:reload-extension` 就
 * `chrome.runtime.reload()`。问题是它**断了不重连**：socket 关掉只打一行日志，然后就一直空着，
 * 等下一次 service worker 重启才会重新连上。
 *
 * 一般扩展没事——MV3 的 SW 闲置几十秒就被回收，下次事件唤醒时自然重连。**但 Stream 这个扩展
 * 不一样：它对后端常驻一条 relay WS，SW 因此永远不被回收**，于是「等 SW 重启」这条自愈路径
 * 根本不会发生。实际表现是：`pnpm dev` 一重启（dev server 换了一个进程），热重载就此静默失效，
 * 而且什么都不报——你以为改动生效了，其实浏览器里跑的还是上一版。2026-08-02 活体撞到。
 *
 * 所以这里自己开一条同款 socket，唯一的区别是**关了就退避重连**。两条 socket 同时收到同一条
 * 消息只会 reload 两次，而 reload 是幂等的，不需要去重。
 *
 * 端口写死 5279 = `wxt.config.ts` 的 `dev.server.port`（改那边就要改这里；不一致的表现同样是
 * 静默失效，所以两处都留了指回对方的注释）。
 *
 * 整块只在 dev 构建里存在：调用点用 `import.meta.env.DEV` 守着，生产构建里被静态消除。
 */
const DEV_SERVER_WS = 'ws://localhost:5279'
const RETRY_MS = 2_000

export function keepDevReloadAlive(connectWs: (url: string, protocol: string) => WebSocket = (u, p) => new WebSocket(u, p)): void {
  const connect = (): void => {
    let ws: WebSocket
    try {
      ws = connectWs(DEV_SERVER_WS, 'vite-hmr')
    } catch {
      setTimeout(connect, RETRY_MS) // dev server 没起——过会儿再试，别把 SW 弄挂
      return
    }
    ws.addEventListener('message', (e: MessageEvent) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type?: string; event?: string }
        if (msg.type === 'custom' && msg.event === 'wxt:reload-extension') chrome.runtime.reload()
      } catch {
        /* 不是我们认识的消息——HMR 通道上什么都可能来，忽略 */
      }
    })
    // close 与 error 都退避重连；error 之后一定还会来 close，所以只在 close 上排重连，不排两次。
    ws.addEventListener('close', () => setTimeout(connect, RETRY_MS))
    ws.addEventListener('error', () => {
      try {
        ws.close()
      } catch {
        /* 已经关了 */
      }
    })
  }
  connect()
}
