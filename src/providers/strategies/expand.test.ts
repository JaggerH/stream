import { describe, it, expect, vi, afterEach } from 'vitest'
import { expandStrategy, EXPAND_TOTAL_BUDGET_MS } from './expand.ts'
import type { StrategyContext, StrategyMemberView, StrategySourceCall } from './types.ts'
import type { MemberOutcome } from '../member-pipeline.ts'
import type { ProviderRecord } from '../../store/types.ts'
import { sourceOf } from '../invoke-types.ts'

/** 行 fixture：A = 壳列表，B = 逐壳钻取；map 把 A-item 的 detailUrl 喂给 B，assemble 把 B-item 装成 link。 */
function row(over: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'exp', label: '', description: '', category: 'search', serves: ['k'], strategy: 'expand',
    members: [{ source: 'a-src' }, { source: 'b-src' }], contract: null, options: {},
    expand: { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } },
    ...over,
  }
}

/** 这一套替身共用的 ctx.input（= 真执行器传给策略的那个 input）。管道替身回落到它、`ctx()` 也用它——
 *  硬写字面量会在改 fixture input 时假绿（策略明明没把 input 递下去，测试照样过）。 */
const CTX_INPUT = 'q'

/** sourceId → 行为的分派表（替身取数）。 */
type Table = Record<string, (input: unknown, params?: Record<string, unknown>) => Promise<unknown[] | null>>

/** 执行器那一半的替身：把声明式 source 描述照 `executor.strategyContext` 的口径构造成取数
 *  （empty:'decline' → 空批归 null；empty:'ok' → 空批照回 `[]`）。 */
function fetchFor(table: Table, m: StrategyMemberView, src: StrategySourceCall, input: unknown) {
  return async (): Promise<unknown | null> => {
    const b = table[m.sourceId]
    if (!b) throw new Error(`no behavior for ${m.sourceId}`)
    const r = await b(src.input !== undefined ? src.input : input, src.params)
    if (src.empty === 'ok') return Array.isArray(r) ? r : []
    if (r == null) return null
    return Array.isArray(r) ? (r.length ? r : null) : r
  }
}

/** 真管道的替身：跑构造出来的取数，非空 → win，null → miss，抛 → error。timeoutMs 覆盖原样记下来供断言。 */
function realRun(table: Table, seen?: { timeoutMs: Array<number | undefined> }) {
  return async (m: StrategyMemberView, opts?: { timeoutMs?: number; source?: StrategySourceCall }): Promise<MemberOutcome> => {
    seen?.timeoutMs.push(opts?.timeoutMs)
    if (!opts?.source) throw new Error(`expand 必须自带 source 描述（成员 ${m.name}）`)
    try {
      const v = await fetchFor(table, m, opts.source, CTX_INPUT)()
      return v == null
        ? { member: m.name, sourceId: m.sourceId, kind: 'miss', reason: 'declined (no result)', ms: 1 }
        : { member: m.name, sourceId: m.sourceId, kind: 'win', value: v, ms: 1 }
    } catch (e) {
      return { member: m.name, sourceId: m.sourceId, kind: 'error', reason: (e as Error).message, stack: (e as Error).stack, ms: 1 }
    }
  }
}

function ctx(over: Partial<StrategyContext>, table: Table = {}): StrategyContext {
  return {
    record: row(), members: [], input: CTX_INPUT, accept: () => true,
    run: realRun(table), admit: () => ({ allow: true }),
    ...over,
  }
}

afterEach(() => { vi.useRealTimers() })

