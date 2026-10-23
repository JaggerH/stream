// 本机多节点与 `registry.local` 门面（browser-identity D2）。
import { describe, expect, it } from 'vitest'
import { ExtRelay } from './ext-relay.ts'
import { ExtRelayRegistry } from './ext-relay-registry.ts'
import { runOnDevice } from '../devices/run-context.ts'
import { pickBrowser } from '../devices/placement.ts'

const sock = () => ({ send: () => {} })

/** 一条自动应答的 socket：记下这条命令落在哪条绑定上，然后回一个各 op 都读得出的形状。 */
const answering = (reg: ExtRelayRegistry, bindingId: string, hits: string[]) => ({
  send: (raw: string) => {
    const m = JSON.parse(raw) as { id: number; op: string }
    hits.push(`${bindingId}:${m.op}`)
    queueMicrotask(() => reg.handleMessage(bindingId, JSON.stringify({ id: m.id, result: { tabs: [], names: [], subscriptionId: 7 } })))
  },
})

const makeLocal = (defaults: Record<string, string> = {}) => {
  let t = 0
  const seen: unknown[] = []
  const reg = new ExtRelayRegistry({
    local: new ExtRelay(),
    makeRelay: () => new ExtRelay(),
    deviceOf: () => undefined,
    bindingsOf: () => [],
    defaultOf: (dev) => defaults[dev],
    onNodeSeen: (n) => seen.push(n),
    now: () => ++t,
  })
  return { reg, seen }
}

describe('ExtRelayRegistry: local nodes', () => {
  it('两个 profile 的节点同时在线，后连上的不顶替先连上的，在途命令照常完成', async () => {
    const { reg } = makeLocal()
    const hits: string[] = []
    reg.connect('local:node_a', answering(reg, 'local:node_a', hits), { nodeId: 'node_a' })
    const inflight = reg.relay('local:node_a').list()
    reg.connect('local:node_b', answering(reg, 'local:node_b', hits), { nodeId: 'node_b' })
    await expect(inflight).resolves.toEqual([])
    expect(reg.isOnline('local:node_a')).toBe(true)
    expect(reg.isOnline('local:node_b')).toBe(true)
  })

  it('bindingsOf(local) = 兼容槽 + 每个节点；deviceOf / nodeOf', () => {
    const { reg } = makeLocal()
    reg.connect('local:node_a', sock(), { nodeId: 'node_a' })
    expect(reg.bindingsOf('local')).toEqual(['local', 'local:node_a'])
    expect(reg.deviceOf('local:node_a')).toBe('local')
    expect(reg.nodeOf('local:node_a')).toBe('node_a')
    expect(reg.nodeOf('local')).toBeUndefined()
  })

  it('pick(local)：默认节点 → 最近连上 → 都不在线回兼容槽', () => {
    const { reg } = makeLocal({ local: 'local:node_a' })
    expect(reg.pick('local')).toBe('local')
    expect(reg.hasBrowser('local')).toBe(false)
    const a = sock()
    reg.connect('local:node_a', a, { nodeId: 'node_a' })
    reg.connect('local:node_b', sock(), { nodeId: 'node_b' })
    expect(reg.pick('local')).toBe('local:node_a')
    reg.disconnect('local:node_a', a)
    expect(reg.pick('local')).toBe('local:node_b')
    expect(reg.hasBrowser('local')).toBe(true)
  })

  it('只有老扩展（兼容槽）时，行为与升级前一致', () => {
    const { reg } = makeLocal()
    reg.connect('local', sock())
    expect(reg.pick('local')).toBe('local')
    expect(reg.hasBrowser('local')).toBe(true)
  })

  it('带 nodeId 的连接报一次 onNodeSeen（设备、绑定、profile）', () => {
    const { reg, seen } = makeLocal()
    reg.connect('local:node_a', sock(), { nodeId: 'node_a', profileName: '工作' })
    reg.connect('local', sock())
    expect(seen).toEqual([{ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', profileName: '工作' }])
  })
})

describe('registry.local 门面', () => {
  it('执行外每次调用都落在本机此刻的默认节点上', async () => {
    const { reg } = makeLocal()
    const hits: string[] = []
    reg.connect('local:node_a', answering(reg, 'local:node_a', hits), { nodeId: 'node_a' })
    await reg.local.list()
    reg.connect('local:node_b', answering(reg, 'local:node_b', hits), { nodeId: 'node_b' })
    await reg.local.list()
    expect(hits).toEqual(['local:node_a:list', 'local:node_b:list'])
  })

  it('【Risks】一次执行内所有 relay 调用落在同一个节点上——中途连上的 profile 接不走它', async () => {
    const { reg } = makeLocal()
    const hits: string[] = []
    reg.connect('local:node_a', answering(reg, 'local:node_a', hits), { nodeId: 'node_a' })
    await runOnDevice({ deviceId: 'local', allowHosts: [] }, async () => {
      await reg.local.list()
      reg.connect('local:node_b', answering(reg, 'local:node_b', hits), { nodeId: 'node_b' })
      await reg.local.cookieNames('xiaohongshu.com')
      const sub = await reg.local.subscribe(1, ['Network'])
      await reg.local.unsubscribe(sub)
      expect(reg.local.connected).toBe(true)
      expect(pickBrowser(reg)).toBe('local:node_a')
    })
    expect(hits).toEqual(['local:node_a:list', 'local:node_a:cookieNames', 'local:node_a:subscribe', 'local:node_a:unsubscribe'])
    // 执行外，默认（最近连上）已经是 b
    await reg.local.list()
    expect(hits.at(-1)).toBe('local:node_b:list')
  })

  it('远程设备上的执行里，门面仍只解析本机，且不钉住远程执行的记号', async () => {
    const { reg } = makeLocal()
    const hits: string[] = []
    reg.connect('local:node_a', answering(reg, 'local:node_a', hits), { nodeId: 'node_a' })
    const browser: { bindingId?: string } = {}
    await runOnDevice({ deviceId: 'linux:nas', allowHosts: [], browser }, async () => { await reg.local.list() })
    expect(hits).toEqual(['local:node_a:list'])
    expect(browser.bindingId).toBeUndefined()
  })

  it('onConnected / onCookiesChanged 扇出到每一条本机 relay，含之后才连上的节点', () => {
    const { reg } = makeLocal()
    const calls: string[] = []
    reg.local.onConnected(() => calls.push('connected'))
    reg.local.onCookiesChanged((d) => calls.push(`changed:${d.join(',')}`))
    reg.connect('local', sock())
    reg.connect('local:node_a', sock(), { nodeId: 'node_a' })
    reg.handleMessage('local:node_a', JSON.stringify({ type: 'cookies-changed', domains: ['a.com'] }))
    expect(calls).toEqual(['connected', 'connected', 'changed:a.com'])
  })

  it('connected / status 跟着解析结果走：本机一个都不在线 = 兼容槽的状态', () => {
    const { reg } = makeLocal()
    expect(reg.local.connected).toBe(false)
    expect(reg.local.status()).toEqual({ connected: false, since: null })
    reg.connect('local:node_a', sock(), { nodeId: 'node_a' })
    expect(reg.local.connected).toBe(true)
  })
})
