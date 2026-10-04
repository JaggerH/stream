import { Deduper } from './dedupe.ts'
import type { SearchGroup } from './search-groups.ts'
import type { VideoPart, VideoSearchEvent, VideoSourceTiming } from './types.ts'

/** 一个源跑完之后**它自己知道的那部分**：抓到了什么、花了多久、什么状态。
 *  刻意不含 `key`/`label`——**身份不归下游**，见 `videoSearchStream` 的头注。 */
export type SourceOutcome = { part: VideoPart; timing: Omit<VideoSourceTiming, 'key' | 'label'> }

/** 流式搜索需要的三个协作者，窄到「只有这三个方法」——单测能用假身驱动整段 generator，
 *  不必开库、装插件、起容器（真身在 bootstrap 里接线：Provider 行展开 / 源元数据 / 单组抓取）。 */
export interface SearchStreamDeps {
  /** Provider 行 → 扇出成员（`./search-groups.ts`）。`providerId` 的兜底行名归它管，
   *  这里只负责**原样转发**——见 search-stream.test.ts 的承重条。 */
  resourceSearchGroups(providerId?: string): SearchGroup[]
  /** source_id → 展示元数据；未登记的源返回 undefined，调用方退回 source_id 自身。 */
  searchMetaBySourceId(sourceId: string): { key: string; label: string; searchUrl?: (q: string) => string } | undefined
  /** 跑一个 group（一个源的合并物理请求 → extract → aggregate）。永不 reject。 */
  searchOneGroup(group: SearchGroup, q: string, deduper: Deduper): Promise<SourceOutcome>
}

/** generator 自己的活性上限。这是**兜底**不是主超时——单源超时归 `searchOneGroup` 内部
 *  （bootstrap 的 15s/源，慢源在 manifest 的 `member_timeout_ms` 自报更长的）。留这一道
 *  是因为「会不会一直等下去」不该外包给依赖的自觉：依赖哪天漏了一条不 settle 的路径，塌的是
 *  整个流式搜索，而不只是那一个源。
 *
 *  **它必须大于任何单源上限**：预算先到的话，那个源每次都被记成 timeout，而它自报的
 *  `timeoutMs` 一次都不生效——不报错，只表现成"这个源永远搜不到"。 */
export const DEFAULT_BUDGET_MS = 30_000

/** Streamed search: emit `init` (source list) immediately, then one `source`
 *  event per source as it completes (completion order — fastest first), then
 *  `done`. Lets the UI show progress and stream results in. Members come from the
 *  Provider row named by `opts.providerId` (resourceSearchGroups), defaulting to
 *  `resource-search` — same row the batch path invokes. The caller (HTTP layer)
 *  resolves the `search.resources` slot first so a channel override changes the fan-out.
 *
 *  **身份归上层，只有一份。** `init` 那一步建的 `tracked` 表就是这次搜索唯一的跟踪标的：
 *  行号（下标）是内部身份，`key`/`label` 是对外展示名，两者都在这里一次算定。派活时记下标、
 *  回来按下标销号，下游只报数不报名。这不是洁癖，是把两类故障从**可能**变成**不可能**：
 *   - 「建表的名字」和「销号的名字」对不上 → 永远销不掉 → `while (pending.size)` 对着已 resolve
 *     的 promise 反复 `Promise.race`，微任务把宏任务饿死。故障形态是**整个后端进程 OOM**（实测
 *     90–134s 崩堆），不报错、不超时——连 vitest 的 15s 超时都触发不了，因为超时靠宏任务。
 *   - 两个源的展示名撞车（meta 表配重了）→ 拿 key 当 Map 键时后一条覆盖前一条 → 一个源跑完了
 *     结果被**静默吞掉**，界面上就是少一个源，同样不报错。
 *  这两条以前都靠「三处独立查同一个 meta 碰巧算出同样结果」挡着。巧合不是不变量。 */
export async function* videoSearchStream(
  deps: SearchStreamDeps,
  q: string,
  opts: { nsfw?: boolean; providerId?: string; budgetMs?: number } = {}
): AsyncGenerator<VideoSearchEvent> {
  const groups = deps.resourceSearchGroups(opts.providerId)
  const tracked = groups.map((g, idx) => {
    const meta = deps.searchMetaBySourceId(g.source_id)
    return {
      idx,
      group: g,
      key: meta?.key ?? g.source_id,
      label: meta?.label ?? g.source_id,
      searchUrl: meta?.searchUrl?.(q),
    }
  })
  yield { type: 'init', sources: tracked.map(({ key, label, searchUrl }) => ({ key, label, searchUrl })) }

  // 流式路：一个 Deduper 跨所有源，按到达顺序去重（先到先得）。要按 Provider 声明
  // 优先级去重就得等齐所有源，那就废掉了流式的意义。
  const deduper = new Deduper()
  const pending = new Map(
    tracked.map((s) => [s.idx, deps.searchOneGroup(s.group, q, deduper).then((r) => ({ idx: s.idx, ...r }))])
  )
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs)
  })
  try {
    while (pending.size) {
      const done = await Promise.race([...pending.values(), expired])
      if (done === 'expired') break
      pending.delete(done.idx)
      const s = tracked[done.idx]!
      yield { type: 'source', key: s.key, part: done.part, timing: { ...done.timing, key: s.key, label: s.label } }
    }
    // 到点还没回来的：按 timeout 如实发出去就收工。**不接着等**——下游那几个 promise 跑完也
    // 没人接了，让它们自然凋亡即可（消费方中途丢弃这个 generator 时同理，finally 照样清定时器）。
    for (const idx of pending.keys()) {
      const s = tracked[idx]!
      yield {
        type: 'source',
        key: s.key,
        part: { shows: [], loose: [] },
        timing: { key: s.key, label: s.label, ms: budgetMs, count: 0, dropped: 0, status: 'timeout' },
      }
    }
  } finally {
    clearTimeout(timer)
  }
  yield { type: 'done' }
}
