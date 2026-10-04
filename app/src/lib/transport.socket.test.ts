import { describe, expect, it, vi, beforeEach } from 'vitest'
import { webTransport } from './transport.ts'

class FakeWS {
  static last: FakeWS
  static CONNECTING = 0
  static OPEN = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  close = vi.fn(() => {
    this.readyState = 3
  })
  send = vi.fn()
  constructor(public url: string) {
    FakeWS.last = this
  }
}

describe('webTransport.openSocket', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket)
  })

  it('dispatches string messages and open/close', () => {
    const onMessage = vi.fn()
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const h = webTransport.openSocket('ws://x/ws', { onOpen, onMessage, onClose })
    FakeWS.last.readyState = 1
    FakeWS.last.onopen!()
    expect(onOpen).toHaveBeenCalled()
    FakeWS.last.onmessage!({ data: '{"type":"item"}' })
    expect(onMessage).toHaveBeenCalledWith('{"type":"item"}')
    FakeWS.last.onclose!()
    expect(onClose).toHaveBeenCalled()
    h.send('{"type":"command"}')
    expect(FakeWS.last.send).toHaveBeenCalledWith('{"type":"command"}')
    h.close()
    expect(FakeWS.last.close).toHaveBeenCalled()
  })
})
