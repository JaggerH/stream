/**
 * 端到端（browser-identity 计划 4）：同一台机器上两个 profile 的扩展同时在线，各登一个小红书号。
 * 一条指定身份的任务，经真的 `ExtRelayRegistry` / `ExtRelay`（假 socket）、真的节点表与身份表、真的路由器与身份服务、
 * 真的 `compileUserTask` 跑一遍：
 * - 帧落在登着那个号的节点上，另一个节点一帧都收不到；
 * - 那个 profile 里的号被换掉之后，执行在派发前以 `identity-mismatch` 拦下，两个节点都没收到任何帧；
 * - 那个节点离线、又唤不起时，以 `identity-offline` 失败，另一个在线节点上没有开任何标签。
 * 不打网络、不开浏览器。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtRelay } from '../http/ext-relay.ts'
import { ExtRelayRegistry, localNodeBinding } from '../http/ext-relay-registry.ts'
import { NodeStore } from '../devices/node-store.ts'
import { placeRun } from '../devices/placement.ts'
import { LOCAL_TARGET, taskTarget } from '../devices/target.ts'
import { IdentityMismatch, IdentityOffline, failureDisposition } from '../devices/errors.ts'
import { compileUserTask } from '../tasks/user-tasks.ts'
import type { UserTaskRow } from '../tasks/task-store.ts'
import { SiteIdentityStore } from './identity-store.ts'
import { makeIdentityService, type IdentityFacility } from './identity-service.ts'
import { makeIdentityRouter } from './identity-router.ts'
import type { ProbeResult } from './whoami.ts'
import type { ExtHandshake } from '../../shared/browser-relay/handshake.ts'

const XHS: IdentityFacility = {
  facility: 'xhs',
  hosts: ['xiaohongshu.com'],
  whoami: { kind: 'page', url: 'https://www.xiaohongshu.com/explore', id: '__INITIAL_STATE__.user.userInfo.userId', signedIn: '__INITIAL_STATE__.user.loggedIn' },
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'route-e2e-'))
  let clock = 1_000_000
  const now = () => clock
  const nodes = new NodeStore(join(dir, 'stream.db'), { now })
  const identities = new SiteIdentityStore(join(dir, 'stream.db'), { now })
  const registry = new ExtRelayRegistry({
    local: new ExtRelay(),
    makeRelay: () => new ExtRelay(),
    deviceOf: () => undefined,
    bindingsOf: () => [],
    onNodeSeen: (n) => void nodes.seen(n),
    now,
  })

  /** 每个节点收到的帧；收到 newTab 就回一个标签 id，像扩展那样。 */
  const frames: Record<string, Array<{ op?: string; url?: string }>> = {}
  const connect = (nodeId: string, profileDir: string, profileName: string) => {
    const binding = localNodeBinding(nodeId)
    frames[nodeId] = []
    const socket = {
      send: (d: string) => {
        const f = JSON.parse(d) as { id: number; op?: string; url?: string }
        frames[nodeId]!.push(f)
        queueMicrotask(() => registry.handleMessage(binding, JSON.stringify({ id: f.id, result: f.op === 'newTab' ? { tabId: 40 + frames[nodeId]!.length } : {} })))
      },
    }
    registry.connect(binding, socket, { nodeId, profileDir, profileName } as ExtHandshake)
    return socket
  }
  const work = connect('node_work', 'Profile 1', '工作')
  // 「个人」后连上：不按身份选的话，本机默认的挑法（最近连上的）会挑它。
  clock += 1_000
  connect('node_home', 'Default', '个人')
  nodes.update('node_work', { environment: '工作' })
  nodes.update('node_home', { environment: '个人' })

  // 探测器的答案：每个节点上此刻登着谁（真实现会在那个 profile 里开一张后台标签读 __INITIAL_STATE__）。
  const answers: Record<string, ProbeResult> = {
    node_work: { state: 'signed-in', accountId: 'B', name: '工作号B' },
    node_home: { state: 'signed-in', accountId: 'A', name: '个人号A' },
  }
  const probed: string[] = []
  const svc = makeIdentityService({
    facilities: () => [XHS],
    nodeOfBinding: (b) => {
      const nodeId = registry.nodeOf(b)
      return nodeId ? { nodeId, deviceId: 'local', bindingId: b } : undefined
    },
    onlineNodes: () => [],
    profileName: (id) => nodes.get(id)?.profileName,
    cookieNames: async () => [],
    sessionFingerprint: async () => undefined,
    loginAccount: () => undefined,
    prober: { probe: async (node) => { probed.push(node.nodeId); return answers[node.nodeId]! } },
    store: identities,
    now,
  })
  const events: Array<{ type: string; title: string }> = []
  const router = makeIdentityRouter({
    identities: (f) => identities.list({ facility: f }),
    node: (id) => nodes.get(id),
    isOnline: (b) => registry.isOnline(b),
    verify: (f, n) => svc.verify(f, n),
    notify: (e) => void events.push(e),
    facilityLabel: () => '小红书',
    // 这台机器上没有 host agent：唤不起。
    agent: () => undefined,
    setWokenAt: (id, at) => nodes.setWokenAt(id, at),
    now,
  })

  // 两个节点各被探测过一次（节点连上时的那一轮）。
  identities.record('xhs', 'node_work', answers.node_work!)
  identities.record('xhs', 'node_home', answers.node_home!)

  let acted = 0
  const row: UserTaskRow = {
    id: 'xhs-post', label: '小红书发布', schedule: '0 0 9 * * *', action: 'xhs:post', args: [],
    serial: true, maxAttempts: 3, enabled: true, createdAt: 0, updatedAt: 0, identity: 'B',
  }
  const task = compileUserTask(row, {
    // 动作经 `registry.local`（本机路径上三十来处都这么拿 relay）开发布页：门面按执行上下文解析到节点。
    actions: () => async () => {
      acted++
      const tabId = await registry.local.newTab('https://creator.xiaohongshu.com/publish', 'load')
      return { summary: `opened ${tabId}` }
    },
    placement: (r) => placeRun({ target: taskTarget(r) ?? LOCAL_TARGET, facility: 'xhs', hosts: ['xiaohongshu.com'], router, purpose: 'action' }),
    nodeOf: (b) => {
      const nodeId = registry.nodeOf(b)
      const n = nodeId ? nodes.get(nodeId) : undefined
      return n ? { nodeId: n.nodeId, ...(n.profileName ? { profileName: n.profileName } : {}), ...(n.environment ? { environment: n.environment } : {}) } : undefined
    },
  })

  return {
    task, frames, answers, probed, events, identities, registry, work,
    acted: () => acted,
    advance: (ms: number) => { clock += ms },
  }
}

