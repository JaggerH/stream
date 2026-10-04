/**
 * 「这条引用该画成什么样」——按 id 去 Stream 后端取标题/来源/原文/封面。
 *
 * ## 为什么必须现取，而不是从消息里读
 *
 * 消息里那段字只有 `「标题」(item:<id>)`——标题是发送那一刻抄进去的，封面从来没进去过。
 * 而**把封面塞进工具回执是错的方向**：封面 URL 动辄几百字符（带签名），进回执就是拿模型
 * 上下文换像素，而那些回执的瘦身投影正是它们的命脉（`src/mcp/inbox-search.ts` 头注记着
 * 一次把上下文撑到 416K token 的事故）。所以走一条**只给渲染看**的路由：
 * `GET /api/items/refs?ids=`，模型一个 token 都不付。
 *
 * ## 缓存活在模块里，不在组件里
 *
 * 同一条会话里同一条内容常被引用多次，而聊天列是虚拟滚动的——组件反复挂载卸载。缓存放
 * 组件里等于每次滚回去都重新请求一轮。这份缓存**只增不减**：一次会话的引用是有限的几条，
 * 而失效重取带来的闪烁比一点内存贵。
 *
 * ## 取不到 ≠ 出错
 *
 * 引用可能指着一条已经被清掉的内容，也可能后端压根没配（工作台不带 `streamBaseUrl` 那一档）。
 * 两种都退回**纯文字标记**——那是这条路的正确降级形态，不是错误：文字里 id 还在，复制粘贴
 * 照样还原得回来。所以这里从不抛，也从不把失败画成红字。
 */
import { useEffect, useState } from 'react'
import { readBackendUrl } from '../backend.ts'

/** 一条引用的显示身份。与后端 `/api/items/refs` 同源（`src/http/app.ts`）。 */
export interface RefSnapshot {
  title: string
  source?: string
  url?: string
  poster?: string
}

/** id → 快照；`null` = 问过了，后端说没有（别再问第二遍）。 */
const cache = new Map<string, RefSnapshot | null>()
/** 正在飞的那一批，避免同一帧里十个 chip 各发一次请求。 */
const inflight = new Map<string, Promise<void>>()
/** 缓存变了要重画谁。 */
const listeners = new Set<() => void>()

/** 只给测试用：清干净模块级状态，否则用例之间会互相看到对方的缓存。 */
export function __resetRefSnapshots(): void {
  cache.clear()
  inflight.clear()
}

async function load(ids: string[]): Promise<void> {
  const backend = readBackendUrl()
  // 后端地址没下发 → 这条路本来就走不通，记成「没有」而不是反复重试。
  if (backend === undefined) {
    for (const id of ids) cache.set(id, null)
    return
  }
  try {
    const res = await fetch(`${backend.replace(/\/+$/, '')}/api/items/refs?ids=${ids.map(encodeURIComponent).join(',')}`)
    const body = res.ok ? ((await res.json()) as { refs?: Record<string, RefSnapshot> }) : { refs: {} }
    for (const id of ids) cache.set(id, body.refs?.[id] ?? null)
  } catch {
    // 网络抖了：记成「没有」，退回纯文字。不重试——这一格是锦上添花，不值得为它排队。
    for (const id of ids) cache.set(id, null)
  }
  for (const fn of listeners) fn()
}

/**
 * 读一条引用的显示身份。
 * @param id - 引用里那个句柄。
 * @returns 拿到了 → 快照；还没拿到 / 后端说没有 → `undefined`（调用方退回纯文字）。
 */
export function useRefSnapshot(id: string): RefSnapshot | undefined {
  const [, bump] = useState(0)
  useEffect(() => {
    const rerender = () => bump((n) => n + 1)
    listeners.add(rerender)
    if (!cache.has(id) && !inflight.has(id)) {
      const p = load([id]).finally(() => inflight.delete(id))
      inflight.set(id, p)
    }
    return () => { listeners.delete(rerender) }
  }, [id])
  return cache.get(id) ?? undefined
}
