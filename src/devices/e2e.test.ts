/**
 * 端到端：一条绑定到 NAS 的东财风格动作，经真的 WsHostRelay（假 socket）把请求发到「设备」，
 * 设备离线时零请求经本机发出。不打网络。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostRelayRegistry } from '../http/host-registry.ts'
import { makeFetchFor } from './fetch.ts'
import { FacilityDeviceStore } from './facility-devices.ts'
import { assertDeviceReady, resolvePlacement } from './placement.ts'
import { compileUserTask } from '../tasks/user-tasks.ts'
import { DeviceOffline } from './errors.ts'

const hello = { deviceId: 'linux:nas', platform: 'linux' as const, name: 'NAS', agentVersion: '0.1.0', ops: ['http.fetch'] }

function world() {
  const registry = new HostRelayRegistry()
  const local = vi.fn(async () => new Response('local'))
  const fetchFor = makeFetchFor({ directory: registry, local })
  const bindings = new FacilityDeviceStore(join(mkdtempSync(join(tmpdir(), 'e2e-')), 'stream.db'))
  bindings.set('eastmoney', 'linux:nas')
  const row = { id: 'em', label: 'x', schedule: '0 45 9 * * *', action: 'eastmoney:calendar', args: [], serial: true, maxAttempts: 1, enabled: true, createdAt: 0, updatedAt: 0 }
  const task = compileUserTask(row, {
    actions: () => async () => {
      const r = await fetchFor('https://jywg.eastmoneysec.com/Trade/Buy', { redirect: 'manual' })
      return { summary: await r.text() }
    },
    placement: (r) => resolvePlacement({ taskDevice: r.device, facility: 'eastmoney', binding: (f) => bindings.get(f), hosts: ['eastmoneysec.com'] }),
    ready: (p) => assertDeviceReady(p, registry, 'http.fetch'),
  })
  return { registry, local, task }
}

describe('device execution end to end', () => {
  it('请求从设备发出', async () => {
    const { registry, local, task } = world()
    const sent: { id: number; op: string; args: { url: string } }[] = []
    const relay = registry.connect({ send: (d: string) => {
      const f = JSON.parse(d)
      sent.push(f)
      queueMicrotask(() => relay.handleMessage(JSON.stringify({ id: f.id, result: { status: 200, headers: [], body: Buffer.from('from-nas').toString('base64'), url: f.args.url } })))
    } } as never, hello)
    const out = await task.run({} as never)
    expect(out.summary).toBe('from-nas')
    expect(sent[0].op).toBe('http.fetch')
    expect(local).not.toHaveBeenCalled()
  })

  it('设备离线：失败且本机零请求', async () => {
    const { local, task } = world()
    await expect(task.run({} as never)).rejects.toBeInstanceOf(DeviceOffline)
    expect(local).not.toHaveBeenCalled()
  })
})
