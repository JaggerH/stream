import { afterEach, describe, expect, it, vi } from 'vitest'
import { aggregatePluginStatus } from './status.ts'
import { PluginTargets } from './plugin-target.ts'
import { StandbyHooks } from './standby/hook.ts'
import type { PluginDescriptor } from './types.ts'
import type { StandbyManager } from './standby/manager.ts'

const backendPlugin: PluginDescriptor = {
  id: 'pansou',
  backend: { image: 'x', port: 80, health: '/health' },
}
const voiceprintPlugin: PluginDescriptor = {
  id: 'voiceprint',
  backend: { image: 'x', port: 80, health: '/health' },
}
const inProcessPlugin: PluginDescriptor = { id: 'xhs' }

/** 一个装好 resolver 的实例（resolve: service → origin 或 null）。 */
const targetsWith = (resolve: (s: string) => string | null, onMiss?: (s: string) => void) => {
  const t = new PluginTargets(new StandbyHooks())
  t.bind(resolve, onMiss ?? null)
  return t
}
const standbyWith = (snapshot: () => ReturnType<StandbyManager['snapshot']>): StandbyHooks => {
  const h = new StandbyHooks()
  h.bind(({
    ensureAwake: async () => {},
    withAwake: async (_s: string, fn: () => Promise<unknown>) => fn(),
    adopt: async () => {},
    tick: async () => {},
    shutdown: async () => {},
    snapshot,
    origin: () => null,
    managed: () => false,
    diagnose: async (s: string) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown' as const, containerId: null, hostPort: null }),
  }) as unknown as StandbyManager)
  return h
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// 状态面板每次打开都逐个插件取一次址，**只为显示，不唤醒**。host 档下睡着的容器没有 loopback
// 口，答空是正确答案 —— 它绝不该进 `plugin-target` 故障频道（那条频道要抓的是「真要用却拿不到
// 地址」）。这条守的是「窥视档确实用上了」，不是 pluginTarget 自己的行为。
describe('aggregatePluginStatus 不污染 plugin-target 故障频道', () => {
  it('取址只为显示状态 → 答空一声不吭', async () => {
    const seen: string[] = []
    const targets = targetsWith(() => null, (s) => { seen.push(s) })
    const rows = await aggregatePluginStatus([backendPlugin, voiceprintPlugin], () => undefined, targets)
    expect(rows.map((r) => r.health)).toEqual(['unknown', 'unknown'])
    expect(seen).toEqual([])
  })
})

describe('aggregatePluginStatus', () => {
  it('in-process plugins (no backend) are never probed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const [row] = await aggregatePluginStatus([inProcessPlugin], () => undefined)
    expect(row).toMatchObject({ id: 'xhs', configured: true, health: 'unknown' })
    expect(row.probeMs).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // probeMs is the "a health fetch actually ran" marker — bootstrap's DebugBox `plugins` channel
  // counts probed rows with it. It must be set exactly on the probe path and nowhere else.
  it('marks a probed row with probeMs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const [row] = await aggregatePluginStatus([backendPlugin], () => 'https://relay.example.com')
    expect(row.health).toBe('ok')
    expect(typeof row.probeMs).toBe('number')
  })

  // resolveUrl 未给出 base、且插件网络形态为 none（桌面无门，也是单测默认——没递 targets）
  // 时，没有可探测的 server-side origin。这不是"down"：不该发一个必败的 fetch，
  // 更不该 5xx——健康态该是 unknown，probe 完全跳过。
  it('base 全链路解不出（resolveUrl 未给、targets 也没递）→ health unknown，不发起探测', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const [row] = await aggregatePluginStatus([backendPlugin], () => undefined, targetsWith(() => null))
    expect(row).toMatchObject({ id: 'pansou', configured: true, health: 'unknown' })
    expect(row.base).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolveUrl 未给，但实例 targets 解出了值（compose 形态）→ 照常探测', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const [row] = await aggregatePluginStatus([backendPlugin], () => undefined, targetsWith((service) => (service === 'pansou' ? 'http://pansou:8888' : null)))
    expect(row.base).toBe('http://pansou:8888')
    expect(row.health).toBe('ok')
  })

  it('attaches standby state on the early-return (unresolvable base) branch, omits it otherwise', async () => {
    // base 解不出时 aggregatePluginStatus 走"early return"分支——这条用例单独锁死它,
    // 不依赖下面 probed 分支那条覆盖同一行为。
    const targets = targetsWith(() => null)
    targets.standby.bind({
      ensureAwake: async () => {},
      withAwake: async (_service: string, fn: () => Promise<unknown>) => fn(),
      adopt: async () => {},
      tick: async () => {},
      shutdown: async () => {},
      snapshot: () => [{ service: 'voiceprint', state: 'asleep', lastUsed: 123, lastWakeMs: 4567 }],
      origin: () => null,
      managed: () => false,
      diagnose: async (s: string) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown' as const, containerId: null, hostPort: null }),
    } as unknown as StandbyManager)
    const [vp, pansou] = await aggregatePluginStatus([voiceprintPlugin, backendPlugin], () => undefined, targets)
    expect(vp.standby).toEqual({ state: 'asleep', lastUsed: 123, lastWakeMs: 4567 })
    expect(pansou.standby).toBeUndefined()
    expect(vp.base).toBeUndefined() // 确认这条确实走的是 early-return 分支
  })

  it('attaches standby state on the resolved-base branch — the branch that actually ships', async () => {
    // standby 只在 compose 形态下存在,而 compose 形态下 plugin-target 总能解出 base,status
    // 走的是"resolved base"return,不是上面那条的 early return。两条分支各自维护
    // `...(standby ? …)` 拼接,漏掉任一处都不会被另一条用例发现——必须两条分支各留一个测试用例。
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const targets = targetsWith((s) => (s === 'voiceprint' ? 'http://voiceprint:80' : null))
    targets.standby.bind({
      ensureAwake: async () => {},
      withAwake: async (_service: string, fn: () => Promise<unknown>) => fn(),
      adopt: async () => {},
      tick: async () => {},
      shutdown: async () => {},
      snapshot: () => [{ service: 'voiceprint', state: 'awake', lastUsed: 999, lastWakeMs: 1234 }],
      origin: () => null,
      managed: () => false,
      diagnose: async (s: string) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown' as const, containerId: null, hostPort: null }),
    } as unknown as StandbyManager)
    const [vp, pansou] = await aggregatePluginStatus([voiceprintPlugin, backendPlugin], () => undefined, targets)
    expect(vp.base).toBe('http://voiceprint:80') // 确认这条确实走的是 resolved-base 分支
    expect(vp.standby).toEqual({ state: 'awake', lastUsed: 999, lastWakeMs: 1234 })
    expect(pansou.standby).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled() // standby-managed → derived from snapshot, no live probe
  })

  // standby-managed 后端"活着与否"不由这个探测回答——ensureAwake 会在真正被用到时自己拉起来
  // (无论是睡着还是崩了),探测结果对用户不可操作、只白付一次网络往返(PROBE_TIMEOUT_MS 封顶也是
  // "每次开插件面板等1s"的真因)。所以 standby 管的服务直接跳过 fetch,health 从 snapshot 状态派生。
  it('standby-managed backend derives health from its snapshot state, never fetches', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const targets = targetsWith((s) => (s === 'voiceprint' ? 'http://voiceprint:80' : null))
    targets.standby.bind({
      ensureAwake: async () => {},
      withAwake: async (_service: string, fn: () => Promise<unknown>) => fn(),
      adopt: async () => {},
      tick: async () => {},
      shutdown: async () => {},
      snapshot: () => [{ service: 'voiceprint', state: 'asleep', lastUsed: null, lastWakeMs: null }],
      origin: () => null,
      managed: () => false,
      diagnose: async (s: string) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown' as const, containerId: null, hostPort: null }),
    } as unknown as StandbyManager)
    const [vp] = await aggregatePluginStatus([voiceprintPlugin], () => undefined, targets)
    expect(vp.health).toBe('unknown') // asleep is expected/self-heals on next use, not "down"
    expect(vp.probeMs).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('standby-managed backend reports health ok when its snapshot says awake, still without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const targets = targetsWith((s) => (s === 'voiceprint' ? 'http://voiceprint:80' : null))
    targets.standby.bind({
      ensureAwake: async () => {},
      withAwake: async (_service: string, fn: () => Promise<unknown>) => fn(),
      adopt: async () => {},
      tick: async () => {},
      shutdown: async () => {},
      snapshot: () => [{ service: 'voiceprint', state: 'awake', lastUsed: 1, lastWakeMs: 2 }],
      origin: () => null,
      managed: () => false,
      diagnose: async (s: string) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown' as const, containerId: null, hostPort: null }),
    } as unknown as StandbyManager)
    const [vp] = await aggregatePluginStatus([voiceprintPlugin], () => undefined, targets)
    expect(vp.health).toBe('ok')
    expect(vp.probeMs).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('一个实例一份：A 的 standby 快照 B 读不到', async () => {
    const a = targetsWith(() => 'http://voiceprint:80')
    a.standby.bind({
      ensureAwake: async () => {},
      withAwake: async (_s: string, fn: () => Promise<unknown>) => fn(),
      adopt: async () => {},
      tick: async () => {},
      shutdown: async () => {},
      snapshot: () => [{ service: 'voiceprint', state: 'awake', lastUsed: 1, lastWakeMs: 2 }],
      origin: () => null,
      managed: () => true,
      diagnose: async (s: string) => ({ service: s, managed: true, state: 'awake', cachedOrigin: null, container: 'unknown' as const, containerId: null, hostPort: null }),
    } as unknown as StandbyManager)
    const b = standbyWith(() => [])
    const [va] = await aggregatePluginStatus([voiceprintPlugin], () => undefined, a)
    const [vb] = await aggregatePluginStatus([voiceprintPlugin], () => undefined, { target: a.target.bind(a), standby: b } as never)
    expect(va.standby).toEqual({ state: 'awake', lastUsed: 1, lastWakeMs: 2 })
    expect(vb.standby).toBeUndefined()
  })
})
