import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeStore } from './node-store.ts'
import { CLAIM_TTL_MS, CLAIM_WAIT_MS, MISSING_REASON, ProfileClaims, type ClaimAgent } from './profile-claim.ts'

const EXT = 'dmhlfkdjljnilhnfajjpaobehenbokij'
const LIST = {
  userDataDir: 'C:\\U',
  profiles: [
    { dir: 'Default', name: '工作', gaiaEmail: 'w@example.com' },
    { dir: 'Profile 1', name: '个人' },
  ],
  lastActive: ['Default'],
}

function rig(opts: { ops?: string[]; claimFails?: string; list?: unknown } = {}) {
  let t = 1_000
  const nodes = new NodeStore(join(mkdtempSync(join(tmpdir(), 'claim-')), 'stream.db'), { now: () => t })
  const sent: Array<{ op: string; args?: Record<string, unknown> }> = []
  const agent: ClaimAgent = {
    deviceId: 'desktop:pc',
    extDeviceId: 'local',
    ops: new Set(opts.ops ?? ['browser.profiles', 'browser.claim']),
    async send(op) {
      sent.push(op)
      if (op.op === 'browser.profiles') return opts.list ?? LIST
      if (opts.claimFails && op.args?.profileDirectory === opts.claimFails) throw new Error('spawn failed')
      return { launched: true }
    },
  }
  // 绑定 → 设备 / 节点：本机节点 `local:<nodeId>`，NAS 上的配对绑定 `ext:nas`。
  const deviceOf = (b: string) => (b.startsWith('local') ? 'local' : b === 'ext:nas' ? 'linux:nas' : undefined)
  const nodeOf = (b: string) => (b.startsWith('local:') ? b.slice(6) : b === 'ext:nas' ? 'node_nas' : undefined)
  let n = 0
  const claims = new ProfileClaims({
    agent: (id) => (id === 'desktop:pc' ? agent : undefined),
    nodes, deviceOf, nodeOf, extId: EXT,
    now: () => t,
    nonce: () => `n${++n}`,
  })
  const connect = (nodeId: string, deviceId = 'local', bindingId = `local:${nodeId}`) => {
    nodes.seen({ nodeId, deviceId, bindingId })
    claims.onBindingConnected(bindingId)
  }
  const claimUrls = () => sent.filter((s) => s.op === 'browser.claim').map((s) => `${s.args?.profileDirectory}|${s.args?.url}`)
  return { claims, nodes, sent, claimUrls, connect, advance: (ms: number) => { t += ms; vi.advanceTimersByTime(ms) } }
}

afterEach(() => { vi.useRealTimers() })

