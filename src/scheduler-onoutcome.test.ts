import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Scheduler } from './scheduler.ts'
import { Registry } from './registry/registry.ts'
import { DedupStore } from './dedup-store.ts'
import { SourceHealthStore } from './source-health-store.ts'
import { EnvironmentUnavailableError } from './failure.ts'
import type { Adapter } from './adapters/types.ts'
import type { SourceManifest } from './manifest/types.ts'
import type { Stream } from './streams/types.ts'

function mk(id: string): SourceManifest {
  return {
    schema_version: 1, id, adapter: 'fake', type: 'post', description: id,
    topics: [], example_queries: [], capabilities: ['timeline'],
    auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true,
  }
}

const fakeAdapter: Adapter = {
  id: 'fake', init: async () => {},
  fetch: async () => [{ guid: 'a', title: 'A' }],
}

describe('Scheduler onOutcome hook', () => {
  let dir: string
  let dedup: DedupStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-oo-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
  })
  afterEach(() => {
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const stream: Stream = {
    id: 's', description: 'one', sources: [{ source_id: 'src-a', params: {} }],
    cadence_seconds: 1800, vault_subdir: 's',
  }

  it('fires onOutcome with the sourceId after a real harvest records health', async () => {
    const onOutcome = vi.fn()
    const health = new SourceHealthStore(join(dir, 'health.json'))
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]),
      streams: [stream],
      adapters: new Map([['fake', fakeAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      health,
      onOutcome,
    })
    await sched.tick('s')
    expect(onOutcome).toHaveBeenCalledWith('src-a')
    // health was recorded before the hook — the projection reads a real outcome
    expect(health.get('src-a')?.lastOutcome).toBe('ok')
  })

  // A search-only session facility (douyin) is never scheduled, so an ad-hoc read is the ONLY
  // place its login wall can ever be seen. An auth failure must therefore record health even
  // when recordHealth is off — that projection is what lights up the re-login panel. Other
  // ad-hoc failures still stay out of health (they must not contaminate a source's verdict).
  it('records an auth failure from an ad-hoc read (preview), but not other failures', async () => {
    const health = new SourceHealthStore(join(dir, 'health.json'))
    const walled: Adapter = {
      id: 'fake', init: async () => {},
      fetch: async () => { throw new Error('source "src-a" needs re-login') },
    }
    const flaky: Adapter = {
      id: 'flaky', init: async () => {},
      fetch: async () => { throw new Error('upstream 500') },
    }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), { ...mk('src-b'), adapter: 'flaky' }]),
      streams: [stream],
      adapters: new Map([['fake', walled], ['flaky', flaky]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      health,
    })

    const walledRes = await sched.readSourceNormalized('src-a', {})
    expect(walledRes.errors[0]?.category).toBe('auth')
    expect(health.get('src-a')?.lastOutcome).toBe('error')
    expect(health.get('src-a')?.lastErrorCategory).toBe('auth')

    const flakyRes = await sched.readSourceNormalized('src-b', {})
    expect(flakyRes.errors).toHaveLength(1)
    expect(health.get('src-b')).toBeUndefined()
  })
})

/**
 * 「环境没就绪」的调度语义：本轮跳过，**health 三样都不动**，但要出声。
 *
 * 病灶：ExtRelayDisconnected 原先全仓无 catch 点，"用户关了 Chrome"会走成普通失败 → 记 health →
 * 掉档告警。一夜没开电脑，第二天所有 ext-cdp 的源全是红的，而它们一个毛病都没有。
 */
describe('Scheduler：环境没就绪就跳过本轮', () => {
  let dir: string
  let dedup: DedupStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-env-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
  })
  afterEach(() => {
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const stream: Stream = {
    id: 's', description: 'one', sources: [{ source_id: 'src-a', params: {} }],
    cadence_seconds: 1800, vault_subdir: 's',
  }
  const deadAdapter: Adapter = {
    id: 'fake', init: async () => {},
    fetch: async () => { throw new EnvironmentUnavailableError('ext-relay socket disconnected') },
  }
  const mkSched = (health: SourceHealthStore, hooks: Record<string, unknown>) => new Scheduler({
    registry: new Registry([mk('src-a')]),
    streams: [stream],
    adapters: new Map([['fake', deadAdapter]]),
    resolveCreds: async () => ({}),
    vaultRoot: join(dir, 'vault'),
    dedup, health, ...hooks,
  })

  it('不记 health —— 既不记失败(会掉档)也不记成功(会掩盖真坏掉的源)', async () => {
    const health = new SourceHealthStore(join(dir, 'health.json'))
    await mkSched(health, {}).tick('s').catch(() => {})
    expect(health.get('src-a')).toBeUndefined() // 三样都不动 = 这个源压根没有记录
  })

  it('不点告警 —— onHarvestError 是"源坏了"的通道,这里没坏', async () => {
    const onHarvestError = vi.fn()
    await mkSched(new SourceHealthStore(join(dir, 'h2.json')), { onHarvestError }).tick('s').catch(() => {})
    expect(onHarvestError).not.toHaveBeenCalled()
  })

  it('但必须出声 —— 静默的跳过和静默的失败,用户体验上是同一个东西', async () => {
    const onHarvestSkipped = vi.fn()
    await mkSched(new SourceHealthStore(join(dir, 'h3.json')), { onHarvestSkipped }).tick('s').catch(() => {})
    expect(onHarvestSkipped).toHaveBeenCalledWith('src-a', expect.stringContaining('disconnected'))
  })

  it('普通失败照旧记 health —— 别把这次修改扩大成"所有失败都跳过"', async () => {
    const health = new SourceHealthStore(join(dir, 'h4.json'))
    const broken: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { throw new Error('HTTP 412') } }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a')]), streams: [stream],
      adapters: new Map([['fake', broken]]), resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'), dedup, health,
    })
    await sched.tick('s').catch(() => {})
    expect(health.get('src-a')?.lastOutcome).toBe('error')
  })
})
