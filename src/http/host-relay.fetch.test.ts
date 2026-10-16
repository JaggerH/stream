import { describe, it, expect } from 'vitest'
import { HostFetchQueueTimeout, HostOpError, HostRelayDisconnected, WsHostRelay } from './host-relay.ts'

function fakeSocket() {
  const sent: { id: number; op: string; args?: unknown }[] = []
  return { sent, socket: { send: (d: string) => { sent.push(JSON.parse(d)) } } }
}
const args = (url: string) => ({ method: 'GET', url, headers: [] as [string, string][], redirect: 'manual' as const, timeoutMs: 1_000, allowHosts: ['example.com'] })
const reply = (r: WsHostRelay, id: number, result: unknown) => r.handleMessage(JSON.stringify({ id, result }))

describe('WsHostRelay.fetchOp', () => {
  it('不等 UI 会话租约', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    let release!: () => void
    const held = r.withSession(() => new Promise<void>((res) => { release = res }))
    const p = r.fetchOp(args('https://example.com/a'))
    expect(sent.map((f) => f.op)).toEqual(['http.fetch'])
    reply(r, sent[0].id, { status: 200, headers: [], body: '', url: 'https://example.com/a' })
    await expect(p).resolves.toMatchObject({ status: 200 })
    release(); await held
  })

  it('最多 4 个在途，第 5 个等前面落定', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    const ps = [1, 2, 3, 4, 5].map((i) => r.fetchOp(args(`https://example.com/${i}`)))
    expect(sent).toHaveLength(4)
    reply(r, sent[0].id, { status: 200, headers: [], body: '', url: '' })
    await ps[0]
    expect(sent).toHaveLength(5)
    for (const f of sent.slice(1)) reply(r, f.id, { status: 200, headers: [], body: '', url: '' })
    await Promise.all(ps)
  })

  it('排队过久抛 HostFetchQueueTimeout，且没有发出', async () => {
    const r = new WsHostRelay({ fetchQueueWaitMs: 10 })
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    for (let i = 0; i < 4; i++) void r.fetchOp(args(`https://example.com/${i}`)).catch(() => {})
    await expect(r.fetchOp(args('https://example.com/late'))).rejects.toBeInstanceOf(HostFetchQueueTimeout)
    expect(sent).toHaveLength(4)
  })

  it('帧带 abortEpoch，与 UI op 同一形状', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    void r.fetchOp(args('https://example.com/a')).catch(() => {})
    expect(sent[0]).toMatchObject({ op: 'http.fetch', abortEpoch: 0 })
  })

  it('错误帧带 code', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    const p = r.fetchOp(args('https://example.com/x'))
    r.handleMessage(JSON.stringify({ id: sent[0].id, error: 'resolved to 192.168.1.1', code: 'private-target' }))
    const e = await p.catch((x) => x)
    expect(e).toBeInstanceOf(HostOpError)
    expect(e.code).toBe('private-target')
  })

  it('断连时在途的 fetch 以 HostRelayDisconnected 拒绝', async () => {
    const r = new WsHostRelay()
    const { socket } = fakeSocket()
    r.connect(socket)
    const p = r.fetchOp(args('https://example.com/x'))
    r.disconnect(socket)
    await expect(p).rejects.toBeInstanceOf(HostRelayDisconnected)
  })

  it('fetch 在途时 UI op 照常走单发尾锁', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    void r.fetchOp(args('https://example.com/x')).catch(() => {})
    const ui = r.send({ op: 'click', args: {} })
    expect(sent.map((f) => f.op)).toEqual(['http.fetch', 'click'])
    reply(r, sent[1].id, { ok: true })
    await expect(ui).resolves.toEqual({ ok: true })
  })
})
