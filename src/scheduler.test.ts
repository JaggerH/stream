import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Scheduler, CacheLayer, buildCacheKey, DEFAULT_CACHE_TTL_MS } from './scheduler.ts'
import { Registry } from './registry/registry.ts'
import { DedupStore } from './dedup-store.ts'
import { ItemStore } from './item-store.ts'
import type { Adapter } from './adapters/types.ts'
import type { SourceManifest } from './manifest/types.ts'
import type { Stream } from './streams/types.ts'

function mk(id: string): SourceManifest {
  return {
    schema_version: 1,
    id,
    adapter: 'fake',
    type: 'post',
    description: id,
    topics: [],
    example_queries: [],
    capabilities: ['timeline'],
    auth: { type: 'none' },
    params_schema: {},
    cadence_hint_seconds: 1800,
    discoverable: true,
  }
}

// fake adapter returns items keyed by manifest id; src-a and src-b share guid "x"
const fakeAdapter: Adapter = {
  id: 'fake',
  init: async () => {},
  fetch: async (_params, manifest) => {
    if (manifest.id === 'src-a') return [{ guid: 'x', title: 'X' }, { guid: 'a', title: 'A' }]
    if (manifest.id === 'src-b') return [{ guid: 'x', title: 'X-dup' }, { guid: 'b', title: 'B' }]
    return []
  },
}

