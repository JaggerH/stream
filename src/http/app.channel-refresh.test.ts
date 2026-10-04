import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createHttpApp } from './app.ts'

/** 最小接线：一个带成员流的频道 + 一个可控的 refreshStream。 */
function makeApp(over: { channel?: unknown; refreshStream?: (id: string) => Promise<{ fetched: number; written: number }> } = {}) {
  const refreshStream = over.refreshStream ?? (async () => ({ fetched: 2, written: 1 }))
  const channel =
    over.channel === undefined
      ? { id: 'default-timeline', label: '时间线', present: 'timeline', stream_ids: ['s1', 's2'], system: true, options: {} }
      : over.channel
  const app = createHttpApp({
    service: { streamsResource: () => [], refreshStream: vi.fn(refreshStream) },
    itemStore: { get: () => undefined },
    channelStore: { getChannel: (id: string) => ((channel as { id?: string })?.id === id ? channel : null) },
    health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
  } as never)
  return { app, refreshStream }
}

const post = (app: Hono, path: string) => app.request(path, { method: 'POST' })

describe('POST /api/channels/:id/refresh', () => {
  it('fans out to every member stream and returns the per-stream ledger + totals', async () => {
    const seen: string[] = []
    const { app } = makeApp({
      refreshStream: async (id) => {
        seen.push(id)
        return { fetched: id === 's1' ? 3 : 5, written: id === 's1' ? 1 : 2 }
      },
    })
    const r = await post(app, '/api/channels/default-timeline/refresh')
    expect(r.status).toBe(200)
    expect(seen.sort()).toEqual(['s1', 's2'])
    expect(await r.json()).toEqual({
      streams: [
        { streamId: 's1', fetched: 3, written: 1 },
        { streamId: 's2', fetched: 5, written: 2 },
      ],
      fetched: 8,
      written: 3,
      failed: 0,
    })
  })

  it('部分失败仍是 200——「7 条里 1 条没抓成」不是一次失败的请求', async () => {
    const { app } = makeApp({
      refreshStream: async (id) => {
        if (id === 's2') throw new Error('facility 未登录')
        return { fetched: 4, written: 2 }
      },
    })
    const r = await post(app, '/api/channels/default-timeline/refresh')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { failed: number; fetched: number; streams: Array<{ streamId: string; error?: string }> }
    expect(body.failed).toBe(1)
    expect(body.fetched).toBe(4) // 成功那条照常计入
    expect(body.streams.find((s) => s.streamId === 's2')!.error).toContain('未登录')
  })

  it('404s an unknown channel', async () => {
    const { app } = makeApp()
    expect((await post(app, '/api/channels/nope/refresh')).status).toBe(404)
  })

  it('一个没有成员流的频道 = 空账,不是错误', async () => {
    const refreshStream = vi.fn(async () => ({ fetched: 1, written: 1 }))
    const { app } = makeApp({
      channel: { id: 'empty', label: '空', present: 'timeline', stream_ids: [], options: {} },
      refreshStream,
    })
    const r = await post(app, '/api/channels/empty/refresh')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ streams: [], fetched: 0, written: 0, failed: 0 })
    expect(refreshStream).not.toHaveBeenCalled()
  })

  it('503s when the channel store is not wired', async () => {
    const app = createHttpApp({
      service: { streamsResource: () => [], refreshStream: async () => ({ fetched: 0, written: 0 }) },
      itemStore: { get: () => undefined },
      health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
    } as never)
    expect((await post(app, '/api/channels/default-timeline/refresh')).status).toBe(503)
  })
})
