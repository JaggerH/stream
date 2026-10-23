import { describe, it, expect } from 'vitest'
import { IdentityMismatch, IdentityOffline, IdentitySignedOut } from '../devices/errors.ts'
import type { SiteIdentity } from './identity-store.ts'
import type { ProbeResult } from './whoami.ts'
import { makeIdentityRouter, type IdentityRouterDeps, type IdentityTarget, type RouterNode } from './identity-router.ts'

const NODES: Record<string, RouterNode> = {
  node_work: { nodeId: 'node_work', deviceId: 'local', bindingId: 'local:node_work', profileDir: 'Profile 1', profileName: '工作', environment: '工作' },
  node_home: { nodeId: 'node_home', deviceId: 'local', bindingId: 'local:node_home', profileDir: 'Default', profileName: '个人', environment: '个人' },
  node_lap: { nodeId: 'node_lap', deviceId: 'linux:lap', bindingId: 'ext:lap', profileName: '笔记本', environment: '个人' },
}

const row = (nodeId: string, accountId: string, verifiedAt: number, state: SiteIdentity['state'] = 'signed-in'): SiteIdentity =>
  ({ facility: 'xhs', nodeId, accountId, displayName: `号${accountId}`, state, verifiedAt })

function world(rows: SiteIdentity[], online: string[], over: Partial<IdentityRouterDeps> = {}) {
  const deps: IdentityRouterDeps = {
    identities: (f) => rows.filter((r) => r.facility === f),
    node: (id) => NODES[id],
    isOnline: (b) => online.includes(b),
    now: () => 1_000_000,
    ...over,
  }
  return makeIdentityRouter(deps)
}

