import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiteIdentityStore } from './identity-store.ts'
import { makeIdentityService, type IdentityFacility, type IdentityServiceDeps } from './identity-service.ts'
import type { ProbeNode } from './prober.ts'
import type { ProbeResult } from './whoami.ts'
import { loginAccountId } from './whoami.ts'

const WORK: ProbeNode = { nodeId: 'node_work', deviceId: 'local', bindingId: 'local:node_work' }
const HOME: ProbeNode = { nodeId: 'node_home', deviceId: 'local', bindingId: 'local:node_home' }
const NODES = [WORK, HOME]
const PROFILES: Record<string, string> = { node_work: '工作', node_home: '个人' }

const XHS: IdentityFacility = {
  facility: 'xhs',
  hosts: ['xiaohongshu.com'],
  whoami: { kind: 'page', url: 'https://www.xiaohongshu.com/explore', id: '__INITIAL_STATE__.user.userInfo.userId', signedIn: '__INITIAL_STATE__.user.loggedIn' },
  session: { type: 'session', facility: 'xhs', login: 'qr', loginUrl: 'https://www.xiaohongshu.com', qrSelector: 'img', cookieDomain: 'xiaohongshu.com', sessionCookies: ['web_session'] },
}
const BILI: IdentityFacility = {
  facility: 'bilibili',
  hosts: ['bilibili.com'],
  whoami: { kind: 'http', url: 'https://api.bilibili.com/x/web-interface/nav', id: 'data.mid' },
}
const ZZ: IdentityFacility = {
  facility: 'zhuanzhuan',
  hosts: ['zhuanzhuan.com'],
  session: { type: 'session', facility: 'zhuanzhuan', login: 'qr', loginUrl: 'https://m.zhuanzhuan.com', qrSelector: 'img', cookieDomain: 'zhuanzhuan.com', sessionCookies: ['tk'] },
}
const EM: IdentityFacility = { facility: 'eastmoney', hosts: ['eastmoneysec.com'], whoami: { kind: 'login', param: 'zjzh' } }

function setup(opts: Partial<Omit<IdentityServiceDeps, 'facilities'>> & { facilities?: IdentityFacility[]; cookies?: Record<string, string[]>; answers?: Record<string, ProbeResult> } = {}) {
  const { facilities, cookies: c0, answers: a0, ...over } = opts
  const store = new SiteIdentityStore(join(mkdtempSync(join(tmpdir(), 'idsvc-')), 'stream.db'))
  // 节点 → 域 → 在场的 cookie 名
  const cookies = c0 ?? {}
  const answers = a0 ?? {}
  const fp: Record<string, string | null> = {}
  const probe = vi.fn(async (node: ProbeNode, w: { kind: string }) =>
    answers[`${w.kind === 'page' ? 'xhs' : 'bilibili'}@${node.nodeId}`] ?? ({ state: 'unknown', reason: 'no answer' } as ProbeResult))
  const svc = makeIdentityService({
    facilities: () => facilities ?? [XHS, BILI, ZZ, EM],
    nodeOfBinding: (b) => NODES.find((n) => n.bindingId === b),
    onlineNodes: () => NODES,
    profileName: (id) => PROFILES[id],
    cookieNames: async (node, domain) => cookies[`${node.nodeId}:${domain}`] ?? [],
    sessionFingerprint: async (node, domain) => fp[`${node.nodeId}:${domain}`],
    loginAccount: () => '540123456789',
    prober: { probe },
    store,
    debounceMs: 5,
    ...over,
  })
  return { svc, store, probe, fp, cookies, answers }
}

describe('节点连上', () => {
  it('只探会话 cookie 在场的；http 没有在场证据也探；login 不探', async () => {
    const { svc, store, probe } = setup({
      cookies: { 'node_work:xiaohongshu.com': ['web_session'] },
      answers: { 'xhs@node_work': { state: 'signed-in', accountId: 'B', name: '工作号B' }, 'bilibili@node_work': { state: 'signed-in', accountId: '123' } },
    })
    await svc.nodeConnected(WORK.bindingId)
    expect(probe.mock.calls.map(([, w]) => w.kind).sort()).toEqual(['http', 'page'])
    expect(store.get('xhs', 'node_work')).toMatchObject({ accountId: 'B', state: 'signed-in' })
    expect(store.get('bilibili', 'node_work')).toMatchObject({ accountId: '123' })
    expect(store.get('eastmoney', 'node_work')).toBeUndefined()
  })

  it('会话 cookie 不在（GONE）：不开标签；已有记录标登出，没有就不建', async () => {
    const { svc, store, probe } = setup({ facilities: [XHS] })
    await svc.nodeConnected(WORK.bindingId)
    expect(probe).not.toHaveBeenCalled()
    expect(store.get('xhs', 'node_work')).toBeUndefined()
    store.record('xhs', 'node_work', { state: 'signed-in', accountId: 'B' })
    await svc.nodeConnected(WORK.bindingId)
    expect(store.get('xhs', 'node_work')).toMatchObject({ accountId: 'B', state: 'signed-out' })
  })

  it('说不出节点的连接（兼容槽）跳过', async () => {
    const { svc, probe } = setup()
    expect(await svc.nodeConnected('local')).toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })

  it('探测 unknown：表里原有的记录保持原样', async () => {
    const { svc, store } = setup({ facilities: [BILI] })
    store.record('bilibili', 'node_work', { state: 'signed-in', accountId: '123' })
    await svc.nodeConnected(WORK.bindingId)
    expect(store.get('bilibili', 'node_work')).toMatchObject({ accountId: '123', state: 'signed-in' })
  })
})

