// src/agent/search/service.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SearchAgentService, coverageOf, surfaceRun } from './service.ts'
import { SearchRunStore } from './run-store.ts'
import { netdiskDomain } from './domains/netdisk.ts'
import type { DiscoveryDomain } from './domain.ts'
import type { RunRecord, TrajectoryStep, WebHit } from './types.ts'
import { textOf } from '../../llm/client.ts'
import type { ChatMessage, ChatResult } from '../../llm/client.ts'

const web = (over: Partial<WebHit>): WebHit => ({ title: 't', url: 'https://example.com', ...over })
const reply = (c: string): ChatResult => ({ content: c, raw: {} })

const svc = () => {
  const store = new SearchRunStore(':memory:')
  const webSearch = vi.fn(async () => [web({ title: '怡楽 合集', url: 'https://pan.quark.cn/s/a' })])
  const chat = vi.fn(async (m: ChatMessage[]) => {
    const sys = textOf(m[0].content)
    if (sys.includes('生成')) return reply('["怡乐播客 网盘"]')
    if (sys.includes('分类')) return reply('{"items":[{"i":0,"kind":"netdisk"}],"vocab":[]}')
    if (sys.includes('打分')) return reply('[{"i":0,"score":3}]')
    return reply('[]')
  })
  const service = new SearchAgentService({
    store,
    flowDeps: { webSearch, chat, domain: netdiskDomain({}), earlyStop: { topical: 1, hubs: 5 } },
  })
  return { store, service, webSearch }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('surfaceRun', () => {
  it('keeps topicality≥1 targets, drops 0s, reports suppressed count', () => {
    const rec = {
      runId: 'r',
      goal: 'g',
      domain: 'netdisk',
      status: 'done',
      trajectory: [],
      targets: [
        { link: 'a', netdisk: 'quark', sourceId: 's', topicality: 3 },
        { link: 'b', netdisk: 'quark', sourceId: 's', topicality: 1 },
        { link: 'c', netdisk: 'baidu', sourceId: 's', topicality: 0 },
        { link: 'd', netdisk: 'baidu', sourceId: 's', topicality: 0 },
      ],
      updatedAt: 'x',
    } as RunRecord
    const out = surfaceRun(rec)
    expect(out.targets.map((t) => t.link)).toEqual(['a', 'b'])
    expect(out.suppressed).toBe(2)
  })

  it('handles a run with no targets', () => {
    const out = surfaceRun({ runId: 'r', goal: 'g', domain: 'netdisk', status: 'running', trajectory: [], updatedAt: 'x' } as RunRecord)
    expect(out.targets).toEqual([])
    expect(out.suppressed).toBe(0)
  })
})

describe('SearchAgentService', () => {
  it('start returns a runId; after settling the run is done with targets + trajectory', async () => {
    const { service } = svc()
    const rec = service.start('怡楽播客')
    expect(rec.status).toBe('queued')
    expect(rec.runId).toBeTruthy()

    await settle()
    const done = service.get(rec.runId)!
    expect(done.status).toBe('done')
    expect(done.targets?.[0].link).toBe('https://pan.quark.cn/s/a')
    expect(done.trajectory.map((s) => s.kind)).toEqual(['seed', 'search', 'classify', 'score', 'rank', 'result'])
  })

  it('a throwing flow marks the run error, not crash', async () => {
    const store = new SearchRunStore(':memory:')
    const webSearch = vi.fn(async () => {
      throw new Error('boom')
    })
    const chat = vi.fn(async () => reply('["q0"]'))
    const service = new SearchAgentService({ store, flowDeps: { webSearch, chat, domain: netdiskDomain({}) } })
    const rec = service.start('g')
    await settle()
    const got = service.get(rec.runId)!
    expect(got.status).toBe('error')
    expect(got.error).toContain('boom')
  })
})

// Task 5 Step 1：域按 run 挂。商品档每次调用带着不同的约束，域就是那批约束的载体——
// 挂在服务上就只剩一份，两条枚举 run 会互相串味。
describe('SearchAgentService：按 run 挂域', () => {
  const fakeDomain = (name: string, link: string): DiscoveryDomain<{ link: string; fit?: number }> => ({
    name,
    parse: () => [{ link }],
    check: async (_g, c) => ({
      kept: c.map((x) => ({ ...x, fit: 3, topicality: 3 }) as never),
      stats: { alive: c.length, dead: 0, unchecked: 0 },
    }),
    habitat: ['种子'],
    framing: { mission: 'm', categoryAxisHint: 'h，', hubLooksLike: 'l', directLooksLike: null },
    identityOf: (t) => t.link,
    originsOf: () => ['来源窝'],
    hubAffinity: () => 0,
  })

  // 要分辨"用的是哪个域"，候选就必须由**域的 parse**产出，而不是 classify 关节直接给的
  // directLinks（那一格是通用的，换域也不变）。所以这里给 fetchPage、让 classify 只回窝。
  const svcWithHub = () => {
    const store = new SearchRunStore(':memory:')
    const webSearch = vi.fn(async () => [web({ title: '窝', url: 'https://hub.example.com/a' })])
    const chat = vi.fn(async (m: ChatMessage[]) => {
      const sys = textOf(m[0].content)
      if (sys.includes('生成')) return reply('["q0"]')
      if (sys.includes('分类')) return reply('{"items":[{"i":0,"kind":"hub"}],"vocab":[]}')
      if (sys.includes('打分')) return reply('[{"i":0,"score":3}]')
      return reply('[]')
    })
    const service = new SearchAgentService({
      store,
      flowDeps: {
        webSearch,
        chat,
        fetchPage: async () => '夸克：https://pan.quark.cn/s/fromnetdisk 提取码 ab12',
        domain: netdiskDomain({}),
        earlyStop: { topical: 1, hubs: 5 },
      },
    })
    return { store, service }
  }

  it('start 传进来的域真的被用上了，且 domain 名字落进记录', async () => {
    const { service, store } = svcWithHub()
    const rec = service.start('g', fakeDomain('catalog', '这条只有传进来的域才产得出'))
    await settle()
    const got = store.get(rec.runId)!
    expect(got.domain).toBe('catalog')
    // 若 start 的 domain 被忽略、回落到装配时那个网盘档，产出的会是 pan.quark.cn 那条。
    expect((got.targets as unknown as Array<{ link: string }>)[0].link).toBe('这条只有传进来的域才产得出')
  })

  it('不传域时回落到装配时那个网盘档，且 run 跑完把域摘掉（不跟着服务活一辈子）', async () => {
    const { service, store } = svcWithHub()
    const a = service.start('g', fakeDomain('catalog', '临时域'))
    await settle()
    const b = service.start('g') // 同一个服务、下一条 run
    await settle()
    expect(store.get(a.runId)!.domain).toBe('catalog')
    expect(store.get(b.runId)!.domain).toBe('netdisk')
    expect(store.get(b.runId)!.targets?.[0].link).toBe('https://pan.quark.cn/s/fromnetdisk')
  })

  it('knobs 能把装配时那份早停关掉——换域不换旋钮会安静地提前收工', async () => {
    // 活体（2026-09-02）真栽过：装配的 flowDeps 是照网盘档配的（earlyStop.topical=5），
    // `{...flowDeps, domain}` 把它原样带进商品档，枚举跑一轮凑够 5 条就 early 收工，
    // 73 个窝只开了 5 个。**一份提前收工的清单正是这个功能要消灭的东西**，而没有一处会报错。
    const { service, store } = svcWithHub() // 装配时 earlyStop: { topical: 1, hubs: 5 }
    const withInherited = service.start('g', fakeDomain('catalog', 'x'))
    await settle()
    const withKnobs = service.start('g', fakeDomain('catalog', 'y'), { earlyStop: undefined })
    await settle()

    expect(store.get(withInherited.runId)!.stopped).toBe('early') // 继承 → 凑够 1 条就停
    expect(store.get(withKnobs.runId)!.stopped).not.toBe('early') // 关掉 → 只剩收敛/截断
  })

  it('stopped 落进记录并出现在 surfaceRun 回执里', async () => {
    const { service } = svc()
    const rec = service.start('怡楽播客')
    await settle()
    expect(surfaceRun(service.get(rec.runId)!).stopped).toBe('early')
  })
})

// 覆盖范围（spec §2.4）：回执必须能说清这一趟摸了多大一片，否则下游没法判断
// 「已排除 X」是在多大的候选集上算出来的。
describe('coverageOf', () => {
  const step = (kind: TrajectoryStep['kind'], output?: unknown): TrajectoryStep =>
    ({ kind, output, seq: 0, at: '' }) as TrajectoryStep

  it('轮数数 search 步，窝/抽出/留下按 fetch 步累加', () => {
    const cov = coverageOf([
      step('seed'),
      step('search', { count: 10 }),
      step('fetch', { fetched: 3, extracted: 40, kept: 2, skipped: 7 }),
      step('search', { count: 8 }),
      step('fetch', { fetched: 2, extracted: 60, kept: 0, skipped: 1 }),
      step('result'),
    ])
    expect(cov).toEqual({ rounds: 2, hubsFetched: 5, hubsSkipped: 8, extracted: 100, kept: 2 })
  })

  it('kept 和 extracted 分开数——抽 100 条留 2 条不许读成产出 100', () => {
    const cov = coverageOf([step('fetch', { fetched: 1, extracted: 100, kept: 2, skipped: 0 })])
    expect(cov.extracted).toBe(100)
    expect(cov.kept).toBe(2)
  })

  it('没有 fetch 步（甲档）时全是 0，不是 undefined', () => {
    expect(coverageOf([step('search'), step('result')])).toEqual({
      rounds: 1, hubsFetched: 0, hubsSkipped: 0, extracted: 0, kept: 0,
    })
  })
})
