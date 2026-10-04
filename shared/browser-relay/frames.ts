/**
 * 一张标签里的 **iframe**——读它、清点它、在它里面点。
 *
 * 为什么需要单独一层：`Runtime.evaluate` 不带 `contextId` 只在**顶层文档**里跑，
 * `Input.dispatchMouseEvent` 的坐标也只认顶层视口。于是 iframe 里的按钮在清单里看不见、选择器
 * 查不到、坐标对不上——而这三种失败都**不报错**，只是"页面上没有"。
 *
 * 一张标签里的 frame 分两种，够到它们的路不一样：
 *
 * | 哪种 frame | 在哪个 CDP 会话里 | 怎么在里面跑 JS |
 * |---|---|---|
 * | 顶层文档 | tab 主会话 | 直接 `Runtime.evaluate` |
 * | 同进程 iframe（同站，含同站跨源：`a.qq.com` 里嵌 `b.qq.com`） | 它所在会话的 `Page.getFrameTree` 里 | `Page.createIsolatedWorld({frameId})` 拿一个执行上下文，再带 `contextId` 求值 |
 * | 跨站 iframe（OOPIF：另一个渲染进程） | **它自己的子会话**（扩展 `Target.setAutoAttach` flatten 挂上） | 在子会话里直接 `Runtime.evaluate`（子会话的主 frame 就是它） |
 *
 * 同进程 iframe 里的 JS 跑在**隔离世界**：DOM 是同一份，页面自己的 JS 全局变量看不见。清单、点击、
 * 读 DOM 都不受影响；要读页面 JS 状态（`window.__APP__` 之类）只在顶层与 OOPIF 里行得通。
 *
 * **输入永远打给 tab 主会话、用顶层视口坐标。** 浏览器按顶层坐标做命中测试，再把事件路由进对应
 * 的 frame（含 OOPIF）。所以在 frame 里读到的矩形要加上这个 frame 在顶层视口里的位置——位置由
 * `DOM.getFrameOwner` + `DOM.getBoxModel` 在**父 frame 的会话**里量（同一会话内的盒模型坐标本来就
 * 相对该会话的根视口，只有跨会话那一跳要手动累加）。
 */
import type { ExtRawPage, RawPageOptions, RawPageRelay } from './ext-page.ts'
import type { FrameSession } from './relay.ts'
import { inventoryExpression, inventorySeqExpression, REF_ATTRIBUTE } from './page-inventory.ts'

export interface FrameRelay extends RawPageRelay {
  frameSessions(tabId: number): Promise<FrameSession[]>
}

/** 一个 frame。`sessionId` 缺席 = 在 tab 主会话里。 */
export interface FrameInfo {
  id: string
  url: string
  name?: string
  /** 父 frame；顶层文档没有。 */
  parentId?: string
  sessionId?: string
  /** 它是自己那条会话的主 frame（顶层文档、或一个 OOPIF）——求值不用建隔离世界。 */
  root: boolean
}

interface FrameTreeNode {
  frame: { id: string; parentId?: string; url: string; name?: string; urlFragment?: string }
  childFrames?: FrameTreeNode[]
}

/** 隔离世界的名字。同名反复建，Chrome 在同一个 frame 上复用同一个世界。 */
const WORLD_NAME = 'stream-frames'

const send = (relay: RawPageRelay, tabId: number, method: string, params: unknown, sessionId?: string, expectDomain?: string) =>
  relay.sendCommand(tabId, method, params, expectDomain, sessionId)

/**
 * 列出这张标签里的全部 frame，**顶层在第一个**，其余按树的先序。
 *
 * OOPIF 在父会话的树里也露一个占位（没有子树），真身在它自己的子会话里——两处按 frame id 合并：
 * 父子关系取占位那一份（子会话里它是根、不知道自己的父），归属会话取子会话。
 *
 * 旧扩展不认 `frames` 这个 op → 只列主会话那棵树（同进程 iframe 照样够得到，OOPIF 够不到——
 * 那一档该升级扩展，不是静默装作没有）。
 */
