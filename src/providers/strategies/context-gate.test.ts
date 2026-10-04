import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../../store/user-store.ts'
import { Registry } from '../../registry/registry.ts'
import { ProviderStatsStore } from '../stats-store.ts'
import { ProviderExecutor } from '../executor.ts'
import { ProviderDirectory } from '../directory.ts'
import { SYSTEM_IDENTITIES } from '../system/index.ts'
import type { ExecutionStrategy, StrategyContext, StrategySourceCall } from './types.ts'
import type { MemberOutcome } from '../member-pipeline.ts'

/** 这扇门（`executor.strategyContext`）的守卫：策略只能"点单"，取数与包装归执行器。
 *  钉两件事——(1) 既不在 members 里、又没带 source 描述 = 策略写错了，必须**进管道前**显式抛，
 *  不能伪装成上游 miss；(2) source 描述的空批语义按 `empty` 分档，与 sourceMember 逐字对齐。 */
describe('strategy context — 取数门', () => {
  let dir: string
  let store: UserStore
  let stats: ProviderStatsStore
  let fetched: Array<{ sourceId: string; input: unknown; params?: Record<string, unknown> }>
  let behaviors: Record<string, () => Promise<unknown>>
  let probe: (ctx: StrategyContext) => Promise<unknown>
  let exec: ProviderExecutor

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctxgate-'))
    store = new UserStore(join(dir, 'stream.db'))
    stats = new ProviderStatsStore(join(dir, 'cache.db'))
    fetched = []
    behaviors = {}
    probe = async () => null
    const strategy: ExecutionStrategy = {
      // 顶掉 'sequential' 这格（行的 strategy 列有 CHECK 约束，只收三个内置名）——本测试要的是
      // 一个能拿到真 ctx 的探针，不是新策略。
      name: 'sequential',
      invoke: async (ctx) => {
        await probe(ctx)
        return { strategy: 'concurrent', provider: ctx.record.id, items: [], sources: [], misses: [], timings: [] }
      },
    }
    store.putProvider({
      id: 'row', label: '', description: '', category: 'resolve', serves: ['k'], strategy: 'sequential',
      members: [{ source: 's-known' }], contract: null, options: {},
    })
    exec = new ProviderExecutor({
      directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry: new Registry([]), stats,
      strategies: new Map([['sequential', strategy]]),
      fetchSource: async (sourceId, input, params) => {
        fetched.push({ sourceId, input, params })
        const b = behaviors[sourceId]
        if (!b) throw new Error(`no behavior for ${sourceId}`)
        return (await b()) as never
      },
    })
  })
  afterEach(() => {
    store.close()
    stats.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('不在 members 里又没带 source 描述 → 显式抛错（不吞成 miss）', async () => {
    probe = async (ctx) => ctx.run({ name: 'ghost', sourceId: 's-ghost', kind: 'source' })
    await expect(exec.invoke('row', 'q')).rejects.toThrow(/unknown member "ghost".*without a source call/)
    expect(fetched).toEqual([]) // 根本没走到取数
  })

  it('source 描述：executor 负责取数，params/input 原样递到 fetchSource', async () => {
    behaviors['s-ghost'] = async () => [{ x: 1 }]
    let out: MemberOutcome | undefined
    const call: StrategySourceCall = { params: { p: 1 }, empty: 'decline', input: 'override' }
    probe = async (ctx) => { out = await ctx.run({ name: 'ghost', sourceId: 's-ghost', kind: 'source' }, { source: call }) }
    await exec.invoke('row', 'q')
    expect(fetched).toEqual([{ sourceId: 's-ghost', input: 'override', params: { p: 1 } }])
    expect(out).toMatchObject({ member: 'ghost', sourceId: 's-ghost', kind: 'win', value: [{ x: 1 }] })
  })

  it("empty:'decline' → 空批归 miss；empty:'ok' → 空批照样 win", async () => {
    behaviors['s-ghost'] = async () => []
    const outs: MemberOutcome[] = []
    probe = async (ctx) => {
      const v = { name: 'ghost', sourceId: 's-ghost', kind: 'source' as const }
      outs.push(await ctx.run(v, { source: { empty: 'decline' } }))
      outs.push(await ctx.run(v, { source: { empty: 'ok' } }))
    }
    await exec.invoke('row', 'q')
    expect(outs[0].kind).toBe('miss')
    expect(outs[1]).toMatchObject({ kind: 'win', value: [] })
    // input 省略时用 ctx.input
    expect(fetched.map((f) => f.input)).toEqual(['q', 'q'])
  })

  // 这道门的另一半是**编译期**的：上面四条只证运行时行为，证不了"裸取数口根本不在类型上"。
  // 下面两行靠 `@ts-expect-error` 自证——真把 fetchSource / attempt 加回 StrategyContext，
  // 断言就没了错误可期待，typecheck 会反过来红（"Unused '@ts-expect-error' directive"）。
  it('类型门：ctx 上没有裸取数口，run 的 opts 也不收 attempt 闭包', async () => {
    behaviors['s-known'] = async () => [{ ok: true }]
    probe = async (c) => {
      // @ts-expect-error StrategyContext 上不该有 fetchSource（有了策略就能绕开管道自己取数）
      void c.fetchSource
      // @ts-expect-error run 的 opts 不该收 attempt 闭包（同上：闭包版把裸取数递进了策略手里）
      await c.run(c.members[0], { attempt: async () => [{ ok: true }] })
    }
    await exec.invoke('row', 'q')
    expect(fetched.map((f) => f.sourceId)).toEqual(['s-known'])
  })

  it('标准成员（在 members 里）不带 source 描述照跑绑定 attempt', async () => {
    behaviors['s-known'] = async () => [{ ok: true }]
    let out: MemberOutcome | undefined
    probe = async (ctx) => { out = await ctx.run(ctx.members[0]) }
    await exec.invoke('row', 'q')
    expect(out).toMatchObject({ member: 's-known', kind: 'win', value: [{ ok: true }] })
  })
})