describe('expand strategy', () => {
  it('两跳:A 出壳,逐壳经 map 钻 B,assemble 装 links,结果保持 A 序', async () => {
    const bParams: Array<Record<string, unknown> | undefined> = []
    const r = await expandStrategy.invoke(ctx({}, {
      'a-src': async () => [
        { title: 'S1', detailUrl: 'https://x/detail/1' },
        { title: 'S2', detailUrl: 'https://x/detail/2' },
      ],
      'b-src': async (_i, params) => {
        bParams.push(params)
        const id = String((params as { detailUrl: string }).detailUrl).split('/').pop()
        return [{ title: `row-${id}`, link: `magnet:?xt=urn:btih:${id}` }]
      },
    }))
    expect(r.strategy).toBe('expand')
    if (r.strategy !== 'expand') throw new Error('unreachable')
    const items = r.items as Array<{ title: string; links: Array<{ url: string; type: string; desc: string }> }>
    expect(items.map((i) => i.title)).toEqual(['S1', 'S2'])
    expect(items[0].links).toEqual([{ url: 'magnet:?xt=urn:btih:1', type: 'magnet', desc: 'row-1' }])
    expect(items[1].links).toEqual([{ url: 'magnet:?xt=urn:btih:2', type: 'magnet', desc: 'row-2' }])
    expect(bParams).toEqual([{ detailUrl: 'https://x/detail/1' }, { detailUrl: 'https://x/detail/2' }])
    expect(r.sources).toEqual(['a-src', 'b-src'])
    // 溯源标打的是行 id（expand 的产物是两跳合成的，不属于任一单源）
    expect(sourceOf(r.items[0])).toBe('exp')
  })

  it('壳数封顶 handleCap(默认 20)', async () => {
    let drills = 0
    const r = await expandStrategy.invoke(ctx({}, {
      'a-src': async () => Array.from({ length: 25 }, (_, i) => ({ title: `S${i}`, detailUrl: `u/${i}` })),
      'b-src': async () => { drills++; return [{ title: 'r', link: 'magnet:?xt=urn:btih:1' }] },
    }))
    expect(drills).toBe(20)
    if (r.strategy !== 'expand') throw new Error('unreachable')
    expect(r.items).toHaveLength(20)
  })

  it('单钻超时经 ctx.run 的 timeoutMs 覆盖生效,超时钻记 miss 不砍整趟', async () => {
    const seen = { timeoutMs: [] as Array<number | undefined> }
    const table: Table = {
      'a-src': async () => [{ title: 'ok', detailUrl: 'u/1' }, { title: 'slow', detailUrl: 'u/2' }],
      'b-src': async (_i, p) => {
        if ((p as { detailUrl: string }).detailUrl === 'u/2') return new Promise(() => {}) // 永不 settle
        return [{ title: 'r', link: 'magnet:?xt=urn:btih:1' }]
      },
    }
    // 管道替身照 timeoutMs 真的裁一刀 —— 断言的是"策略把这个覆盖交下去了、超时钻落 miss"。
    const run = async (m: StrategyMemberView, opts?: { timeoutMs?: number; source?: StrategySourceCall }): Promise<MemberOutcome> => {
      seen.timeoutMs.push(opts?.timeoutMs)
      const p = fetchFor(table, m, opts!.source!, CTX_INPUT)()
      if (!opts?.timeoutMs) return { member: m.name, sourceId: m.sourceId, kind: 'win', value: await p, ms: 1 }
      const timed = await Promise.race([p.then(() => 'done'), new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), opts.timeoutMs))])
      return timed === 'timeout'
        ? { member: m.name, sourceId: m.sourceId, kind: 'timeout', reason: `member "${m.name}" timed out after ${opts.timeoutMs}ms`, ms: opts.timeoutMs! }
        : { member: m.name, sourceId: m.sourceId, kind: 'win', value: await p, ms: 1 }
    }
    const r = await expandStrategy.invoke(ctx({ run }, table))
    if (r.strategy !== 'expand') throw new Error('unreachable')
    expect((r.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['ok'])
    expect(r.misses.map((m) => m.member)).toEqual(['b-src'])
    expect(r.misses[0].reason).toMatch(/timed out/)
    // A 不带超时覆盖，每一钻带 EXPAND_DRILL_TIMEOUT_MS
    expect(seen.timeoutMs).toEqual([undefined, 10000, 10000])
  })

  it('总预算到点不再发起新钻,misses 里有 budget exceeded', async () => {
    // 第一钻把墙钟推过总预算 → 后续的壳一个都不再钻。
    const base = performance.now()
    let t = base
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => t)
    const r = await expandStrategy.invoke(ctx({
      record: row({ expand: { ...row().expand!, concurrency: 1 } }),
    }, {
      'a-src': async () => [{ title: 'S1', detailUrl: 'u/1' }, { title: 'S2', detailUrl: 'u/2' }, { title: 'S3', detailUrl: 'u/3' }],
      'b-src': async () => { t += EXPAND_TOTAL_BUDGET_MS + 1; return [{ title: 'r', link: 'magnet:?xt=urn:btih:1' }] },
    }))
    spy.mockRestore()
    if (r.strategy !== 'expand') throw new Error('unreachable')
    expect((r.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['S1'])
    expect(r.misses.map((m) => m.reason)).toContain('expand total budget exceeded; remaining handles skipped')
  })

  it('A 一无所获时不钻 B,并把 A 的 miss 摆出来(不静默回空)', async () => {
    let drills = 0
    const r = await expandStrategy.invoke(ctx({}, {
      'a-src': async () => [],
      'b-src': async () => { drills++; return [] },
    }))
    expect(drills).toBe(0)
    if (r.strategy !== 'expand') throw new Error('unreachable')
    expect(r.items).toEqual([])
    expect(r.misses.map((m) => m.member)).toEqual(['a-src'])
  })

  it('A 回 object 型判决时视同 miss(不静默回空)', async () => {
    let drills = 0
    const r = await expandStrategy.invoke(ctx({}, {
      // 非数组返回：管道按 empty:'decline' 的口径原样回 → win，但 expand 的壳搜索要的是 items 型。
      'a-src': async () => ({ verdict: 'single' }) as never,
      'b-src': async () => { drills++; return [] },
    }))
    expect(drills).toBe(0)
    if (r.strategy !== 'expand') throw new Error('unreachable')
    expect(r.items).toEqual([])
    expect(r.misses.map((m) => m.member)).toEqual(['a-src'])
    expect(r.misses[0].reason).toMatch(/object-shaped verdict/)
  })

  it('无 collect 语义', () => {
    expect(expandStrategy.collect).toBeUndefined()
  })
})
