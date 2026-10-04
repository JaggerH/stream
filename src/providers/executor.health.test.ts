import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { ProviderStatsStore } from './stats-store.ts'
import { ProviderExecutor, type MemberResult } from './executor.ts'
import { ProviderDirectory } from './directory.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import { BREAKER_COOLDOWN_CAP_MS } from './breaker.ts'

/**
 * 顺次梯子 × 熔断（executor 级集成）。
 *
 * 守的是一个真实事故（2026-08-24）：网易云下载的两个第三方解析源双双失效后，梯子照原序
 * 死试——单次 5.8s + 46.9s，重试 3 次 ≈ 每首歌 2.5 分钟，而账本里早就有信号。
 *
 * 现在的语义是**用户原序 + 熔断跳过**，不是按健康度重排：
 *  - 顺序永远是行里声明的那个（执行器无权动它）；
 *  - 只有错/超时进冷却，**空永不触发**（空是业务信号，快速返回空恰恰证明源活着）；
 *  - 冷却有封顶 → 死源最坏每个封顶周期被真实试探一次，绝不永久降级；
 *  - 全员冷却时强行放行冷却剩余最短的那个——一次调用绝不"什么都没试就回空"。
 */
function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}

describe('sequential ladder × breaker (executor integration)', () => {
  let dir: string
  let store: UserStore
  let stats: ProviderStatsStore
  let health: SourceHealthStore
  let tried: string[]
  let behaviors: Record<string, () => Promise<MemberResult>>
  /** 可拨动的假钟：账本写的 lastAt 是真墙钟，所以假钟以真时间为基准加偏移。 */
  let clockOffset: number
  let exec: ProviderExecutor

  const registry = new Registry([
    mk({ id: 'dl-a', matchers: ['music.163.com/song'], priority: 1 }),
    mk({ id: 'dl-b', matchers: ['music.163.com/song'], priority: 2 }),
  ])

  const mkExecutor = (opts?: { perMemberTimeoutMs?: number }): ProviderExecutor =>
    new ProviderExecutor({
      directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry, stats,
      health: { record: (id, o) => health.record(id, o), get: (id) => health.get(id) },
      now: () => Date.now() + clockOffset,
      perMemberTimeoutMs: opts?.perMemberTimeoutMs,
      fetchSource: async (sourceId) => {
        tried.push(sourceId)
        const b = behaviors[sourceId]
        if (!b) throw new Error(`no behavior for ${sourceId}`)
        return b()
      },
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-health-'))
    store = new UserStore(join(dir, 'stream.db'))
    stats = new ProviderStatsStore(join(dir, 'cache.db'))
    health = new SourceHealthStore(join(dir, 'source-health.json'))
    tried = []
    behaviors = {}
    clockOffset = 0
    exec = mkExecutor()
    store.putProvider({
      id: 'dl', label: '', description: '', category: 'resolve', serves: ['netease'],
      strategy: 'sequential', members: [{ source: 'dl-a' }, { source: 'dl-b' }],
      contract: null, options: {},
    })
  })
  afterEach(() => {
    store.close()
    stats.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const invoke = (e: ProviderExecutor = exec) => e.invoke('dl', 'song-1')
  const countTried = (id: string): number => tried.filter((x) => x === id).length

  it('错源进入冷却：第二次调用跳过它直接问下一档', async () => {
    behaviors = {
      'dl-a': async () => { throw new Error('401 签名验证失败') },
      'dl-b': async () => ({ url: 'y' }),
    }
    await invoke()
    const second = await invoke()

    expect(countTried('dl-a')).toBe(1) // 两次调用里只被真实试过一次
    expect(second).toMatchObject({ strategy: 'sequential', via: 'dl-b' })
    const misses = (second as { misses: Array<{ member: string; reason: string }> }).misses
    expect(misses).toEqual([{ member: 'dl-a', reason: expect.stringContaining('熔断冷却中') }])
  })

  it('空源永不跳过：连空 4 次后照样每次都被真实调用', async () => {
    // 空 = "这个 key 在这个源没有答案"，是业务信号不是故障；而且很快返回空恰恰证明它活着。
    behaviors = { 'dl-a': async () => [], 'dl-b': async () => ({ url: 'y' }) }
    for (let i = 0; i < 4; i++) await invoke()
    expect(health.get('dl-a')!.consecutiveEmpty).toBe(4)

    tried = []
    const r = await invoke()
    expect(tried).toEqual(['dl-a', 'dl-b'])
    expect(r).toMatchObject({ via: 'dl-b' })
  })

  it('不会永久降级：时钟拨过封顶冷却，死源被真实试探，成功即回 healthy', async () => {
    behaviors = {
      'dl-a': async () => { throw new Error('上游挂了') },
      'dl-b': async () => ({ url: 'y' }),
    }
    // 连错 5 次（第 4 次起冷却已经封顶）——每次之间把钟拨过封顶，好让它每轮都真的被试到。
    for (let i = 0; i < 5; i++) {
      await invoke()
      clockOffset += BREAKER_COOLDOWN_CAP_MS + 1000
    }
    expect(health.get('dl-a')!.consecutiveError).toBe(5)
    expect(health.stateOf('dl-a')).toBe('dead')

    behaviors = { ...behaviors, 'dl-a': async () => ({ url: 'x' }) }
    tried = []
    const r = await invoke()
    expect(tried).toEqual(['dl-a']) // 冷却到期 → 下一次正常调用就是探针，没有独立探针机制
    expect(r).toMatchObject({ via: 'dl-a' })
    expect(health.stateOf('dl-a')).toBe('healthy')
  })

  it('全员冷却：强行试冷却剩余最短的那个，其余记"熔断冷却中" miss', async () => {
    // 直接写账本喂出"两个都在冷却、但剩余不同"的局面：dl-a 连错 2 次（冷却 120s），
    // dl-b 连错 1 次（冷却 30s）。走 invoke 喂不出这个差异——梯子一趟把两个都记一笔，连败数恒等。
    health.record('dl-a', { kind: 'error', message: 'e1' })
    health.record('dl-a', { kind: 'error', message: 'e2' })
    health.record('dl-b', { kind: 'error', message: 'e1' })

    behaviors = { 'dl-a': async () => ({ url: 'x' }), 'dl-b': async () => ({ url: 'y' }) }
    const r = await invoke()

    expect(tried).toEqual(['dl-b']) // 恰一次真实调用，且是剩余冷却最短的那个
    expect(r).toMatchObject({ via: 'dl-b' })
    const misses = (r as { misses: Array<{ member: string; reason: string }> }).misses
    expect(misses).toEqual([{ member: 'dl-a', reason: expect.stringContaining('熔断冷却中') }])
  })

  it('并发路径也经管道记账：成员抛错 → 账本落一笔 error', async () => {
    store.putProvider({
      id: 'dlc', label: '', description: '', category: 'resolve', serves: ['netease-c'],
      strategy: 'concurrent', members: [{ source: 'dl-a' }, { source: 'dl-b' }],
      contract: null, options: {},
    })
    behaviors = {
      'dl-a': async () => { throw new Error('上游挂了') },
      'dl-b': async () => ({ url: 'y' }),
    }
    await exec.invoke('dlc', 'song-1')
    expect(health.get('dl-a')!.consecutiveError).toBe(1)
    expect(health.get('dl-a')!.lastOutcome).toBe('error')
  })

  it('顺次路径有超时：挂死成员被掐掉，梯子继续走下一个并赢', async () => {
    const slow = mkExecutor({ perMemberTimeoutMs: 50 })
    behaviors = {
      'dl-a': () => new Promise<MemberResult>(() => {}), // 永不 resolve
      'dl-b': async () => ({ url: 'y' }),
    }
    vi.useFakeTimers()
    try {
      const p = invoke(slow)
      await vi.advanceTimersByTimeAsync(200)
      const r = await p
      expect(r).toMatchObject({ via: 'dl-b' })
      const misses = (r as { misses: Array<{ member: string; reason: string }> }).misses
      expect(misses[0].member).toBe('dl-a')
      expect(misses[0].reason).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})
