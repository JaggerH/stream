import { describe, it, expect, vi } from 'vitest'
import { WsHub } from './ws.ts'
import { toClientItem } from './client-item.ts'
import type { StoredItem } from '../item-store.ts'

describe('WsHub', () => {
  it('broadcasts a JSON message to all registered clients', () => {
    const hub = new WsHub()
    const a: string[] = []
    const b: string[] = []
    hub.register({ send: (d) => a.push(d) })
    hub.register({ send: (d) => b.push(d) })
    hub.broadcast({ type: 'item', item: { id: 'x' } })
    expect(JSON.parse(a[0])).toEqual({ type: 'item', item: { id: 'x' } })
    expect(JSON.parse(b[0])).toEqual({ type: 'item', item: { id: 'x' } })
  })

  it('item broadcast with toClientItem gate strips raw blob (live path matches HTTP)', () => {
    // toClientItem gate removes raw + promotes note_id/source_guid; verify serve.ts uses
    // this gate so WS item pushes match HTTP response serialization (no raw blob to frontend).
    const hub = new WsHub()
    const messages: string[] = []
    hub.register({ send: (d) => messages.push(d) })
    const storageItem: StoredItem = {
      id: 'test-item',
      stream_id: 'my-stream',
      source_type: 'rsshub-bridge',
      source_route: '/test',
      fetched_at: '2026-07-23T00:00:00Z',
      timestamp: '2026-07-23T00:00:00Z',
      title: 'test',
      type: 'post',
      raw: { noteId: 'n123', huge: 'x'.repeat(1000) } as unknown,
    }
    // simulate serve.ts bootstrap callback: onItem wraps with toClientItem
    hub.broadcast({ type: 'item', item_type: 'post', item: toClientItem(storageItem) })
    const broadcast = JSON.parse(messages[0])
    expect(broadcast.item).not.toHaveProperty('raw')
  })

  it('routes a parsed client command and can reply only to that client', () => {
    const hub = new WsHub()
    const a: string[] = []
    const b: string[] = []
    const ca = { send: (s: string) => a.push(s) }
    const cb = { send: (s: string) => b.push(s) }
    hub.register(ca)
    hub.register(cb)
    hub.onCommand((client, command) => hub.send(client, { type: 'ack', command }))
    hub.receive(ca, '{"type":"enrich.open","correlationId":"c1"}')
    expect(JSON.parse(a[0])).toEqual({ type: 'ack', command: { type: 'enrich.open', correlationId: 'c1' } })
    expect(b).toEqual([])
  })

  it('ignores malformed client commands', () => {
    const hub = new WsHub()
    const listener = vi.fn()
    hub.onCommand(listener)
    hub.receive({ send: () => {} }, 'not json')
    expect(listener).not.toHaveBeenCalled()
  })

  it('unregister stops delivery and updates size', () => {
    const hub = new WsHub()
    const got: string[] = []
    const off = hub.register({ send: (d) => got.push(d) })
    expect(hub.size).toBe(1)
    off()
    expect(hub.size).toBe(0)
    hub.broadcast({ type: 'item' })
    expect(got).toHaveLength(0)
  })

  it('drops a client whose send throws', () => {
    const hub = new WsHub()
    hub.register({ send: () => { throw new Error('closed') } })
    hub.broadcast({ type: 'item' })
    expect(hub.size).toBe(0)
  })

  it('drops a disconnected client when a correlated reply throws', () => {
    const hub = new WsHub()
    const client = { send: () => { throw new Error('closed') } }
    hub.register(client)
    hub.send(client, { type: 'enrich.completed' })
    expect(hub.size).toBe(0)
  })
})