describe('Scheduler', () => {
  let dir: string
  let dedup: DedupStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
  })
  afterEach(() => {
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const fanoutStream: Stream = {
    id: 'merged',
    description: 'fan-out',
    sources: [
      { source_id: 'src-a', params: {} },
      { source_id: 'src-b', params: {} },
    ],
    cadence_seconds: 1800,
    vault_subdir: 'merged',
  }

  function makeScheduler(streams: Stream[]) {
    return new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]),
      streams,
      adapters: new Map([['fake', fakeAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
  }

  it('fans out and dedups the shared item across sources', async () => {
    const sched = makeScheduler([fanoutStream])
    const res = await sched.tick('merged')
    expect(res.fetched).toBe(4) // 2 + 2
    expect(res.written).toBe(3) // x written once
    const files = readdirSync(join(dir, 'vault', 'merged'))
    expect(files).toHaveLength(3)
  })

  it('writes nothing new on a repeat tick', async () => {
    const sched = makeScheduler([fanoutStream])
    await sched.tick('merged')
    const second = await sched.tick('merged')
    expect(second.written).toBe(0)
    expect(sched.lastTickAt('merged')).toBeDefined()
  })

  // 现取归一（内容搜索 / discover 读口）不经入库那条路，但条目照样要说出产源：出线投影
  // （包的 `stream.item` → 按钮 / 源名 / 站点）按 `source_id` 找归属包，缺了它整条不投影，
  // 且没有任何一处会喊（小红书搜索结果的点赞按钮就这样静默消失过）。
  it('live normalization stamps the producing source id (projection needs it)', () => {
    const sched = makeScheduler([])
    expect(sched.normalizeRaw('src-a', { guid: 'n', title: 'N' }).source_id).toBe('src-a')
  })

  it('stamps a member\'s season tag onto every item it harvests (season merge)', async () => {
    const itemStore = new ItemStore(join(dir, 'items.db'))
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]),
      streams: [{ ...fanoutStream, id: 'show-1', sources: [{ source_id: 'src-a', params: {}, season: 2 }] }],
      adapters: new Map([['fake', fakeAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      itemStore,
    })
    await sched.tick('show-1')
    const items = itemStore.recent({ stream: 'show-1' })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((it) => it.season === 2)).toBe(true)
  })

  it('notifies persistence without waiting for an asynchronous subscriber', async () => {
    const itemStore = new ItemStore(join(dir, 'items.db'))
    const onItemPersisted = vi.fn(() => new Promise<void>(() => {}))
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [{ ...fanoutStream, id: 'notify', sources: [{ source_id: 'src-a', params: {} }] }],
      adapters: new Map([['fake', fakeAdapter]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup, itemStore, onItemPersisted,
    })

    await expect(sched.tick('notify')).resolves.toMatchObject({ written: 2 })
    expect(onItemPersisted).toHaveBeenCalledTimes(2)
    itemStore.close()
  })

  it('normalizes an object-return adapter and fires onFeedTitle', async () => {
    const titles: Array<[string, string]> = []
    const titled: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async () => ({ items: [{ guid: 'a', title: 'x' }], title: '张三的微博' }),
    }
    const stream: Stream = {
      id: 's1', description: 's', sources: [{ source_id: 'src-a', params: {} }],
      cadence_seconds: 1800, vault_subdir: 's1',
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [stream],
      adapters: new Map([['fake', titled]]), resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'), dedup,
      onFeedTitle: (id, t) => titles.push([id, t]),
    })
    await sched.tick('s1')
    expect(titles).toEqual([['s1', '张三的微博']])
  })

  it('still accepts a legacy array-return adapter (no title)', async () => {
    const titles: Array<[string, string]> = []
    const legacy: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [{ guid: 'a', title: 'A' }] }
    const stream: Stream = {
      id: 's2', description: 's', sources: [{ source_id: 'src-a', params: {} }],
      cadence_seconds: 1800, vault_subdir: 's2',
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [stream],
      adapters: new Map([['fake', legacy]]), resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'), dedup,
      onFeedTitle: (id, t) => titles.push([id, t]),
    })
    await sched.tick('s2')
    expect(titles).toEqual([])
  })

  // 8 个 adapter 里只有 RSSHub 报 feed title；其余全返回裸数组，于是名字永远停在占位串。
  // 兜底：全批同一个作者 → 那就是这条流的名字（判据见 store/auto-name.ts 的 inferFeedTitle）。
  it('infers the feed title from a uniform author when the adapter reports none', async () => {
    const titles: Array<[string, string]> = []
    const authored: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async () => [{ guid: 'a', title: 'ep1', author: '不明白播客' }, { guid: 'b', title: 'ep2', author: '不明白播客' }],
    }
    const stream: Stream = {
      id: 's3', description: 's', sources: [{ source_id: 'src-a', params: {} }],
      cadence_seconds: 1800, vault_subdir: 's3',
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [stream],
      adapters: new Map([['fake', authored]]), resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'), dedup,
      onFeedTitle: (id, t) => titles.push([id, t]),
    })
    await sched.tick('s3')
    expect(titles).toEqual([['s3', '不明白播客']])
  })

  it('prefers the adapter-reported title over the inferred one', async () => {
    const titles: Array<[string, string]> = []
    const both: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async () => ({
        items: [{ guid: 'a', author: '张三' }, { guid: 'b', author: '张三' }],
        title: '张三的微博',
      }),
    }
    const stream: Stream = {
      id: 's4', description: 's', sources: [{ source_id: 'src-a', params: {} }],
      cadence_seconds: 1800, vault_subdir: 's4',
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [stream],
      adapters: new Map([['fake', both]]), resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'), dedup,
      onFeedTitle: (id, t) => titles.push([id, t]),
    })
    await sched.tick('s4')
    expect(titles).toEqual([['s4', '张三的微博']])
  })

  // exclusive（阶梯策略）从没触发过 onFeedTitle——源报了标题也永远不会被命名。
  it('fires onFeedTitle on the exclusive ladder too', async () => {
    const titles: Array<[string, string]> = []
    const titled: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async () => ({ items: [{ guid: 'a', title: 'x' }], title: '李四的雪球' }),
    }
    const stream: Stream = {
      id: 's5', description: 's', strategy: 'exclusive',
      sources: [{ source_id: 'src-a', params: {} }],
      cadence_seconds: 1800, vault_subdir: 's5',
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [stream],
      adapters: new Map([['fake', titled]]), resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'), dedup,
      onFeedTitle: (id, t) => titles.push([id, t]),
    })
    await sched.tick('s5')
    expect(titles).toEqual([['s5', '李四的雪球']])
  })

  it('throws on an unknown stream', async () => {
    const sched = makeScheduler([fanoutStream])
    await expect(sched.tick('nope')).rejects.toThrow(/Unknown stream/)
  })

  it('harvestTiming: fanout 每源一份阶段账本——阶段序、计数、二跑命中缓存', async () => {
    const reports: import('./scheduler.ts').HarvestTimingReport[] = []
    const spans: string[] = []
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]),
      streams: [fanoutStream],
      adapters: new Map([['fake', fakeAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      itemStore: new ItemStore(join(dir, 'items-timing.db')),
      trackSync: (name, fn) => {
        spans.push(name)
        return fn()
      },
      harvestTiming: {
        // 假 probe:只记 mark 的先后(ms 恒 1),账本语义由阶段序证明,不依赖真实时钟
        newProbe: () => {
          const marks: Array<{ phase: string; ms: number }> = []
          return { mark: (phase: string) => marks.push({ phase, ms: 1 }), timings: () => marks }
        },
        onTiming: (t) => reports.push(t),
      },
    })

    await sched.tick('merged')
    expect(reports.map((r) => r.sourceId).sort()).toEqual(['src-a', 'src-b'])
    // 阶段全序:取数两段(凭证/出网)→ 入库四段(排队/去重+vault/归一化/批量写)→ 收尾
    // 没接归堆钩子时**不该有 fold 这一格**——账本里一个恒 0ms 的空格子只是噪音。
    expect(reports[0].timing.map((t) => t.phase)).toEqual([
      'creds', 'fetch', 'queued', 'dedup/vault', 'normalize', 'store', 'finalize',
    ])
    expect(reports[0].scheduled).toBe(false)              // 手动 tick
    expect(reports.every((r) => r.cacheHit === false)).toBe(true)
    expect(reports.reduce((s, r) => s + r.fetched, 0)).toBe(4)
    expect(reports.reduce((s, r) => s + r.written, 0)).toBe(3) // 共享 guid x 只写一次
    // 同步段进 op-track:normalize/store 各源一条(卡顿归因的"强嫌疑"素材)
    expect(spans).toEqual(['normalize:src-a', 'store:src-a', 'normalize:src-b', 'store:src-b'])

    // 第二个 tick 落在缓存 TTL 内:fetch 没出网,账本如实标记
    await sched.tick('merged')
    expect(reports).toHaveLength(4)
    expect(reports[2].cacheHit).toBe(true)
    expect(reports[2].timing.some((t) => t.phase === 'fetch(cache)')).toBe(true)
    expect(reports[2].written).toBe(0)
  })

  it('接了归堆钩子:入库之后拿到刚写进去的那批,且它炸了不影响这一轮采集', async () => {
    const seen: string[][] = []
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]),
      streams: [{ ...fanoutStream, sources: [{ source_id: 'src-a', params: {} }] }],
      adapters: new Map([['fake', fakeAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault-fold'),
      dedup,
      itemStore: new ItemStore(join(dir, 'items-fold.db')),
      storyFold: {
        record: (items) => {
          seen.push(items.map((i) => i.id))
          // 归堆是呈现层的附加能力——它炸了只能是"这次没折",绝不能变成"这轮采集失败"。
          throw new Error('fold blew up')
        },
      },
    })
    const res = await sched.tick('merged')
    expect(res.written).toBeGreaterThan(0)   // 采集照常完成
    expect(seen).toHaveLength(1)
    expect(seen[0].length).toBe(res.written) // 拿到的正是刚入库的那批
  })

  it('tick 经 track 包裹为 harvest:<streamId>(op-track 埋点)', async () => {
    const tracked: string[] = []
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]),
      streams: [fanoutStream],
      adapters: new Map([['fake', fakeAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      track: async (name, fn) => {
        tracked.push(name)
        return fn()
      },
    })
    const res = await sched.tick('merged')
    expect(res.fetched).toBe(4)                    // 包裹是透明的:结果原样穿过
    expect(tracked).toEqual(['harvest:merged'])
  })

  describe('live preview (readStreamNormalized / readSourceNormalized) — no store', () => {
    it('normalizes every source live, merges, and does NOT dedup or persist', async () => {
      const sched = makeScheduler([fanoutStream])
      const { items, errors } = await sched.readStreamNormalized('merged')
      expect(errors).toEqual([])
      // no dedup in a preview: the shared guid "x" appears from BOTH sources → 4, not 3
      expect(items).toHaveLength(4)
      expect(items.map((i) => i.title).sort()).toEqual(['A', 'B', 'X', 'X-dup'])
      expect(items.every((i) => i.content !== undefined)).toBe(true) // normalized
      // side-effect-free: nothing deduped, nothing written to the vault
      expect(dedup.countForStream('merged')).toBe(0)
      expect(() => readdirSync(join(dir, 'vault', 'merged'))).toThrow()
    })

    it('caps at limit', async () => {
      const { items } = await makeScheduler([fanoutStream]).readStreamNormalized('merged', { limit: 2 })
      expect(items).toHaveLength(2)
    })

    it('throws on an unknown stream', async () => {
      await expect(makeScheduler([]).readStreamNormalized('nope')).rejects.toThrow(/Unknown stream/)
    })

    it('collects a failing source’s reason and still returns the healthy source’s items', async () => {
      const boom: Adapter = {
        id: 'fake', init: async () => {},
        fetch: async (_p, m) => { if (m.id === 'src-b') throw new Error('boom upstream'); return [{ guid: 'a', title: 'A' }] },
      }
      const sched = new Scheduler({
        registry: new Registry([mk('src-a'), mk('src-b')]), streams: [fanoutStream],
        adapters: new Map([['fake', boom]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
      })
      const { items, errors } = await sched.readStreamNormalized('merged')
      expect(items.map((i) => i.title)).toEqual(['A']) // src-a survived
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ source: 'src-b', reason: expect.stringMatching(/boom upstream/) })
      // a preview failure must NOT pollute the health ledger (no recordHealth)
    })

    it('readSourceNormalized returns one source live, and wraps its error', async () => {
      const ok = await makeScheduler([fanoutStream]).readSourceNormalized('src-a')
      expect(ok.errors).toEqual([])
      expect(ok.items.map((i) => i.title).sort()).toEqual(['A', 'X'])

      const boom: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { throw new Error('nope net') } }
      const sched = new Scheduler({
        registry: new Registry([mk('src-a')]), streams: [],
        adapters: new Map([['fake', boom]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
      })
      const bad = await sched.readSourceNormalized('src-a')
      expect(bad.items).toEqual([])
      expect(bad.errors[0]).toMatchObject({ source: 'src-a', reason: expect.stringMatching(/nope net/) })
    })
  })

  it('add then remove deschedules a stream', () => {
    const sched = makeScheduler([])
    sched.add(fanoutStream)
    expect(sched.list().map((s) => s.id)).toContain('merged')
    expect(sched.remove('merged')).toBe(true)
    expect(sched.list()).toHaveLength(0)
  })

  // 同一条流被 add 两次，必须仍然只有一份注册、一条定时器链。
  // 现在有六处会把流排进调度（开机、两个 stream 端点、两个 channel 端点、MCP subscribe），
  // 它们各自判断该不该排——所以「同一条被排两次」是接线错误里最容易出现的一种。
  // 这一层若把重复吞掉，症状是每个 tick 抓两遍上游，而 list() 看上去完全正常。
  // 当前实现已经是幂等的；这条测试把它钉住，别让某次重构把幂等改没了。
  it('add() 同一条流两次：一份注册、一条定时器链、每个 cadence 只 tick 一次', async () => {
    vi.useFakeTimers()
    try {
      const sched = new Scheduler({
        registry: new Registry([mk('src-a')]), streams: [],
        adapters: new Map([['fake', fakeAdapter]]),
        resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
        rng: () => 1,
      })
      const tick = vi.spyOn(sched, 'tick')
      sched.start()
      sched.add(fanoutStream)
      sched.add(fanoutStream)
      expect(sched.list().filter((s) => s.id === fanoutStream.id)).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1) // 第二次 add 不许留下一条孤儿定时器链
      await vi.advanceTimersByTimeAsync(fanoutStream.cadence_seconds * 1000)
      expect(tick).toHaveBeenCalledTimes(1)
      sched.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores persisted streams without harvesting at boot, then harvests on cadence', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn(async () => [{ guid: 'a', title: 'A' }])
      const sched = new Scheduler({
        registry: new Registry([mk('src-a')]), streams: [fanoutStream],
        adapters: new Map([['fake', { id: 'fake', init: async () => {}, fetch }]]),
        resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
        rng: () => 1, // jitter pinned to full cadence → first fire exactly at cadence
      })
      sched.start()
      await vi.advanceTimersByTimeAsync(fanoutStream.cadence_seconds * 1000 - 1)
      expect(fetch).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalledTimes(1)
      sched.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() staggers the first fire within [0.5, 1) × cadence', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn(async () => [{ guid: 'a', title: 'A' }])
      const sched = new Scheduler({
        registry: new Registry([mk('src-a')]), streams: [fanoutStream],
        adapters: new Map([['fake', { id: 'fake', init: async () => {}, fetch }]]),
        resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
        rng: () => 0, // → first fire at 0.5 × cadence
      })
      sched.start()
      await vi.advanceTimersByTimeAsync(fanoutStream.cadence_seconds * 500 - 1)
      expect(fetch).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalled()
      sched.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a slow tick never overlaps the next one — cadence re-arms after completion', async () => {
    // Date must be faked too: the cache judges TTL by Date.now(), and this test's fake
    // 15s elapse in real microseconds — with a real clock every re-tick would cache-hit.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      let inFlight = 0
      let maxInFlight = 0
      let calls = 0
      const slow: Adapter = {
        id: 'fake', init: async () => {},
        fetch: async () => {
          calls++
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((r) => setTimeout(r, 3000)) // 3× cadence
          inFlight--
          return [{ guid: `g${calls}`, title: 'T' }]
        },
      }
      const stream: Stream = {
        id: 'slow', description: 's', sources: [{ source_id: 'src-a', params: {} }],
        cadence_seconds: 1, vault_subdir: 'slow',
      }
      const sched = new Scheduler({
        registry: new Registry([mk('src-a')]), streams: [stream],
        adapters: new Map([['fake', slow]]), resolveCreds: async () => ({}),
        // vault off: real fs writes complete on the real event loop, which the fake-timer
        // advance loop can outrun — the re-arm would then land beyond the advance target.
        vaultRoot: join(dir, 'vault'), vaultEnabled: false, dedup, rng: () => 1,
      })
      sched.start()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(maxInFlight).toBe(1) // with setInterval this would have overlapped
      expect(calls).toBeGreaterThanOrEqual(2) // and the chain does keep ticking
      sched.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('one failing source no longer aborts the tick: the healthy sibling still persists', async () => {
    const boom: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async (_p, m) => { if (m.id === 'src-b') throw new Error('boom upstream'); return [{ guid: 'a', title: 'A' }] },
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]), streams: [fanoutStream],
      adapters: new Map([['fake', boom]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
    })
    const res = await sched.tick('merged')
    expect(res.written).toBe(1) // src-a survived src-b's failure
  })

  it('a scheduled-tick source failure surfaces through onHarvestError (non-auth)', async () => {
    const boom: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async (_p, m) => { if (m.id === 'src-b') throw new Error('boom upstream'); return [{ guid: 'a', title: 'A' }] },
    }
    const errors: Array<{ sourceId: string; category: string; message: string }> = []
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]), streams: [fanoutStream],
      adapters: new Map([['fake', boom]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
      onHarvestError: (sourceId, f) => errors.push({ sourceId, ...f }),
    })
    await sched.tick('merged')
    expect(errors).toHaveLength(1)
    expect(errors[0].sourceId).toContain('src-b')
    expect(errors[0].message).toContain('boom upstream')
  })

  it('a tick still throws when EVERY attempted source fails', async () => {
    const boom: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { throw new Error('all down') } }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]), streams: [fanoutStream],
      adapters: new Map([['fake', boom]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
    })
    await expect(sched.tick('merged')).rejects.toThrow(/all down/)
  })

  it('scheduled ticks back off a failing source exponentially; manual ticks ignore the window', async () => {
    let calls = 0
    const boom: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { calls++; throw new Error('down') } }
    const stream: Stream = {
      id: 'bo', description: 's', sources: [{ source_id: 'src-a', params: {} }],
      cadence_seconds: 1800, vault_subdir: 'bo',
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [stream],
      adapters: new Map([['fake', boom]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
    })
    const t = () => sched.tick('bo', { scheduled: true }).catch(() => {})
    await t() // attempt 1 → fails=1, skip 0
    await t() // attempt 2 → fails=2, skip 1
    await t() // skipped
    await t() // attempt 3 → fails=3, skip 3
    await t(); await t(); await t() // skipped ×3
    await t() // attempt 4
    expect(calls).toBe(4)
    await sched.tick('bo').catch(() => {}) // manual refresh attempts regardless of backoff
    expect(calls).toBe(5)
  })

  it('fanout fetches members concurrently, and persist still dedups the shared item', async () => {
    const resolvers: Array<() => void> = []
    const gated: Adapter = {
      id: 'fake', init: async () => {},
      fetch: (_p, m) => new Promise((resolve) => {
        resolvers.push(() => resolve([{ guid: 'x', title: 'X' }, { guid: m.id, title: m.id }]))
      }),
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]), streams: [fanoutStream],
      adapters: new Map([['fake', gated]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
    })
    const tickP = sched.tick('merged')
    await vi.waitFor(() => expect(resolvers.length).toBe(2)) // both in flight before either resolved
    for (const r of resolvers) r()
    const res = await tickP
    expect(res.fetched).toBe(4)
    expect(res.written).toBe(3) // shared guid "x" still written exactly once
  })

  it('the stream cadence caps the cache TTL below the 5-min floor', async () => {
    const fakeNow = { t: 0 }
    let calls = 0
    const counting: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { calls++; return [{ guid: `g${calls}`, title: 'T' }] } }
    const stream: Stream = {
      id: 'fast', description: 's', sources: [{ source_id: 'src-a', params: {} }],
      cadence_seconds: 60, vault_subdir: 'fast',
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [stream],
      adapters: new Map([['fake', counting]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
      cacheLayer: new CacheLayer({ now: () => fakeNow.t }),
    })
    await sched.tick('fast')
    fakeNow.t = 61_000 // one cadence later — well inside the old 300s floor
    await sched.tick('fast')
    expect(calls).toBe(2) // manifest hint says 1800s, but the 60s cadence wins
  })

  it('previews bypass the request cache (fresh), while MCP reads still use it', async () => {
    let calls = 0
    const counting: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { calls++; return [{ guid: `g${calls}`, title: `T${calls}` }] } }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [],
      adapters: new Map([['fake', counting]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
    })
    await sched.readSource('src-a')  // miss → fetch (1), fills cache
    await sched.readSource('src-a')  // hit → no fetch
    expect(calls).toBe(1)
    const preview = await sched.readSourceNormalized('src-a') // fresh → real fetch (2)
    expect(calls).toBe(2)
    expect(preview.items.map((i) => i.title)).toEqual(['T2'])
  })

  // I1: 动作 recipe（userInitiated）绝不能吃缓存、也绝不能给下一次调用留一份可命中的结果——
  // 否则"点赞→取消赞→再点赞"这类同参数的连续动作，第二次点赞会在 TTL 内静默变成空操作
  // （缓存命中，adapter.fetch 压根没被调用），账户上什么都没发生，界面却乐观地显示"已赞"。
  it('userInitiated 调用永远绕开缓存：同参数连续两次都真打 adapter.fetch', async () => {
    let calls = 0
    const counting: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async () => { calls++; return [{ guid: `g${calls}`, title: `T${calls}` }] },
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [],
      adapters: new Map([['fake', counting]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
    })
    await sched.readSource('src-a', {}, { userInitiated: true })
    await sched.readSource('src-a', {}, { userInitiated: true }) // same params — must NOT hit cache
    expect(calls).toBe(2)
  })

  // I2（scheduler 半侧）：readSource 的 `userInitiated` 必须原样传到 adapter.fetch 的
  // SourceExecutionContext——这是动作闸（ActionRecipeBlockedError）唯一的放行依据。丢在半路
  // 的症状不是编译错，是"第一方按钮点了但闸照样拦"，而这条测试之前根本不存在。
  it('readSource(..., { userInitiated: true }) 传到 adapter.fetch 的 context', async () => {
    let seenUserInitiated: boolean | undefined
    const capturing: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async (_p, _m, ctx) => { seenUserInitiated = ctx?.userInitiated; return [] },
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [],
      adapters: new Map([['fake', capturing]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'vault'), dedup,
    })
    await sched.readSource('src-a', {}, { userInitiated: true })
    expect(seenUserInitiated).toBe(true)
  })

  it('update replaces a scheduled stream in place and list() reflects it', () => {
    const sched = makeScheduler([fanoutStream])
    expect(sched.update({ ...fanoutStream, description: 'renamed' })).toBe(true)
    const s = sched.list().find((x) => x.id === 'merged')
    expect(s?.description).toBe('renamed')
  })

  it('update is a no-op for an unscheduled stream', () => {
    const sched = makeScheduler([])
    expect(sched.update(fanoutStream)).toBe(false)
    expect(sched.list()).toHaveLength(0)
  })

  it('applies a stream-specific ad_filter only to that stream, not siblings', async () => {
    const gossip: Stream = {
      id: 'gossip', description: 'g',
      sources: [{ source_id: 'src-gossip', params: {} }],
      cadence_seconds: 1800, vault_subdir: 'gossip',
      ad_filter: { keywords: ['内部专享'] },
    }
    const tech: Stream = {
      id: 'tech', description: 't',
      sources: [{ source_id: 'src-tech', params: {} }],
      cadence_seconds: 1800, vault_subdir: 'tech',
    }
    const sameItemAdapter: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async () => [{ guid: 'x', title: '内部专享福利' }],
    }
    const itemStore = new ItemStore(join(dir, 'items.db'))
    const sched = new Scheduler({
      registry: new Registry([mk('src-gossip'), mk('src-tech')]),
      streams: [gossip, tech],
      adapters: new Map([['fake', sameItemAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      itemStore,
    })

    await sched.tick('gossip')
    await sched.tick('tech')

    const gossipItems = itemStore.recent({ stream: 'gossip' })
    const techItems = itemStore.recent({ stream: 'tech' })
    expect(gossipItems[0].muted?.rule).toBe('内部专享')
    expect(techItems[0].muted).toBeUndefined() // same title, but tech has no ad_filter — no leak
  })

  it('persists new items to the store and fires onItem once each', async () => {
    const fired: string[] = []
    const store = new ItemStore(join(dir, 'items.db'))
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]),
      streams: [fanoutStream],
      adapters: new Map([['fake', fakeAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      itemStore: store,
      onItem: (it) => fired.push(it.id),
    })
    await sched.tick('merged')
    expect(store.recent().length).toBe(3) // x deduped across sources
    expect(fired.length).toBe(3)

    fired.length = 0
    await sched.tick('merged') // all deduped now
    expect(fired.length).toBe(0)
    expect(store.recent().length).toBe(3)
    store.close()
  })

  it('**collection 流不进归堆**：歌单是目录快照，不是发布事件', async () => {
    const seen: string[][] = []
    const collStream: Stream = {
      id: 'coll-fold', description: '歌单', mode: 'collection',
      sources: [{ source_id: 'src-a', params: {} }], cadence_seconds: 1800, vault_subdir: 'coll-fold',
    }
    const feedStream: Stream = {
      id: 'feed-fold', description: '普通流（对照）',
      sources: [{ source_id: 'src-a', params: {} }], cadence_seconds: 1800, vault_subdir: 'feed-fold',
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]),
      streams: [collStream, feedStream],
      adapters: new Map([['fake', fakeAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault-nocoll'),
      dedup,
      itemStore: new ItemStore(join(dir, 'items-nocoll.db')),
      storyFold: { record: (items) => seen.push(items.map((i) => i.id)) },
    })
    await sched.tick('coll-fold')
    expect(seen).toEqual([]) // 一条都不该进账本
    // 对照：普通流照常进（否则这条测试可能只是因为钩子根本没接上而"通过"）。
    await sched.tick('feed-fold')
    expect(seen.length).toBeGreaterThan(0)
  })

  it('mode:collection persists via replaceStream with no evict cap; a feed control evicts to capPerStream', async () => {
    // A source returning more than the explicit cap (500) rows: a collection stream
    // must keep every row (replaceStream is not evict-gated), a feed stream must be capped.
    const bigAdapter: Adapter = {
      id: 'fake',
      init: async () => {},
      fetch: async (_params, manifest) =>
        Array.from({ length: 600 }, (_, i) => ({ guid: `${manifest.id}-${i}`, title: `t${i}` })),
    }
    const collStream: Stream = {
      id: 'coll',
      description: 'collection over cap',
      mode: 'collection',
      sources: [{ source_id: 'src-big', params: {} }],
      cadence_seconds: 1800,
      vault_subdir: 'coll',
    }
    const feedStream: Stream = {
      id: 'feed-big',
      description: 'feed over cap (control)',
      sources: [{ source_id: 'src-big', params: {} }],
      cadence_seconds: 1800,
      vault_subdir: 'feed-big',
    }
    const store = new ItemStore(join(dir, 'items.db'), 500)
    const sched = new Scheduler({
      registry: new Registry([mk('src-big')]),
      streams: [collStream, feedStream],
      adapters: new Map([['fake', bigAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      itemStore: store,
    })

    await sched.tick('coll')
    expect(store.recent({ stream: 'coll', limit: 1000 }).length).toBe(600) // no evict

    await sched.tick('feed-big')
    expect(store.recent({ stream: 'feed-big', limit: 1000 }).length).toBe(500) // evicted to cap

    store.close()
  })
})

describe('CacheLayer', () => {
  const fakeNow = { t: 0 }
  const layer = new CacheLayer({ now: () => fakeNow.t })

  it('returns null on miss', () => {
    expect(layer.get('nope')).toBeNull()
  })

  it('returns cached items on hit within TTL', () => {
    layer.set('k', [{ a: 1 }])
    expect(layer.get('k')).toEqual([{ a: 1 }])
  })

  it('returns null after TTL expiry', () => {
    layer.set('k', [{ a: 1 }])
    fakeNow.t = DEFAULT_CACHE_TTL_MS + 1
    expect(layer.get('k')).toBeNull()
  })

  it('fetchOrWait returns cached on second call', async () => {
    let calls = 0
    const fn = async () => { calls++; return [{ x: calls }] }
    const r1 = await layer.fetchOrWait('fw', 1000, fn)
    const r2 = await layer.fetchOrWait('fw', 1000, fn)
    expect(calls).toBe(1)
    expect(r1).toEqual([{ x: 1 }])
    expect(r2).toEqual([{ x: 1 }])
  })

  it('fetchOrWait locks concurrent callers', async () => {
    const key = 'lock-test-' + Date.now()
    let calls = 0
    const fn = async () => { calls++; return [{ c: calls }] }
    // Fire two concurrent fetchOrWait calls — second should wait on first
    const [r1, r2] = await Promise.all([
      layer.fetchOrWait(key, 1000, fn),
      layer.fetchOrWait(key, 1000, fn),
    ])
    expect(calls).toBe(1)
    expect(r1).toEqual(r2)
  })

  it('buildCacheKey is deterministic', () => {
    const a = buildCacheKey('adapter', 'src', { b: 2, a: 1 })
    const b = buildCacheKey('adapter', 'src', { a: 1, b: 2 })
    expect(a).toBe(b)
  })

  it('buildCacheKey differs for different params', () => {
    const a = buildCacheKey('adapter', 'src', { a: 1 })
    const b = buildCacheKey('adapter', 'src', { a: 2 })
    expect(a).not.toBe(b)
  })

  it('ttlFromCadence applies floor of 300s', () => {
    expect(CacheLayer.ttlFromCadence(60)).toBe(300_000)
  })

  it('ttlFromCadence applies ceiling of 86400s', () => {
    expect(CacheLayer.ttlFromCadence(100000)).toBe(86_400_000)
  })

  it('ttlFromCadence passes through normal value', () => {
    expect(CacheLayer.ttlFromCadence(3600)).toBe(3_600_000)
  })

  it('fetchOrWait respects per-entry TTL', () => {
    const now = { t: 0 }
    const layer = new CacheLayer({ now: () => now.t })
    let calls = 0
    const fn = async () => { calls++; return [{ x: 1 }] }
    // Set long TTL
    return layer.fetchOrWait('ttl-test', 100_000, fn).then(() => {
      now.t = 50_000
      // Should still be cached (50s < 100s)
      expect(layer.get('ttl-test')).not.toBeNull()
      now.t = 101_000
      // Should be expired (101s > 100s)
      expect(layer.get('ttl-test')).toBeNull()
    })
  })

  it('a waiter gives up when the in-flight fetch hangs past the lock timeout', async () => {
    const layer = new CacheLayer({ lockTimeoutMs: 30 })
    const stuckPromise = new Promise<unknown[]>(() => {}) // never resolves
    ;(layer as any).locks.set('stuck-key', stuckPromise)
    await expect(layer.fetchOrWait('stuck-key', 5000, async () => [{ nope: true }]))
      .rejects.toThrow(/lock timeout/)
  })

  it('a waiter retries its own fetch when the in-flight fetch fails', async () => {
    const layer = new CacheLayer()
    let retryCalls = 0
    let failFirst!: (e: Error) => void
    const first = new Promise<unknown[]>((_, reject) => { failFirst = reject })
    const p1 = layer.fetchOrWait('retry-key', 1000, () => first)                        // becomes the fetcher, will fail
    const p2 = layer.fetchOrWait('retry-key', 1000, async () => { retryCalls++; return [{ retry: true }] }) // waits on p1
    failFirst(new Error('upstream down'))
    await expect(p1).rejects.toThrow('upstream down')
    await expect(p2).resolves.toEqual([{ retry: true }])
    expect(retryCalls).toBe(1)
  })

  it('fresh:true bypasses a valid cache entry but still refills it', async () => {
    const layer = new CacheLayer()
    await layer.fetchOrWait('fresh-key', 60_000, async () => [{ v: 1 }])
    const r = await layer.fetchOrWait('fresh-key', 60_000, async () => [{ v: 2 }], { fresh: true })
    expect(r).toEqual([{ v: 2 }])
    expect(layer.get('fresh-key')).toEqual([{ v: 2 }]) // later cached readers see the refreshed value
  })

  it('eviction drops the least-recently-used entry, not the earliest-inserted', () => {
    const layer = new CacheLayer({ maxEntries: 2 })
    layer.set('a', [{ a: 1 }])
    layer.set('b', [{ b: 1 }])
    layer.get('a')             // touch a → b becomes LRU
    layer.set('c', [{ c: 1 }]) // evicts b
    expect(layer.get('a')).toEqual([{ a: 1 }])
    expect(layer.get('b')).toBeNull()
    expect(layer.get('c')).toEqual([{ c: 1 }])
  })

  it('buildCacheKey is the verbatim composite — no hash, no collisions', () => {
    expect(buildCacheKey('ad', 'src', { a: 1 })).toBe('ad:src:{"a":1}')
  })
})
