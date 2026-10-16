import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Scheduler } from './scheduler.ts'
import { Registry } from './registry/registry.ts'
import { DedupStore } from './dedup-store.ts'
import { SourceHealthStore } from './source-health-store.ts'
import type { Adapter } from './adapters/types.ts'
import type { SourceManifest } from './manifest/types.ts'
import type { Stream } from './streams/types.ts'
import { currentDeviceId, type RunPlacement } from './devices/run-context.ts'
import { DeviceFetchQueueTimeout, DeviceLost, DeviceOffline } from './devices/errors.ts'

/**
 * 调度器是采集的入口（design.md Risks「ALS 漏传」）：facility 绑到设备的源，adapter.fetch
 * 必须在那台设备的执行上下文里跑；设备离线 = 本轮跳过，不是源坏了。
 */
function mk(id: string, facility?: string): SourceManifest {
  return {
    schema_version: 1, id, adapter: 'fake', type: 'post', description: id,
    topics: [], example_queries: [], capabilities: ['timeline'],
    auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true,
    ...(facility ? { facility: { key: facility, label: facility } } : {}),
  } as SourceManifest
}

const NAS: RunPlacement = { deviceId: 'linux:nas', allowHosts: ['example.com'] }
const LOCAL: RunPlacement = { deviceId: 'local', allowHosts: [] }

describe('Scheduler — 采集跟着 facility 的设备走', () => {
  let dir: string
  let dedup: DedupStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-dev-'))
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

  function mkSched(adapter: Adapter, over: Record<string, unknown> = {}, facility: string | undefined = 'nas-site') {
    const health = new SourceHealthStore(join(dir, `h-${Math.random()}.json`))
    const sched = new Scheduler({
      registry: new Registry([mk('src-a', facility)]),
      streams: [stream],
      adapters: new Map([['fake', adapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup, health,
      ...over,
    })
    return { sched, health }
  }

  it('code 包 adapter：在解析出的设备上下文里跑，先问 ready(http.fetch)', async () => {
    let seen = ''
    const asked: (string | undefined)[] = []
    const ready = vi.fn()
    const adapter: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { seen = currentDeviceId(); return [{ guid: 'a', title: 'A' }] } }
    const { sched } = mkSched(adapter, { placementFor: (f: string | undefined) => { asked.push(f); return NAS }, ready })
    await sched.tick('s')
    expect(seen).toBe('linux:nas')
    expect(asked).toEqual(['nas-site'])
    expect(ready).toHaveBeenCalledWith(NAS, 'http.fetch')
  })

  it('自己判执行位置的 adapter（checksPlacement）：调度器不替它问 ready，但照样包上下文', async () => {
    let seen = ''
    const ready = vi.fn()
    const adapter: Adapter = { id: 'fake', checksPlacement: true, init: async () => {}, fetch: async () => { seen = currentDeviceId(); return [] } }
    const { sched } = mkSched(adapter, { placementFor: () => NAS, ready })
    await sched.tick('s')
    expect(seen).toBe('linux:nas')
    expect(ready).not.toHaveBeenCalled()
  })

  it('local placement：不问 ready', async () => {
    const ready = vi.fn()
    const adapter: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [] }
    const { sched } = mkSched(adapter, { placementFor: () => LOCAL, ready }, undefined)
    await sched.tick('s')
    expect(ready).not.toHaveBeenCalled()
  })

  it.each([
    ['DeviceOffline', new DeviceOffline('linux:nas')],
    ['DeviceFetchQueueTimeout', new DeviceFetchQueueTimeout('linux:nas')],
  ])('%s：本轮跳过——不记 health、不报 harvest.error，但出声', async (_n, err) => {
    const onHarvestSkipped = vi.fn()
    const onHarvestError = vi.fn()
    const adapter: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { throw err } }
    const { sched, health } = mkSched(adapter, { placementFor: () => NAS, ready: () => {}, onHarvestSkipped, onHarvestError })
    await sched.tick('s').catch(() => {})
    expect(health.get('src-a')).toBeUndefined()
    expect(onHarvestError).not.toHaveBeenCalled()
    expect(onHarvestSkipped).toHaveBeenCalledWith('src-a', expect.stringContaining('linux:nas'))
  })

  it('ready 抛 DeviceOffline：adapter 一次都不调，本轮跳过', async () => {
    const fetch = vi.fn(async () => [])
    const onHarvestSkipped = vi.fn()
    const adapter: Adapter = { id: 'fake', init: async () => {}, fetch }
    const { sched, health } = mkSched(adapter, {
      placementFor: () => NAS, ready: () => { throw new DeviceOffline('linux:nas') }, onHarvestSkipped,
    })
    await sched.tick('s').catch(() => {})
    expect(fetch).not.toHaveBeenCalled()
    expect(health.get('src-a')).toBeUndefined()
    expect(onHarvestSkipped).toHaveBeenCalled()
  })

  it('DeviceLost 仍是源故障：记 health', async () => {
    const adapter: Adapter = { id: 'fake', init: async () => {}, fetch: async () => { throw new DeviceLost('linux:nas') } }
    const { sched, health } = mkSched(adapter, { placementFor: () => NAS, ready: () => {} })
    await sched.tick('s').catch(() => {})
    expect(health.get('src-a')?.lastOutcome).toBe('error')
  })
})
