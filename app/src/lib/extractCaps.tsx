import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import { api, type Connection } from './api.ts'
import { extractable, NO_CAPS, type ExtractCapabilities } from './extract.ts'
import type { ConversionKindInfo, Item as StreamItem } from './types.ts'

/**
 * 「后端此刻能做哪几档转成文字」（`/api/conversion-kinds` 的分支可用性）——**一处 fetch，全树可读**。
 *
 * 为什么是 context 不是 prop：消费者是**右键菜单**（`ItemContextMenu`），它挂在时间线每一行和
 * 每一张卡片下面。走 prop 就得 App → PostFeed → PostItemRow/PostCard → 菜单一路传，中间每一层
 * 都得为一个自己不用的东西留个洞；而这份能力**全应用只有一份、一次 fetch 之后基本不变**，
 * 正是 context 的形状。
 *
 * 默认值是 `NO_CAPS`（全 false）：没有 Provider、或 fetch 还没回来时，「转成文字」**不出现**。
 * 宁可晚一拍出现，也别先亮出一个点了必失败的入口。
 */
const CapsCtx = createContext<ExtractCapabilities>(NO_CAPS)

export function ExtractCapsProvider({
  caps,
  children,
}: {
  caps: ExtractCapabilities
  children: React.ReactNode
}) {
  return <CapsCtx.Provider value={caps}>{children}</CapsCtx.Provider>
}

/**
 * 「这条能不能转成文字」的谓词。判定权威在 `shared/extract/plan.ts`（后端选分支用的同一份），
 * 这里只把此刻的 caps 喂给它——**别在调用点自己判 archetype**，那就是第二份判据。
 *
 * 返回的函数身份跟着 caps 走（`useMemo`），所以吃它的组件不会因为它每渲染换一个新函数而白重渲染。
 */
export function useCanExtract(): (item: StreamItem) => boolean {
  const caps = useContext(CapsCtx)
  return useMemo(() => (item: StreamItem) => extractable(item, caps), [caps])
}

/** `/api/conversion-kinds` 的回包 → 「转成文字」的三档分支可用性。抽成一个具名函数是因为
 *  读它的地方不止一处（主应用 App.tsx 一处、面板两个 React root 各一处）——三处各写各的
 *  `items.find(...)` 迟早会漏一档，而漏了的那档只是"按钮不出现"，没有任何一处会喊。 */
export function capsFromKinds(items: ConversionKindInfo[]): ExtractCapabilities {
  const branches = items.find((k) => k.kind === 'extract')?.branches
  return { stt: !!branches?.stt, ocr: !!branches?.ocr, article: !!branches?.article }
}

/** 能力发现此刻处在哪一档。**`loading` 和 `error` 必须和 `ready` 分得开**：三档画出来都可能是
 *  "按钮不出现"（caps 都可能是全 false），但只有 `ready` 那一档的全 false 才代表"后端确实
 *  做不了这条"。拿不出这个区分，就没法把一份**已知**的 caps 传给别的 React root 当种子——
 *  传一份"其实还没拉到"的全 false 过去，那棵树会把它当结论，按钮**永远**不出现。 */
export type ExtractCapsStatus = 'loading' | 'ready' | 'error'

/**
 * 拉一次能力发现，给**一棵 React 树**用。挂载时取一次（`/api/conversion-kinds` 就是一次
 * 能力发现，别 POST 试探 503，见 docs/API.md）。
 *
 * `seed`：调用方**已经拉到**的那一份。面板有两个独立的 React root（列表一棵、详情自己那份
 * bundle 一棵，见 `panel/detail-entry.tsx` 头注），两棵树都要这份 caps：列表那棵开页就拉了，
 * 详情那棵后开——把列表那份**已知**的结果当种子递进去，详情就不必自己再拉一次，也就没有
 * "按钮晚半拍才冒出来"的那一跳。种子只在 `ready` 那一档才递（见 `ExtractCapsStatus`）。
 *
 * 失败不缓存：这一棵树报 `error`，下次开详情那棵新树照样重拉。后端那会儿刚好没起来，
 * 不该让整个面板会话从此没有「转成文字」。
 */
export function useExtractCaps(
  conn: Connection,
  seed?: ExtractCapabilities,
): { caps: ExtractCapabilities; status: ExtractCapsStatus } {
  const [state, setState] = useState<{ caps: ExtractCapabilities; status: ExtractCapsStatus }>(
    () => (seed ? { caps: seed, status: 'ready' } : { caps: NO_CAPS, status: 'loading' }),
  )
  const baseUrl = conn.baseUrl
  useEffect(() => {
    if (seed) {
      setState({ caps: seed, status: 'ready' })
      return
    }
    let cancelled = false
    api.conversions
      .kinds(conn)
      .then((r) => {
        if (!cancelled) setState({ caps: capsFromKinds(r.items), status: 'ready' })
      })
      .catch(() => {
        // 拉不到 = 不知道后端能做什么 → 按钮不出现。宁可晚一拍/不出现，也别亮一个点了必失败的入口。
        if (!cancelled) setState({ caps: NO_CAPS, status: 'error' })
      })
    return () => {
      cancelled = true
    }
    // conn 是个可变的单例（applyBackend 会改它），按 baseUrl 认而不是按对象身份认。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, seed])
  return state
}