export async function listFrames(relay: FrameRelay, tabId: number): Promise<FrameInfo[]> {
  const sessions = await relay.frameSessions(tabId).catch(() => [] as FrameSession[])
  const ownerOf = new Map(sessions.map((s) => [s.targetId, s.sessionId]))
  type Acc = { id: string; url: string; name?: string; parentId?: string }
  const byId = new Map<string, Acc>()
  const order: string[] = []
  const walk = (node: FrameTreeNode, sessionId: string | undefined): void => {
    const f = node.frame
    let acc = byId.get(f.id)
    if (!acc) {
      acc = { id: f.id, url: '' }
      byId.set(f.id, acc)
      order.push(f.id)
    }
    // 父子关系谁知道谁给（OOPIF 在自己的子会话里是根，只有父会话里那个占位知道它的父）；
    // URL / name 以真身所在的会话为准，占位那份只在还没有更好的时候先垫上。
    if (f.parentId) acc.parentId = f.parentId
    const isOwnerWalk = !ownerOf.has(f.id) || ownerOf.get(f.id) === sessionId
    if (isOwnerWalk || !acc.url) {
      acc.url = (f.url ?? '') + (f.urlFragment ?? '')
      if (f.name) acc.name = f.name
    }
    for (const c of node.childFrames ?? []) walk(c, sessionId)
  }
  const main = (await send(relay, tabId, 'Page.getFrameTree', {})) as { frameTree: FrameTreeNode }
  walk(main.frameTree, undefined)
  for (const s of sessions) {
    try {
      const t = (await send(relay, tabId, 'Page.getFrameTree', {}, s.sessionId)) as { frameTree: FrameTreeNode }
      walk(t.frameTree, s.sessionId)
    } catch {
      /* 子会话刚好在这时断了（iframe 被移除/导航走）——少列它一个，不整张失败 */
    }
  }
  // 归属会话：OOPIF 归它自己的子会话；其余 frame 跟着父 frame 走（同进程 iframe 与父同一会话）。
  const sessionOf = (id: string, depth = 0): string | undefined => {
    const own = ownerOf.get(id)
    if (own) return own
    const p = byId.get(id)?.parentId
    return p && depth < 32 ? sessionOf(p, depth + 1) : undefined
  }
  return order.map((id) => {
    const a = byId.get(id)!
    const sessionId = sessionOf(id)
    return {
      id: a.id,
      url: a.url,
      ...(a.name ? { name: a.name } : {}),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      root: !a.parentId || ownerOf.has(id),
    }
  })
}

/**
 * 按调用方给的 `frame` 认出一个 frame：先按 frame id 全等，再按 URL **包含**匹配。
 * 包含匹配命中多个 → 报错并列出候选，不擅自挑一个（点错 frame 比报错糟得多）。
 */
export function resolveFrame(frames: FrameInfo[], want: string): FrameInfo {
  const exact = frames.find((f) => f.id === want)
  if (exact) return exact
  const hits = frames.filter((f) => f.url.includes(want))
  if (hits.length === 1) return hits[0]!
  const list = frames.map((f) => `${f.id} ${f.url}`).join('; ')
  if (hits.length === 0) throw new Error(`frame '${want}' 没有命中任何 frame（按 frame id 全等或 URL 包含）。现有：${list}`)
  throw new Error(`frame '${want}' 命中 ${hits.length} 个 frame，不擅自挑——给 frame id：${hits.map((f) => `${f.id} ${f.url}`).join('; ')}`)
}

/** 在一个 frame 里求值（拆包 + 页内异常照实冒出来，同 `makeExtRawPage`）。 */
async function evalIn(
  relay: RawPageRelay,
  tabId: number,
  f: FrameInfo,
  expression: string,
  expectDomain?: string,
): Promise<unknown> {
  const params: Record<string, unknown> = { expression, awaitPromise: true, returnByValue: true }
  if (!f.root) {
    const w = (await send(relay, tabId, 'Page.createIsolatedWorld', { frameId: f.id, worldName: WORLD_NAME }, f.sessionId)) as {
      executionContextId?: number
    }
    if (typeof w?.executionContextId !== 'number') throw new Error(`frame ${f.id}：建不出执行上下文（frame 可能刚被移除）`)
    params.contextId = w.executionContextId
  }
  const res = await send(relay, tabId, 'Runtime.evaluate', params, f.sessionId, expectDomain)
  if (res?.exceptionDetails) {
    const d = res.exceptionDetails
    throw new Error(d.exception?.description ?? d.text ?? 'in-frame evaluate threw')
  }
  return res?.result?.value
}

