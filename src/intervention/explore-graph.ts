import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { facilityFileName } from '../replay/observation-ledger.ts'
import type { StateDef, StateId } from '../replay/state-graph.ts'

export interface InventoryItem { n: number; tag?: string; role?: string; name?: string; href?: string; rect: { x: number; y: number; w: number; h: number } }
export interface FrontierItem { ref: number; tag?: string; role?: string; name?: string; href?: string; rect: InventoryItem['rect']; selector: string }
/** `noop` 点了没变；`reversible` 变了且退得回；`one-way` 变了退不回——下游不展开（spec §5.2）。 */
export type EdgeEffect = 'noop' | 'reversible' | 'one-way'
export interface DraftTransition { from: StateId; to?: StateId; steps: unknown[]; effect: EdgeEffect; via: FrontierItem }

/**
 * 一次探索的草稿图（spec §5.5）。**按选择器记「点过 / 拉黑」，不按 ref**：编号是页内会话级的
 * 脚手架，页面一刷新全作废；选择器才是能跨轮次比对的键。
 */
export interface ExploreDraft {
  version: 1
  runId: string
  facility: string
  side: 'browser'
  target: string
  goal: string
  states: StateDef[]
  transitions: DraftTransition[]
  visited: Record<StateId, string[]>
  blocked: Record<StateId, string[]>
  frozen: StateId[]
  irrelevant: StateId[]
  remaining: Record<StateId, number>
  depth: Record<StateId, number>
  /** 起点：第一个被记进草稿（depth 0）的状态。它按构造永远没有入边，one-way 判据不能把它当"没到过"。 */
  start?: StateId
}

export function newDraft(i: { runId: string; facility: string; target: string; goal: string }): ExploreDraft {
  return { version: 1, runId: i.runId, facility: i.facility, side: 'browser', target: i.target, goal: i.goal, states: [], transitions: [], visited: {}, blocked: {}, frozen: [], irrelevant: [], remaining: {}, depth: {} }
}

/** 会话在给第一个状态起名时调用；之后 `recordAct` 首次给某状态记 depth 0 会自动兜底设置。 */
export function setStart(d: ExploreDraft, state: StateId): ExploreDraft {
  return d.start === undefined ? { ...d, start: state } : d
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * 运行期重放得了的选择器。href 去掉 origin 与 hash（同一站换域名 / 带锚点仍是同一个入口）；
 * 名字走 aria-label / title 两条（inventory 的 name 就是从这两处与文本里取的）。
 * 都落不到 → undefined，调用方**不把它放进 frontier**：探出一条运行期找不到的边等于没探。
 */
export function stableSelector(item: InventoryItem): string | undefined {
  if (item.href) {
    try {
      const u = new URL(item.href, 'https://placeholder.invalid')
      const path = `${u.pathname}${u.search}`
      if (path && path !== '/') return `a[href*="${esc(path)}"]`
    } catch { /* 不是合法 URL，走下面 */ }
  }
  if (item.name) {
    const head = item.role ? `[role="${esc(item.role)}"]` : item.tag && item.tag !== 'div' && item.tag !== 'span' ? item.tag : undefined
    if (head) return `${head}[aria-label="${esc(item.name)}"], ${head}:is([title="${esc(item.name)}"])`
  }
  return undefined
}

export function frontierOf(draft: ExploreDraft, state: StateId, items: InventoryItem[]): FrontierItem[] {
  const seen = new Set([...(draft.visited[state] ?? []), ...(draft.blocked[state] ?? [])])
  const out: FrontierItem[] = []
  for (const it of items) {
    const selector = stableSelector(it)
    if (!selector || seen.has(selector)) continue
    seen.add(selector)   // 同一屏两个元素解出同一个选择器：只留第一个，点第二个和点第一个是同一件事
    out.push({ ref: it.n, ...(it.tag ? { tag: it.tag } : {}), ...(it.role ? { role: it.role } : {}), ...(it.name ? { name: it.name } : {}), ...(it.href ? { href: it.href } : {}), rect: it.rect, selector })
  }
  return out
}

export function noteFrontier(draft: ExploreDraft, state: StateId, frontier: FrontierItem[]): ExploreDraft {
  return { ...draft, remaining: { ...draft.remaining, [state]: frontier.length } }
}

const push = (m: Record<string, string[]>, k: string, v: string): Record<string, string[]> =>
  ({ ...m, [k]: [...new Set([...(m[k] ?? []), v])] })

export function recordAct(draft: ExploreDraft, i: { from: StateId; to: StateId | undefined; via: FrontierItem; effect: EdgeEffect; backSteps?: unknown[] }): ExploreDraft {
  let d: ExploreDraft = { ...draft, visited: push(draft.visited, i.from, i.via.selector) }
  d.remaining = { ...d.remaining, [i.from]: Math.max(0, (d.remaining[i.from] ?? 1) - 1) }
  if (i.effect === 'noop' || !i.to) return d
  // 声明 reversible 但没给回路 → 没有回路就不是可逆，降级记成 one-way（spec §5.2）
  const effect: EdgeEffect = i.effect === 'reversible' && !i.backSteps ? 'one-way' : i.effect
  const forward: DraftTransition = { from: i.from, to: i.to, steps: [{ do: 'click', selector: i.via.selector }], effect, via: i.via }
  const transitions = [...d.transitions, forward]
  if (effect === 'reversible' && i.backSteps) transitions.push({ from: i.to, to: i.from, steps: i.backSteps, effect: 'reversible', via: i.via })
  const depth = { ...d.depth }
  const fromDepth = depth[i.from] ?? 0
  if (depth[i.to] === undefined || depth[i.to]! > fromDepth + 1) depth[i.to] = fromDepth + 1
  const fromWasUnset = depth[i.from] === undefined
  if (fromWasUnset) depth[i.from] = 0
  d = { ...d, transitions, depth }
  // 首次给某状态记 depth 0 又没人显式起过点：兜底把它当起点（起点按构造永远没有入边）
  if (fromWasUnset && d.start === undefined) d = { ...d, start: i.from }
  return d
}

/** `one-way` 边的目的地：不展开（spec §5.2 第三道闸）——但已证实可达的状态（起点 / 曾作为 from 探过 / 有 reversible 入边）不算。 */
function oneWayTargets(d: ExploreDraft): Set<StateId> {
  const provenReachable = new Set<StateId>()
  if (d.start !== undefined) provenReachable.add(d.start)
  for (const t of d.transitions) {
    provenReachable.add(t.from)
    if (t.effect === 'reversible' && t.to) provenReachable.add(t.to)
  }
  return new Set(d.transitions.filter((t) => t.effect === 'one-way' && t.to && !provenReachable.has(t.to)).map((t) => t.to!))
}

/** 探够了 = 每个已知状态都「列过且剩 0」，或者本来就不该展开（frozen / irrelevant / one-way 下游）。 */
export function isExhausted(d: ExploreDraft): boolean {
  const skip = new Set([...d.frozen, ...d.irrelevant, ...oneWayTargets(d)])
  for (const s of d.states) {
    if (skip.has(s.id)) continue
    const r = d.remaining[s.id]
    if (r === undefined || r > 0) return false
  }
  return true
}

export function draftPath(dir: string, facility: string, runId: string): string {
  return join(dir, `${facilityFileName(facility)}.explore-${runId}.json`)
}
export function readDraft(path: string): ExploreDraft | undefined {
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) as ExploreDraft } catch { return undefined }
}
export function writeDraft(path: string, d: ExploreDraft): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(d, null, 2))
  renameSync(tmp, path)
}
