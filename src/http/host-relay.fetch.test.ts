import { describe, it, expect } from 'vitest'
import { HostAbortedByUser, HostFetchQueueTimeout, HostOpError, HostRelayDisconnected, WsHostRelay } from './host-relay.ts'

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

  describe('名额记账', () => {
    const OK = { status: 200, headers: [], body: '', url: '' }
    const fill = (r: WsHostRelay, n: number, timeoutMs = 1_000) =>
      Array.from({ length: n }, (_, i) => r.fetchOp({ ...args(`https://example.com/${i}`), timeoutMs }))

    it('错误帧落定后释放名额，第 5 个发出', async () => {
      const r = new WsHostRelay()
      const { socket, sent } = fakeSocket()
      r.connect(socket)
      const ps = fill(r, 5)
      const first = ps[0].catch((e) => e)
      r.handleMessage(JSON.stringify({ id: sent[0].id, error: 'boom' }))
      await first
      expect(sent).toHaveLength(5)
      for (const f of sent.slice(1)) reply(r, f.id, OK)
      await Promise.all(ps.slice(1))
    })

    it('op 超时后释放名额，第 5 个发出', async () => {
      const r = new WsHostRelay()
      const { socket, sent } = fakeSocket()
      r.connect(socket)
      // op 超时 = timeoutMs + 5s；给 -4_990 让它 10ms 就到点，免用假定时器
      const ps = fill(r, 4, -4_990)
      const p5 = r.fetchOp(args('https://example.com/5'))
      const e = await ps[0].catch((x) => x)
      expect(e.name).toBe('HostRelayTimeout')
      expect(sent).toHaveLength(5)
      reply(r, sent[4].id, OK)
      await expect(p5).resolves.toMatchObject({ status: 200 })
      await Promise.allSettled(ps)
    })

    it('socket.send 同步抛错后释放名额，第 5 个发出', async () => {
      const r = new WsHostRelay()
      const sent: { id: number }[] = []
      let throwNext = false
      r.connect({ send: (d: string) => { if (throwNext) { throwNext = false; throw new Error('ws closing') } sent.push(JSON.parse(d)) } })
      const ps = fill(r, 3)
      throwNext = true
      const bad = r.fetchOp(args('https://example.com/bad'))
      const p5 = r.fetchOp(args('https://example.com/5'))
      await expect(bad).rejects.toThrow('ws closing')
      expect(sent).toHaveLength(4)
      for (const f of sent) reply(r, f.id, OK)
      await Promise.all([...ps, p5])
    })

    it('断连时排队者以 HostRelayDisconnected 拒绝，重连后名额回满', async () => {
      const r = new WsHostRelay()
      const a = fakeSocket()
      r.connect(a.socket)
      const ps = fill(r, 6)
      const settled = Promise.allSettled(ps)
      r.disconnect(a.socket)
      for (const x of await settled) {
        expect(x.status).toBe('rejected')
        expect((x as PromiseRejectedResult).reason).toBeInstanceOf(HostRelayDisconnected)
      }
      const b = fakeSocket()
      r.connect(b.socket)
      const again = fill(r, 4)
      expect(b.sent).toHaveLength(4)
      for (const f of b.sent) reply(r, f.id, OK)
      await Promise.all(again)
    })

    it('中止：4 在途 + 2 排队全部以 HostAbortedByUser 拒绝，之后不再发帧', async () => {
      const r = new WsHostRelay()
      const { socket, sent } = fakeSocket()
      r.connect(socket)
      const ps = fill(r, 6)
      const settled = Promise.allSettled(ps)
      r.handleMessage(JSON.stringify({ type: 'abort', reason: 'user-hotkey' }))
      for (const x of await settled) {
        expect(x.status).toBe('rejected')
        expect((x as PromiseRejectedResult).reason).toBeInstanceOf(HostAbortedByUser)
      }
      expect(sent).toHaveLength(4)
    })
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
