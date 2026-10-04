import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useWs } from './useWs.ts'
import * as transport from '../lib/transport.ts'

describe('useWs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens via transport, parses item frames, reconnects on close with backoff', () => {
    let handlers: transport.SocketHandlers | undefined
    const close = vi.fn()
    const send = vi.fn()
    const openSocket = vi.fn((_url: string, h: transport.SocketHandlers) => {
      handlers = h
      return { close, send }
    })
    vi.spyOn(transport, 'selectTransport').mockReturnValue({ fetch: vi.fn(), openSocket })
    const onMessage = vi.fn()
    const { result } = renderHook(() => useWs('ws://x/ws', onMessage))
    expect(openSocket).toHaveBeenCalledTimes(1)
    result.current({ type: 'enrich.open', correlationId: 'c1' })
    expect(send).not.toHaveBeenCalled()
    handlers!.onOpen?.()
    expect(send).toHaveBeenCalledWith('{"type":"enrich.open","correlationId":"c1"}')
    handlers!.onMessage('{"type":"item","item":{"stream_id":"s"}}')
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'item' }))
    handlers!.onClose?.()
    vi.advanceTimersByTime(1000)
    expect(openSocket).toHaveBeenCalledTimes(2) // 退避后重连
  })
})