describe('IdentityRouter：选节点（D7）', () => {
  it('身份目标：该账号 signed-in 的节点；在线优先', async () => {
    const r = world([row('node_work', 'B', 10), row('node_lap', 'B', 50), row('node_home', 'A', 99)], ['local:node_work'])
    const got = await r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' })
    expect(got.node.nodeId).toBe('node_work')
    expect(got.identity).toEqual({ facility: 'xhs', accountId: 'B', accountName: '号B', nodeId: 'node_work' })
  })

  it('同为在线取最近核对过的', async () => {
    const r = world([row('node_work', 'B', 10), row('node_lap', 'B', 50)], ['local:node_work', 'ext:lap'])
    expect((await r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' })).node.nodeId).toBe('node_lap')
  })

  it('环境目标：该环境里该 facility signed-in 的节点，不论账号', async () => {
    const r = world([row('node_work', 'B', 10), row('node_home', 'A', 20), row('node_lap', 'C', 30)], ['local:node_home', 'local:node_work'])
    const got = await r.resolve({ target: { kind: 'environment', environment: '个人' }, facility: 'xhs', purpose: 'harvest' })
    expect(got.node.nodeId).toBe('node_home')
    expect(got.identity.accountId).toBe('A')
  })

  it('signed-out 的行不是候选；别的 facility 的行不算', async () => {
    const rows = [row('node_work', 'B', 10, 'signed-out'), { ...row('node_home', 'B', 10), facility: 'bilibili' }]
    const r = world(rows, ['local:node_work', 'local:node_home'])
    await expect(r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' })).rejects.toBeInstanceOf(IdentityOffline)
  })

  it('候选为空 → identity-offline，不回落（别的在线节点不被选）', async () => {
    const r = world([row('node_home', 'A', 10)], ['local:node_home'])
    const e = await r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' }).catch((x) => x)
    expect(e).toBeInstanceOf(IdentityOffline)
    expect(e.message).toContain('身份 xhs:B')
  })

  it('候选都离线 → identity-offline', async () => {
    const r = world([row('node_lap', 'B', 10)], ['local:node_home'])
    await expect(r.resolve({ target: { kind: 'identity', accountId: 'B' }, facility: 'xhs', purpose: 'action' })).rejects.toBeInstanceOf(IdentityOffline)
  })
})

describe('IdentityRouter：按需唤起（D8）', () => {
  /** 一台设备的 agent：收到 ensureApp 后让那条绑定上线（或者不上线）。 */
  function wakeWorld(opts: { comesUp?: boolean; ops?: string[]; agentOnline?: boolean; launch?: { exe?: string } } = {}) {
    const online = new Set<string>()
    const sent: Array<{ op: string; args?: Record<string, unknown> }> = []
    const woken: Array<[string, number | null]> = []
    const r = world([row('node_work', 'B', 10), row('node_lap', 'B', 5)], [], {
      isOnline: (b) => online.has(b),
      agent: (d) => (d === 'local' && opts.agentOnline !== false ? {
        ops: new Set(opts.ops ?? ['ensureApp']),
        send: async (op) => {
          sent.push(op)
          await new Promise((res) => setTimeout(res, 5))
          if (opts.comesUp !== false) online.add('local:node_work')
          return { running: true, started: true }
        },
      } : undefined),
      ...(opts.launch ? { launchBase: () => opts.launch! } : {}),
      waitOnline: async (b) => online.has(b),
      setWokenAt: (n, t) => void woken.push([n, t]),
    })
    return { r, sent, woken, online }
  }
  const req = { target: { kind: 'identity', accountId: 'B' } as const, facility: 'xhs', purpose: 'harvest' as const }

  it('候选全离线、有 profile 目录、agent 在线 → 静默唤起、等它连上、记 woken_at', async () => {
    const { r, sent, woken } = wakeWorld({ launch: { exe: '/opt/cft/chrome' } })
    const got = await r.resolve(req)
    expect(got.node.nodeId).toBe('node_work')
    expect(sent).toEqual([{ op: 'ensureApp', args: { exe: '/opt/cft/chrome', profileDirectory: 'Profile 1', force: true, args: ['--no-startup-window'] } }])
    expect(woken).toEqual([['node_work', 1_000_000]])
  })

  it('同一节点并发两次只唤起一次，两个都拿到它', async () => {
    const { r, sent } = wakeWorld()
    const [a, b] = await Promise.all([r.resolve(req), r.resolve(req)])
    expect(sent).toHaveLength(1)
    expect(a.node.nodeId).toBe('node_work')
    expect(b.node.nodeId).toBe('node_work')
  })

  it('等不到它连上 → identity-offline，不记 woken_at', async () => {
    const { r, woken } = wakeWorld({ comesUp: false })
    await expect(r.resolve(req)).rejects.toBeInstanceOf(IdentityOffline)
    expect(woken).toEqual([])
  })

  it('agent 不在线 / 没有 ensureApp → 不唤起', async () => {
    for (const o of [{ agentOnline: false }, { ops: ['http.fetch'] }]) {
      const { r, sent } = wakeWorld(o)
      await expect(r.resolve(req)).rejects.toBeInstanceOf(IdentityOffline)
      expect(sent).toEqual([])
    }
  })

  it('节点没记 profile 目录（没认领过）→ 不唤起', async () => {
    const sent: unknown[] = []
    const r = world([row('node_lap', 'B', 10)], [], { agent: () => ({ ops: new Set(['ensureApp']), send: async (op) => { sent.push(op) } }), waitOnline: async () => true })
    await expect(r.resolve(req)).rejects.toBeInstanceOf(IdentityOffline)
    expect(sent).toEqual([])
  })

  it('agent 回 running:false → 不等、identity-offline', async () => {
    let waited = false
    const r = world([row('node_work', 'B', 10)], [], {
      agent: () => ({ ops: new Set(['ensureApp']), send: async () => ({ running: false }) }),
      waitOnline: async () => { waited = true; return true },
    })
    await expect(r.resolve(req)).rejects.toBeInstanceOf(IdentityOffline)
    expect(waited).toBe(false)
  })
})

describe('IdentityRouter：唤起的 profile 收回去（D8）', () => {
  function holdWorld(opts: { wokenAt?: number; release?: (online: string[]) => Promise<{ userWindows: number; unloading: boolean }>; reconnects?: boolean } = {}) {
    const nodes: Record<string, RouterNode> = { node_work: { ...NODES.node_work!, ...(opts.wokenAt !== undefined ? { wokenAt: opts.wokenAt } : {}) } }
    const calls: string[] = []
    const online = ['local:node_work']
    const r = world([row('node_work', 'B', 10)], online, {
      waitOnline: async (b) => {
        if (opts.reconnects && !online.includes(b)) online.push(b)
        return online.includes(b)
      },
      node: (id) => nodes[id],
      setWokenAt: (id, t) => {
        calls.push(`woken:${t}`)
        const n = nodes[id]!
        if (t === null) delete n.wokenAt
        else n.wokenAt = t
      },
      holdProfile: async (b) => void calls.push(`hold:${b}`),
      releaseProfile: async (b) => {
        calls.push(`release:${b}`)
        return opts.release ? opts.release(online) : { userWindows: 0, unloading: true }
      },
    })
    return { r, calls, nodes }
  }
  const req = { target: { kind: 'identity', accountId: 'B' } as const, facility: 'xhs', purpose: 'action' as const }

  it('woken_at 非空：开始时按住，结束时放掉并清 woken_at；release 只生效一次', async () => {
    const { r, calls, nodes } = holdWorld({ wokenAt: 5 })
    const got = await r.resolve(req)
    expect(calls).toEqual(['hold:local:node_work'])
    await got.release()
    await got.release()
    expect(calls).toEqual(['hold:local:node_work', 'release:local:node_work', 'woken:null'])
    expect(nodes.node_work!.wokenAt).toBeUndefined()
  })

  it('同一节点并发两次：只按一次，最后一次结束才放', async () => {
    const { r, calls } = holdWorld({ wokenAt: 5 })
    const a = await r.resolve(req)
    const b = await r.resolve(req)
    expect(calls.filter((c) => c.startsWith('hold'))).toHaveLength(1)
    await a.release()
    expect(calls.some((c) => c.startsWith('release'))).toBe(false)
    await b.release()
    expect(calls.filter((c) => c.startsWith('release'))).toHaveLength(1)
  })

  it('用户自己开着那个 profile 的窗：只关我们的标签，woken_at 也清掉', async () => {
    const { r, nodes } = holdWorld({ wokenAt: 5, release: async () => ({ userWindows: 1, unloading: false }) })
    await (await r.resolve(req)).release()
    expect(nodes.node_work!.wokenAt).toBeUndefined()
  })

  it('放不掉（扩展断了 / 老扩展）→ woken_at 留着，面板照样看得见', async () => {
    const { r, nodes } = holdWorld({ wokenAt: 5, release: async () => { throw new Error('unknown op') } })
    await (await r.resolve(req)).release()
    expect(nodes.node_work!.wokenAt).toBe(5)
  })

  it('放的时候扩展断开、没再连回来 → profile 卸载了，算收回，woken_at 清掉', async () => {
    const { r, nodes } = holdWorld({ wokenAt: 5, release: async (online) => { online.length = 0; throw new Error('ext-relay socket disconnected') } })
    await (await r.resolve(req)).release()
    expect(nodes.node_work!.wokenAt).toBeUndefined()
  })

  it('放的时候扩展断开、又连回来了（SW 重启）→ profile 还开着，woken_at 留着', async () => {
    const { r, nodes } = holdWorld({ wokenAt: 5, reconnects: true, release: async (online) => { online.length = 0; throw new Error('ext-relay socket disconnected') } })
    await (await r.resolve(req)).release()
    expect(nodes.node_work!.wokenAt).toBe(5)
  })

  it('不是 Stream 唤起的节点（用户自己开着的）：不按、不放', async () => {
    const { r, calls } = holdWorld()
    await (await r.resolve(req)).release()
    expect(calls).toEqual([])
  })
})

describe('IdentityRouter：执行前核对（D9）', () => {
  const NOW = 1_000_000
  function verifyWorld(verifiedAt: number, answer: ProbeResult | undefined, extra: Partial<IdentityRouterDeps> = {}) {
    const asked: string[] = []
    const r = world([row('node_work', 'B', verifiedAt)], ['local:node_work'], {
      verify: async (f, n) => { asked.push(`${f}@${n.nodeId}`); return answer },
      ...extra,
    })
    return { r, asked }
  }
  const req = (purpose: 'action' | 'harvest', target: IdentityTarget = { kind: 'identity', accountId: 'B' }) => ({ target, facility: 'xhs', purpose })

  it('记录够新不核对：动作 60 秒、采集 10 分钟', async () => {
    const a = verifyWorld(NOW - 59_000, { state: 'signed-out' })
    await a.r.resolve(req('action'))
    expect(a.asked).toEqual([])
    const h = verifyWorld(NOW - 9 * 60_000, { state: 'signed-out' })
    await h.r.resolve(req('harvest'))
    expect(h.asked).toEqual([])
  })

  it('不够新：在选中的节点上核对；一致就放行，带上此刻的显示名', async () => {
    const { r, asked } = verifyWorld(NOW - 61_000, { state: 'signed-in', accountId: 'B', name: '工作号B（新昵称）' })
    const got = await r.resolve(req('action'))
    expect(asked).toEqual(['xhs@node_work'])
    expect(got.identity.accountName).toBe('工作号B（新昵称）')
  })

  it('核对出另一个账号 → identity-mismatch，指名 profile', async () => {
    const { r } = verifyWorld(0, { state: 'signed-in', accountId: 'A', name: '个人号A' })
    const e = await r.resolve(req('action')).catch((x) => x)
    expect(e).toBeInstanceOf(IdentityMismatch)
    expect(e.message).toContain('「工作」')
    expect(e.message).toContain('个人号A')
  })

  it('环境目标：环境里换了号同样拦下', async () => {
    const { r } = verifyWorld(0, { state: 'signed-in', accountId: 'A' })
    await expect(r.resolve(req('harvest', { kind: 'environment', environment: '工作' }))).rejects.toBeInstanceOf(IdentityMismatch)
  })

  it('已登出 → identity-signed-out；问不出来 → identity-offline', async () => {
    await expect(verifyWorld(0, { state: 'signed-out' }).r.resolve(req('action'))).rejects.toBeInstanceOf(IdentitySignedOut)
    await expect(verifyWorld(0, { state: 'unknown', reason: '页面打不开' }).r.resolve(req('action'))).rejects.toBeInstanceOf(IdentityOffline)
  })

  it('这个 facility 不核对（没有 whoami / login 形状）→ 直接放行', async () => {
    const got = await verifyWorld(0, undefined).r.resolve(req('action'))
    expect(got.identity.accountName).toBe('号B')
  })

  it('换号通知：identity.mismatch，标题指名 profile 与环境、说出现在登的是谁；按节点去重', async () => {
    const events: Array<Record<string, unknown>> = []
    const { r } = verifyWorld(0, { state: 'signed-in', accountId: 'A', name: '个人号A' }, {
      notify: (e) => void events.push(e as never),
      facilityLabel: () => '小红书',
      node: (id) => (id === 'node_work' ? { ...NODES.node_work!, environment: '公司' } : NODES[id]),
    })
    await r.resolve(req('action')).catch(() => {})
    expect(events).toEqual([expect.objectContaining({
      type: 'identity.mismatch', severity: 'warn',
      title: '「工作」（环境：公司）里的小红书现在登的是 个人号A',
      ref: { kind: 'facility', id: 'xhs' },
      dedupeKey: 'identity-mismatch:xhs:node_work',
    })])
    expect(String(events[0]!.body)).toContain('号B')
  })

  it('登出通知：走「需要登录」那一类事件（auth.needed），指名 profile', async () => {
    const events: Array<Record<string, unknown>> = []
    const { r } = verifyWorld(0, { state: 'signed-out' }, { notify: (e) => void events.push(e as never) })
    await r.resolve(req('action')).catch(() => {})
    expect(events).toEqual([expect.objectContaining({ type: 'auth.needed', title: 'xhs 在「工作」里登录失效', dedupeKey: 'auth:xhs:node_work' })])
  })

  it('一致 / 问不出来不发通知；通知自己抛也不遮住拦下', async () => {
    const events: unknown[] = []
    await verifyWorld(0, { state: 'signed-in', accountId: 'B' }, { notify: (e) => void events.push(e) }).r.resolve(req('action'))
    await verifyWorld(0, { state: 'unknown', reason: 'x' }, { notify: (e) => void events.push(e) }).r.resolve(req('action')).catch(() => {})
    expect(events).toEqual([])
    const boom = verifyWorld(0, { state: 'signed-out' }, { notify: () => { throw new Error('events down') } })
    await expect(boom.r.resolve(req('action'))).rejects.toBeInstanceOf(IdentitySignedOut)
  })

  it('核对失败时按住的 profile 照样放掉', async () => {
    const released: string[] = []
    const { r } = verifyWorld(0, { state: 'signed-out' }, {
      node: (id) => (id === 'node_work' ? { ...NODES.node_work!, wokenAt: 5 } : NODES[id]),
      holdProfile: async () => {},
      releaseProfile: async (b) => { released.push(b); return { userWindows: 0, unloading: true } },
    })
    await expect(r.resolve(req('action'))).rejects.toBeInstanceOf(IdentitySignedOut)
    expect(released).toEqual(['local:node_work'])
  })
})