describe('ProfileClaims', () => {
  it('discover：列出 profile，标出开着的与已认领的；按目录刷新显示名', async () => {
    const r = rig()
    r.nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a', profileDir: 'Default', profileName: '旧名' })
    const d = await r.claims.discover('desktop:pc')
    expect(d).toEqual({
      deviceId: 'desktop:pc', userDataDir: 'C:\\U',
      profiles: [
        { dir: 'Default', name: '工作', gaiaEmail: 'w@example.com', active: true, nodeId: 'node_a' },
        { dir: 'Profile 1', name: '个人', active: false },
      ],
    })
    expect(r.nodes.get('node_a')?.profileName).toBe('工作')
    expect(r.claimUrls()).toEqual([])
  })

  it('discover：带上每个 profile 装没装扩展（agent 说得出时），并告诉 agent 看哪个扩展', async () => {
    const r = rig({ list: { ...LIST, profiles: [
      { dir: 'Default', name: '工作', hasExtension: true },
      { dir: 'Profile 1', name: '个人', hasExtension: false },
      { dir: 'Profile 2', name: '老 agent', hasExtension: 'yes' },
    ] } })
    const d = await r.claims.discover('desktop:pc')
    expect(d.profiles.map((p) => [p.dir, p.hasExtension])).toEqual([['Default', true], ['Profile 1', false], ['Profile 2', undefined]])
    expect('hasExtension' in d.profiles[2]).toBe(false)
    expect(r.sent[0]).toEqual({ op: 'browser.profiles', args: { extensionId: EXT } })
  })

  it('不在线 / 没声明 op 的设备说清楚', async () => {
    await expect(rig().claims.start('desktop:gone')).rejects.toMatchObject({ code: 'device-offline' })
    await expect(rig({ ops: ['browser.profiles'] }).claims.start('desktop:pc')).rejects.toMatchObject({ code: 'device-incapable' })
    await expect(rig({ ops: [] }).claims.discover('desktop:pc')).rejects.toMatchObject({ code: 'device-incapable' })
  })

  it('start：每个 profile 一个 nonce、一次 browser.claim；本机节点交回 → 节点记下目录与名字', async () => {
    vi.useFakeTimers()
    const r = rig()
    const s = await r.claims.start('desktop:pc')
    expect(r.claimUrls()).toEqual([
      `Default|chrome-extension://${EXT}/claim.html#n=n1`,
      `Profile 1|chrome-extension://${EXT}/claim.html#n=n2`,
    ])
    expect(s.profiles.map((p) => p.state)).toEqual(['pending', 'pending'])
    r.nodes.seen({ nodeId: 'node_b', deviceId: 'local', bindingId: 'local:node_b' })
    expect(r.claims.redeem('local:node_b', 'n2')).toEqual({ ok: true, profileDir: 'Profile 1', profileName: '个人', nodeId: 'node_b' })
    expect(r.nodes.get('node_b')).toMatchObject({ profileDir: 'Profile 1', profileName: '个人' })
    expect(r.claims.get(s.claimId)?.profiles[1]).toEqual({ dir: 'Profile 1', name: '个人', state: 'claimed', nodeId: 'node_b' })
    // 一次性
    expect(r.claims.redeem('local:node_b', 'n2').ok).toBe(false)
  })

  it('start 只认领指定的 profile：其余的不开页面、不进结果；指定了不存在的目录就拒', async () => {
    vi.useFakeTimers()
    const r = rig()
    const s = await r.claims.start('desktop:pc', { dirs: ['Profile 1'] })
    expect(r.claimUrls()).toEqual([`Profile 1|chrome-extension://${EXT}/claim.html#n=n1`])
    expect(s.profiles.map((p) => p.dir)).toEqual(['Profile 1'])
    await expect(rig().claims.start('desktop:pc', { dirs: ['Profile 9'] })).rejects.toThrow('Profile 9')
  })

  it('别的机器交回 nonce：拒绝，任何节点都不动，nonce 留给这台机器', async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.claims.start('desktop:pc')
    r.nodes.seen({ nodeId: 'node_nas', deviceId: 'linux:nas', bindingId: 'ext:nas' })
    expect(r.claims.redeem('ext:nas', 'n1')).toEqual({ ok: false, error: expect.stringContaining('不是给这台机器的') })
    expect(r.nodes.get('node_nas')?.profileDir).toBeUndefined()
    r.nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    expect(r.claims.redeem('local:node_a', 'n1').ok).toBe(true)
  })

  it('兼容槽（老扩展，没有节点）交回：拒', async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.claims.start('desktop:pc')
    expect(r.claims.redeem('local', 'n1')).toEqual({ ok: false, error: expect.stringContaining('扩展太旧') })
  })

  it('20 秒没交回 → 扩展未安装或未连上，别的 profile 不受影响；2 分钟内晚到的照样记下，过了就拒', async () => {
    vi.useFakeTimers()
    const r = rig()
    const s = await r.claims.start('desktop:pc')
    r.nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    expect(r.claims.redeem('local:node_a', 'n1').ok).toBe(true)
    r.advance(CLAIM_WAIT_MS)
    const snap = r.claims.get(s.claimId)!
    expect(snap.done).toBe(true)
    expect(snap.profiles.map((p) => [p.state, p.reason])).toEqual([['claimed', undefined], ['missing', MISSING_REASON]])
    r.nodes.seen({ nodeId: 'node_b', deviceId: 'local', bindingId: 'local:node_b' })
    expect(r.claims.redeem('local:node_b', 'n2').ok).toBe(true)
    expect(r.claims.get(s.claimId)!.profiles[1]?.state).toBe('claimed')
    const again = await r.claims.start('desktop:pc')
    r.advance(CLAIM_TTL_MS)
    expect(r.claims.get(again.claimId)).toBeUndefined()
    expect(r.claims.redeem('local:node_b', 'n4').ok).toBe(false)
  })

  it('browser.claim 失败的 profile 标 failed，别的照常', async () => {
    vi.useFakeTimers()
    const r = rig({ claimFails: 'Default' })
    const s = await r.claims.start('desktop:pc')
    expect(s.profiles.map((p) => [p.state, p.reason])).toEqual([['failed', 'spawn failed'], ['pending', undefined]])
  })

  it('新 profile 的竞态：等待中新连上一个未认领节点 → 对在等的 profile 各补发一次，只一次', async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.claims.start('desktop:pc')
    r.nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    r.claims.redeem('local:node_a', 'n1')
    // 已认领的节点重连：不补发
    r.claims.onBindingConnected('local:node_a')
    // 别的设备上的节点：不补发
    r.connect('node_nas', 'linux:nas', 'ext:nas')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.claimUrls()).toHaveLength(2)
    r.connect('node_new')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.claimUrls()).toEqual([
      `Default|chrome-extension://${EXT}/claim.html#n=n1`,
      `Profile 1|chrome-extension://${EXT}/claim.html#n=n2`,
      `Profile 1|chrome-extension://${EXT}/claim.html#n=n2`,
    ])
    r.connect('node_newer')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.claimUrls()).toHaveLength(3)
  })

  it('等待窗口过了再连上：不补发', async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.claims.start('desktop:pc')
    r.advance(CLAIM_WAIT_MS + 1)
    r.connect('node_late')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.claimUrls()).toHaveLength(2)
  })

  it('同一台设备再点一次：旧会话作废', async () => {
    vi.useFakeTimers()
    const r = rig()
    const first = await r.claims.start('desktop:pc')
    await r.claims.start('desktop:pc')
    expect(r.claims.get(first.claimId)).toBeUndefined()
    r.nodes.seen({ nodeId: 'node_a', deviceId: 'local', bindingId: 'local:node_a' })
    expect(r.claims.redeem('local:node_a', 'n1').ok).toBe(false)
    expect(r.claims.redeem('local:node_a', 'n3').ok).toBe(true)
  })
})
