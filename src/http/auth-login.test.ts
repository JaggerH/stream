import { describe, it, expect, vi } from 'vitest'
import { WsHub } from './ws.ts'
import { attachAuthLoginCommands } from './auth-login.ts'

function client() {
  const sent: unknown[] = []
  return { sent, send: (d: string) => sent.push(JSON.parse(d)) }
}

describe('attachAuthLoginCommands', () => {
  it('runs startLogin for a login-start command and bridges events to login-<kind>', async () => {
    const hub = new WsHub()
    const c = client()
    hub.register(c)
    let captured: ((e: any) => void) | null = null
    const startLogin = vi.fn(async (_facility: string, emit: (e: any) => void) => { captured = emit })
    attachAuthLoginCommands(hub, { startLogin })

    hub.receive(c, JSON.stringify({ type: 'login-start', facility: 'xhs' }))
    expect(startLogin).toHaveBeenCalledWith('xhs', expect.any(Function))

    captured!({ kind: 'challenge', facility: 'xhs', qr: 'data:img,A' })
    captured!({ kind: 'success', facility: 'xhs' })
    expect(c.sent).toContainEqual({ type: 'login-challenge', kind: 'challenge', facility: 'xhs', qr: 'data:img,A' })
    expect(c.sent).toContainEqual({ type: 'login-success', kind: 'success', facility: 'xhs' })
  })

  it('ignores unrelated commands', () => {
    const hub = new WsHub()
    const startLogin = vi.fn(async () => {})
    attachAuthLoginCommands(hub, { startLogin })
    hub.receive(client(), JSON.stringify({ type: 'something-else' }))
    expect(startLogin).not.toHaveBeenCalled()
  })

  it('broadcasts a terminal login-failed when startLogin rejects', async () => {
    const hub = new WsHub()
    const c = client()
    hub.register(c)
    attachAuthLoginCommands(hub, { startLogin: async () => { throw new Error('boom') } })
    hub.receive(c, JSON.stringify({ type: 'login-start', facility: 'xhs' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(c.sent).toContainEqual({ type: 'login-failed', facility: 'xhs', reason: 'boom' })
  })
})
