/**
 * 「频道 / Stream / 空间的库存变了」这条通知在前端的唯一落点。
 *
 * **为什么要它**：改这份库存的入口不止网页上的按钮——对话里让 AI 去订阅一个源、改一个频道，
 * 走的是 MCP 工具，一个前端事件都不经过。没有这条通知，屏幕上的配置就停在打开那一刻，而且
 * **不报错**：用户会以为 AI 没做成，再做一遍。后端在 `UserStore` 的写路径上广播（见那边的
 * `onChange`），这里只管收。
 *
 * **为什么是一个模块级的总线，不是各自 `useWs`**：订阅者天生是多个且会同时在场——每个
 * `ChannelsProvider`（面板里音乐/影视/研究各补了一份）、面板自己的侧栏名录。各开各的
 * `useWs` 就是同一个页面开 N 条 WebSocket 收同一份广播。这里按 url 只开一条，引用计数归零
 * 才关。
 *
 * **连不上就安静降级**：`new WebSocket('/ws')` 在浏览器里是合法的（相对 document 解析），
 * 在 jsdom 里当场抛。同步失败不该把渲染这棵树的组件一起掀翻——同步没了只是"要手动刷一下"，
 * 而抛出去是整页白屏。
 */
import { selectTransport, type SocketHandle } from './transport.ts'

type Listener = () => void

interface Channel {
  listeners: Set<Listener>
  handle: SocketHandle | null
  /** 断线重连的退避计时器；关掉最后一个订阅者时要清掉。 */
  timer?: ReturnType<typeof setTimeout>
  closed: boolean
  retry: number
}

const channels = new Map<string, Channel>()

function connect(url: string, ch: Channel): void {
  let handle: SocketHandle | null = null
  try {
    handle = selectTransport().openSocket(url, {
      onOpen: () => { ch.retry = 1000 },
      onMessage: (data) => {
        let frame: unknown
        try { frame = JSON.parse(data) } catch { return }
        if ((frame as { type?: string } | null)?.type !== 'inventory') return
        for (const l of ch.listeners) l()
      },
      onClose: () => {
        if (ch.closed) return
        ch.timer = setTimeout(() => connect(url, ch), ch.retry)
        ch.retry = Math.min(ch.retry * 2, 15000)
      },
    })
  } catch {
    // 这条连不上（jsdom / 环境不支持）——安静降级成"不同步"，别掀翻调用方。不重连：
    // 抛出来的是环境问题，退避重试只会每隔几秒再抛一次。
    return
  }
  ch.handle = handle
}

/**
 * 订阅「库存变了」。返回退订函数。
 *
 * @param wsUrl `api.wsUrl(conn)` 的结果——同一个 url 的订阅者共用一条连接。
 */
export function subscribeInventory(wsUrl: string, listener: Listener): () => void {
  let ch = channels.get(wsUrl)
  if (ch === undefined) {
    ch = { listeners: new Set(), handle: null, closed: false, retry: 1000 }
    channels.set(wsUrl, ch)
    connect(wsUrl, ch)
  }
  ch.listeners.add(listener)
  return () => {
    const cur = channels.get(wsUrl)
    if (cur === undefined) return
    cur.listeners.delete(listener)
    if (cur.listeners.size > 0) return
    cur.closed = true
    if (cur.timer !== undefined) clearTimeout(cur.timer)
    cur.handle?.close()
    channels.delete(wsUrl)
  }
}
