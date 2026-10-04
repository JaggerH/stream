import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api, type Connection } from '../lib/api.ts'

const conn: Connection = { baseUrl: 'http://127.0.0.1:4555' }
const originalFetch = globalThis.fetch

function mockFetch(json: unknown, ok = true, status = ok ? 200 : 500) {
  const fn = vi.fn((..._args: unknown[]) =>
    Promise.resolve({ ok, status, json: async () => json })
  )
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

describe('api client', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('GET /api/streams', async () => {
    const fn = mockFetch([{ id: 'a', description: 'd' }])
    const r = await api.streams(conn)
    expect(fn).toHaveBeenCalledWith('http://127.0.0.1:4555/api/streams', expect.any(Object))
    expect(r[0].id).toBe('a')
  })

  it('GET /api/items builds query from stream + limit', async () => {
    const fn = mockFetch([])
    await api.items(conn, { stream: 'my-tech', limit: 50 })
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/items?stream=my-tech&limit=50')
  })

  it('GET /api/channels/:id/items builds the channel timeline query and unwraps the envelope', async () => {
    const fn = mockFetch({ items: [{ id: 'a' }], next_cursor: 'CUR' })
    const r = await api.channelItems(conn, 'default-timeline', { limit: 200, cursor: 'c0' })
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/channels/default-timeline/items?limit=200&cursor=c0')
    expect(r.items[0].id).toBe('a')
    expect(r.next_cursor).toBe('CUR')
  })

  it('POST /api/channels creates a channel resource', async () => {
    const fn = mockFetch({ id: 'daily', label: 'Daily' })
    await api.createChannel(conn, {
      label: 'Daily',
      variant: 'timeline',
      stream_ids: [],
      options: {},
    })
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/channels')
    const init = fn.mock.calls[0][1] as { method: string; body: string }
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ label: 'Daily', variant: 'timeline' })
    expect(JSON.parse(init.body)).not.toHaveProperty('id')
  })

  it('catalog search hits /api/sources?q= with the encoded intent', async () => {
    const fn = mockFetch([])
    await api.search(conn, '科技 news')
    expect(fn.mock.calls[0][0]).toContain('/api/sources?q=%E7%A7%91%E6%8A%80%20news')
  })

  it('searchAllPluginSources hits /api/plugins/sources with encoded params', async () => {
    const fn = mockFetch({ sources: [], plugins: [], facets: { categories: [], capabilities: [] } })
    await api.searchAllPluginSources(conn, { query: '哔哩', searchable: true })
    const url = fn.mock.calls[0][0] as string
    expect(url).toContain('/api/plugins/sources?')
    expect(url).toContain('query=%E5%93%94%E5%93%A9')
    expect(url).toContain('searchable=1')
  })

  it('content search hits scoped /api/search and returns items + warnings', async () => {
    const fn = mockFetch({ items: [{ id: 'x' }] })
    const r = await api.contentSearch(conn, '深圳')
    expect(fn.mock.calls[0][0]).toContain('/api/search?scope=content&q=%E6%B7%B1%E5%9C%B3')
    expect(r).toEqual({ items: [{ id: 'x' }], warnings: [], timings: [] })
  })

  it('subscribe POSTs a StreamCreate to /api/streams', async () => {
    const fn = mockFetch({ id: 'x' })
    const stream = { id: 'x', label: 'd', strategy: 'fanout' as const, cadence_seconds: 1800, members: [], options: { vault_subdir: 'x' } }
    await api.subscribe(conn, stream)
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/streams')
    const call = fn.mock.calls[0][1] as { method: string; body: string }
    expect(call.method).toBe('POST')
    expect(JSON.parse(call.body).id).toBe('x')
  })

  it('unsubscribe DELETEs the stream', async () => {
    const fn = mockFetch({ ok: true })
    await api.unsubscribe(conn, 'x')
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/streams/x')
    expect((fn.mock.calls[0][1] as { method: string }).method).toBe('DELETE')
  })

  it('attaches a bearer token when present', async () => {
    const fn = mockFetch([])
    await api.streams({ baseUrl: 'http://remote', token: 'sek' })
    const headers = (fn.mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer sek')
  })

  it('throws on a non-ok response', async () => {
    mockFetch({}, false)
    await expect(api.streams(conn)).rejects.toThrow(/500/)
  })

  it('PATCH /api/items/:id sends the label', async () => {
    const fn = mockFetch({ ok: true })
    await api.label(conn, 'abc123', 'lottery')
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/items/abc123')
    const call = fn.mock.calls[0][1] as { method: string; body: string }
    expect(call.method).toBe('PATCH')
    expect(JSON.parse(call.body)).toEqual({ label: 'lottery' })
  })

  it('wsUrl converts http→ws', () => {
    expect(api.wsUrl(conn)).toBe('ws://127.0.0.1:4555/ws')
    expect(api.wsUrl({ baseUrl: 'https://x' })).toBe('wss://x/ws')
  })

  it('GET /api/settings/summary-prompt', async () => {
    const fn = mockFetch({ prompt: 'p', configured: true })
    const r = await api.summaryPrompt.get(conn)
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/settings/summary-prompt')
    expect(r.configured).toBe(true)
  })

  it('PUT /api/settings/summary-prompt sends just the prompt', async () => {
    const fn = mockFetch({ prompt: 'p', configured: true })
    await api.summaryPrompt.set(conn, 'p')
    const call = fn.mock.calls[0][1] as { method: string; body: string }
    expect(call.method).toBe('PUT')
    expect(JSON.parse(call.body)).toEqual({ prompt: 'p' })
  })

  it('POST /api/conversions carries kind + options (摘要的输入是另一条 conversion)', async () => {
    const fn = mockFetch({ id: 'cv_1', kind: 'summary', status: 'queued' })
    await api.conversions.start(conn, 'summary', 'i1', { input: 'cv_stt', options: { lang: 'zh' }, force: true })
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/conversions')
    expect(JSON.parse((fn.mock.calls[0][1] as { body: string }).body)).toMatchObject({
      kind: 'summary',
      item: 'i1',
      input: 'cv_stt',
      options: { lang: 'zh' },
      force: true,
    })
  })

  it('forItem asks for one item and can expand the bodies', async () => {
    const fn = mockFetch({ items: [] })
    await api.conversions.forItem(conn, 'i 1', { expandResult: true })
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/conversions?item=i%201&expand=result')
  })

  it('latest returns null for an item that was never converted (空列表,不再有 status:none)', async () => {
    mockFetch({ items: [] })
    await expect(api.conversions.latest(conn, 'i1', 'extract')).resolves.toBeNull()
  })

  it('POST /api/downloads', async () => {
    const fn = mockFetch({ enqueued: 1 })
    const body = { itemId: 'i1' }
    const r = await api.download(conn, body)
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/downloads')
    expect(JSON.parse((fn.mock.calls[0][1] as { body: string }).body)).toEqual(body)
    expect(r.enqueued).toBe(1)
  })

  it('GET /api/downloads with and without platform', async () => {
    const fn = mockFetch({ items: [{ id: 1, platform: 'netease', track_id: '123', state: 'queued' }] })
    const r1 = await api.downloadJobs(conn)
    expect(fn.mock.calls[0][0]).toBe('http://127.0.0.1:4555/api/downloads')
    expect(r1.jobs[0].track_id).toBe('123')

    const r2 = await api.downloadJobs(conn, 'netease')
    expect(fn.mock.calls[1][0]).toBe('http://127.0.0.1:4555/api/downloads?platform=netease')
    expect(r2.jobs[0].platform).toBe('netease')
  })

  it('voiceprint.blocks builds query from person + minSeconds', async () => {
    const fn = mockFetch({ blocks: [{ start: 0, end: 10, label: '庞 博' }] })
    const r = await api.voiceprint.blocks(conn, 'ep 1', { person: '庞 博', minSeconds: 120 })
    const url = fn.mock.calls[0][0] as string
    expect(url).toContain('/api/voiceprint/item/ep%201/blocks?')
    expect(url).toContain('person=')
    expect(url).toContain('%E5%BA%9E')  // '庞'
    expect(url).toContain('%E5%8D%9A')  // '博'
    expect(url).toContain('minSeconds=120')
    expect(r[0]).toEqual({ start: 0, end: 10, label: '庞 博' })
  })

  it('voiceprint.blocks with no opts produces bare URL', async () => {
    const fn = mockFetch({ blocks: [] })
    await api.voiceprint.blocks(conn, 'ep1')
    expect(fn.mock.calls[0][0]).toMatch(/\/blocks$/)
  })
})