describe('没有 whoami 的 facility', () => {
  it('两个节点上会话都在 → 两个身份：「工作 上的账号」「个人 上的账号」', async () => {
    const { svc } = setup({ facilities: [ZZ], cookies: { 'node_work:zhuanzhuan.com': ['tk'], 'node_home:zhuanzhuan.com': ['tk'] } })
    await svc.nodeConnected(WORK.bindingId)
    await svc.nodeConnected(HOME.bindingId)
    expect(svc.list({ facility: 'zhuanzhuan' }).map((i) => [i.accountId, i.displayName])).toEqual([
      ['node:node_home', '个人 上的账号'],
      ['node:node_work', '工作 上的账号'],
    ])
  })
})

describe('会话 cookie 变化', () => {
  it('用户在「工作」里把小红书换成个人号A：指纹变了 → 重新探测，记录变为 A', async () => {
    const { svc, store, probe, fp, answers } = setup({
      facilities: [XHS],
      cookies: { 'node_work:xiaohongshu.com': ['web_session'] },
      answers: { 'xhs@node_work': { state: 'signed-in', accountId: 'B' } },
    })
    fp['node_work:xiaohongshu.com'] = 'fp-B'
    await svc.nodeConnected(WORK.bindingId)
    expect(store.get('xhs', 'node_work')?.accountId).toBe('B')

    // 别的 cookie 在轮换，会话 cookie 没变：不探。
    svc.cookiesChanged(WORK.bindingId, ['.xiaohongshu.com'])
    await new Promise((r) => setTimeout(r, 30))
    expect(probe).toHaveBeenCalledTimes(1)

    fp['node_work:xiaohongshu.com'] = 'fp-A'
    answers['xhs@node_work'] = { state: 'signed-in', accountId: 'A', name: '个人号A' }
    svc.cookiesChanged(WORK.bindingId, ['xiaohongshu.com'])
    svc.cookiesChanged(WORK.bindingId, ['www.xiaohongshu.com']) // 连发合并成一次
    await new Promise((r) => setTimeout(r, 30))
    expect(probe).toHaveBeenCalledTimes(2)
    expect(store.get('xhs', 'node_work')).toMatchObject({ accountId: 'A', displayName: '个人号A' })
  })

  it('会话 cookie 没了 → 标登出、保留账号；别的域变化不碰它', async () => {
    const { svc, store, probe, fp } = setup({ facilities: [XHS], answers: { 'xhs@node_work': { state: 'signed-in', accountId: 'B' } } })
    fp['node_work:xiaohongshu.com'] = 'fp-B'
    await svc.refresh()
    svc.cookiesChanged(WORK.bindingId, ['bilibili.com'])
    await new Promise((r) => setTimeout(r, 30))
    expect(store.get('xhs', 'node_work')?.state).toBe('signed-in')
    fp['node_work:xiaohongshu.com'] = null
    svc.cookiesChanged(WORK.bindingId, ['xiaohongshu.com'])
    await new Promise((r) => setTimeout(r, 30))
    expect(store.get('xhs', 'node_work')).toMatchObject({ accountId: 'B', state: 'signed-out' })
    expect(probe).toHaveBeenCalledTimes(2) // refresh 时 work + home 各一次
  })

  it('没声明会话 cookie：按最短间隔，不是每次都探', async () => {
    let t = 0
    const { svc, probe } = setup({ facilities: [BILI], now: () => t })
    svc.cookiesChanged(WORK.bindingId, ['bilibili.com'])
    await new Promise((r) => setTimeout(r, 30))
    svc.cookiesChanged(WORK.bindingId, ['bilibili.com'])
    await new Promise((r) => setTimeout(r, 30))
    expect(probe).toHaveBeenCalledTimes(1)
    t = 11 * 60_000
    svc.cookiesChanged(WORK.bindingId, ['bilibili.com'])
    await new Promise((r) => setTimeout(r, 30))
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('手动刷新', () => {
  it('按节点 / facility 收窄', async () => {
    const { svc, probe } = setup()
    await svc.refresh({ nodeId: 'node_home', facility: 'bilibili' })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]![0]).toBe(HOME)
    await svc.refresh()
    expect(probe).toHaveBeenCalledTimes(1 + 4) // 2 节点 × (xhs, bilibili)；zhuanzhuan 看 cookie，eastmoney 不探
  })
})

describe('ctx.login 之后', () => {
  it('login 形状：直接写哈希 + 打码，不探测，明文不落库', async () => {
    const { svc, store, probe } = setup()
    await svc.afterLogin('eastmoney', WORK.bindingId)
    expect(probe).not.toHaveBeenCalled()
    expect(store.get('eastmoney', 'node_work')).toMatchObject({ accountId: loginAccountId('540123456789'), displayName: '54****89', state: 'signed-in' })
    expect(JSON.stringify(store.list())).not.toContain('540123456789')
  })

  it('page / http 形状：在登录用的那个节点上重新探测', async () => {
    const { svc, store, probe } = setup({ answers: { 'xhs@node_home': { state: 'signed-in', accountId: 'A' } } })
    await svc.afterLogin('xhs', HOME.bindingId)
    expect(probe).toHaveBeenCalledWith(HOME, XHS.whoami, XHS.hosts)
    expect(store.get('xhs', 'node_home')?.accountId).toBe('A')
  })

  it('没有 whoami：登上即这个节点上的账号', async () => {
    const { svc, store } = setup()
    await svc.afterLogin('zhuanzhuan', WORK.bindingId)
    expect(store.get('zhuanzhuan', 'node_work')).toMatchObject({ accountId: 'node:node_work', state: 'signed-in' })
  })
})