/**
 * 这个 frame 的视口原点在**顶层视口**里的位置。顶层 = (0,0)。
 *
 * 一跳 = 在父 frame 的会话里量 `<iframe>` 元素的内容盒。同一会话里的盒模型坐标相对该会话的根
 * 视口，所以只有跨会话（进入一个 OOPIF）时才要把父会话根的偏移加上去。
 */
export async function frameOffset(relay: RawPageRelay, tabId: number, frames: FrameInfo[], f: FrameInfo): Promise<{ x: number; y: number }> {
  if (!f.parentId) return { x: 0, y: 0 }
  const parent = frames.find((p) => p.id === f.parentId)
  if (!parent) throw new Error(`frame ${f.id} 的父 frame ${f.parentId} 不在清单里`)
  const owner = (await send(relay, tabId, 'DOM.getFrameOwner', { frameId: f.id }, parent.sessionId)) as { backendNodeId?: number }
  if (typeof owner?.backendNodeId !== 'number') throw new Error(`frame ${f.id}：量不到它的 <iframe> 元素`)
  const box = (await send(relay, tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, parent.sessionId)) as {
    model?: { content?: number[] }
  }
  const q = box?.model?.content
  if (!q || q.length < 2) throw new Error(`frame ${f.id}：<iframe> 没有盒模型（不可见？）`)
  // 父 frame 所在会话的根：同会话内坐标已相对它；它本身若是 OOPIF，再往上累加。
  const sessionRoot = parent.sessionId
    ? frames.find((r) => r.root && r.parentId && r.sessionId === parent.sessionId)
    : undefined
  const base = sessionRoot ? await frameOffset(relay, tabId, frames, sessionRoot) : { x: 0, y: 0 }
  return { x: base.x + q[0]!, y: base.y + q[1]! }
}

/**
 * 一个 frame 的 {@link ExtRawPage}：求值落在这个 frame 里，其余 CDP 命令（输入、截图、导航）打给
 * tab 主会话；**鼠标事件的坐标自动加上 frame 偏移**——driver 照常用 frame 自己的
 * `getBoundingClientRect()` 算点，不必知道自己在 iframe 里。
 *
 * 键盘事件不用换算：焦点由 `el.focus()` 在 frame 里设好，浏览器把按键路由给获得焦点的 frame。
 */
export function makeFrameRawPage(
  relay: RawPageRelay,
  tabId: number,
  frames: FrameInfo[],
  f: FrameInfo,
  expectDomain?: string,
  opts: RawPageOptions = {},
): ExtRawPage {
  let offset: Promise<{ x: number; y: number }> | null = null
  const off = () => (offset ??= frameOffset(relay, tabId, frames, f))
  return {
    tabId,
    evalExpr: async <T>(expression: string, o?: { unguarded?: boolean }): Promise<T> =>
      (await evalIn(relay, tabId, f, expression, opts.guardEvals && o?.unguarded !== true ? expectDomain : undefined)) as T,
    cdp: async (method: string, params?: unknown): Promise<unknown> => {
      if (method === 'Input.dispatchMouseEvent' && params && typeof params === 'object') {
        const p = params as { x?: number; y?: number }
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          const o = await off()
          params = { ...p, x: Math.round(p.x + o.x), y: Math.round(p.y + o.y) }
        }
      }
      if (method.startsWith('DOM.') || method === 'Page.navigate') {
        // 这几条在主会话上会作用到**顶层文档**，而调用方以为自己在 frame 里——静默落错地方比报错糟。
        throw new Error(`${method} 不支持在 iframe 里用（会落到顶层文档上）`)
      }
      return relay.sendCommand(tabId, method, params ?? {}, expectDomain)
    },
  }
}

/** 清单里的一条（与 `inventoryExpression` 的产出同形，多一个 `frame`）。 */
interface InvItem {
  n: number
  rect: { x: number; y: number; w: number; h: number }
  frame?: string
  [k: string]: unknown
}