const tabsOpened = (fs: Array<{ op?: string }>) => fs.filter((f) => f.op === 'newTab')

describe('按身份执行，端到端（browser-identity 计划 4）', () => {
  it('指定工作号B 的任务落在「工作」节点上；「个人」节点一帧都收不到；记录写明身份', async () => {
    const w = world()
    // 对照：不按身份时本机挑的是「个人」——下面落到「工作」靠的是身份，不是碰巧
    expect(w.registry.pick('local')).toBe('local:node_home')
    const out = await w.task.run({} as never)
    expect(tabsOpened(w.frames.node_work!)).toHaveLength(1)
    expect(w.frames.node_home).toEqual([])
    expect(out).toMatchObject({ detail: { device: 'local', browser: 'local:node_work', node: 'node_work', profileName: '工作', environment: '工作', accountId: 'B', accountName: '工作号B' } })
    // 身份表的记录在 60 秒内：动作不再核对
    expect(w.probed).toEqual([])
  })

  it('「工作」里的号被换成个人号A：派发前以 identity-mismatch 拦下，什么都没发出，不重试，用户收到通知', async () => {
    const w = world()
    w.advance(2 * 60_000) // 记录过了动作的 60 秒窗口，这次要核对
    w.answers.node_work = { state: 'signed-in', accountId: 'A', name: '个人号A' }
    const e = await w.task.run({} as never).catch((x) => x)
    expect(e).toBeInstanceOf(IdentityMismatch)
    expect(failureDisposition(e)).toBe('final')
    expect(w.probed).toEqual(['node_work'])
    expect(w.acted()).toBe(0)
    expect(w.frames.node_work).toEqual([])
    expect(w.frames.node_home).toEqual([])
    expect(w.events).toEqual([expect.objectContaining({ type: 'identity.mismatch', title: '「工作」里的小红书现在登的是 个人号A' })])
    // 身份表跟着更新：「工作」上现在是 A，工作号B 不再有候选
    expect(w.identities.get('xhs', 'node_work')).toMatchObject({ accountId: 'A' })
  })

  it('工作号B 的节点离线、又唤不起：identity-offline（可重试），「个人」节点上没有打开任何标签', async () => {
    const w = world()
    w.registry.disconnect(localNodeBinding('node_work'), w.work)
    const e = await w.task.run({} as never).catch((x) => x)
    expect(e).toBeInstanceOf(IdentityOffline)
    expect(failureDisposition(e)).toBe('retry')
    expect(w.acted()).toBe(0)
    expect(w.frames.node_home).toEqual([])
    expect(w.registry.isOnline(localNodeBinding('node_home'))).toBe(true)
  })
})