/**
 * 跨 frame 的元素清单：每个 frame 各清点一遍，编号在**整张标签内唯一**，iframe 里的条目带
 * `frame`（frame id）且 `rect` 换算到顶层视口。
 *
 * 编号怎么做到全 tab 唯一：先问每个 frame 已经发到几号，取最大当下限，再逐个 frame 往上发。
 * 已有编号的元素沿用原号（`data-stream-el` 属性还在），新元素的号一定大于任何 frame 里已有的号。
 * 于是 `ref` 不带 frame 也能定位——全 tab 只有一个元素带那个号。
 *
 * 一个 frame 清点失败（刚被移除、about:blank 还没载完）→ 记在 `frames[i].error`，不整张失败。
 */
export async function inventoryAcrossFrames(relay: FrameRelay, tabId: number, maxItems = 200): Promise<unknown> {
  const frames = await listFrames(relay, tabId)
  let floor = 0
  for (const f of frames) {
    const s = await evalIn(relay, tabId, f, inventorySeqExpression()).catch(() => 0)
    if (typeof s === 'number' && s > floor) floor = s
  }
  const items: InvItem[] = []
  let truncated = false
  let top: { url?: string; title?: string } = {}
  const listed: Array<{ id: string; url: string; name?: string; oopif: boolean; count?: number; error?: string }> = []
  for (const f of frames) {
    const entry: (typeof listed)[number] = { id: f.id, url: f.url, ...(f.name ? { name: f.name } : {}), oopif: !!f.sessionId }
    listed.push(entry)
    try {
      const r = (await evalIn(relay, tabId, f, inventoryExpression({ floor, maxItems: Math.max(0, maxItems - items.length) }))) as {
        url?: string
        title?: string
        items?: InvItem[]
        truncated?: boolean
        seq?: number
        __error?: string
      } | null
      if (!r || r.__error) throw new Error(r?.__error ?? 'no result')
      if (!f.parentId) top = { url: r.url, title: r.title }
      if (typeof r.seq === 'number' && r.seq > floor) floor = r.seq
      if (r.truncated) truncated = true
      const own = r.items ?? []
      entry.count = own.length
      if (f.parentId && own.length) {
        const o = await frameOffset(relay, tabId, frames, f)
        for (const it of own) {
          items.push({ ...it, frame: f.id, rect: { ...it.rect, x: Math.round(it.rect.x + o.x), y: Math.round(it.rect.y + o.y) } })
        }
      } else items.push(...own)
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e)
    }
  }
  return {
    url: top.url ?? frames[0]?.url,
    title: top.title,
    count: items.length,
    truncated,
    items,
    // 只有一个 frame 时不带这一格——那是绝大多数页面，多出来的字段只会让清单更难读。
    ...(listed.length > 1 ? { frames: listed } : {}),
  }
}

/**
 * `ref:<n>` 在哪个 frame：逐个 frame 问一句"你有这个号吗"。
 * 0 个 → 顶层（让后面的点击照常回 `not-found`）；多于 1 个 → 报错（编号撞了，别猜）。
 */
export async function frameOfRef(relay: FrameRelay, tabId: number, frames: FrameInfo[], ref: number): Promise<FrameInfo> {
  const expr = `!!document.querySelector(${JSON.stringify(`[${REF_ATTRIBUTE}="${ref}"]`)})`
  const hits: FrameInfo[] = []
  for (const f of frames) {
    if (await evalIn(relay, tabId, f, expr).catch(() => false)) hits.push(f)
  }
  if (hits.length > 1) {
    throw new Error(`ref ${ref} 在 ${hits.length} 个 frame 里都有（${hits.map((f) => f.url).join('; ')}）——重新要一次清单再点`)
  }
  return hits[0] ?? frames[0]!
}

/** 在指定 frame 里求值（`cdp_look({frame})`）。 */
export async function evalInFrame(relay: FrameRelay, tabId: number, frame: string, expression: string): Promise<unknown> {
  const frames = await listFrames(relay, tabId)
  return evalIn(relay, tabId, resolveFrame(frames, frame), expression)
}
