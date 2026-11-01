import { afterEach, describe, it, expect, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { FeedAdapter } from './adapter.ts'
import { callerFetchGuardPolicy, configureCallerFetchGuard, CallerUrlBlockedError, withCallerFetchGuard } from '../../src/net/caller-fetch-guard.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const manifest = { id: 'feed-url', adapter: 'feed' } as unknown as SourceManifest
const RSS = '<rss><channel><title>T</title><item><guid>g1</guid><title>a</title></item></channel></rss>'

afterEach(() => {
  configureCallerFetchGuard(null)
  vi.restoreAllMocks()
})

describe('FeedAdapter — shape', () => {
  it('fetch emits feed items with the feed\'s own guid, plus the channel title', async () => {
    const a = new FeedAdapter(async () => RSS)
    const r = await a.fetch({ url: 'https://example.com/feed' }, manifest)
    expect(r).toMatchObject({ title: 'T', items: [{ guid: 'g1', title: 'a' }] })
  })

  it('missing url param and non-feed documents are errors, not silent empties', async () => {
    const a = new FeedAdapter(async () => RSS)
    await expect(a.fetch({}, manifest)).rejects.toThrow(/url/)
    const bad = new FeedAdapter(async () => '<html><body>hi</body></html>')
    await expect(bad.fetch({ url: 'https://example.com/' }, manifest)).rejects.toThrow(/no RSS/)
  })
})

describe('FeedAdapter — 内网拒绝（与 read_url 同一套守卫）', () => {
  // 缺省传输走 safeFetchResponse：私网地址在守卫关闭时也被主机名级闸拒绝（连请求都不发）。
  it.each([
    'http://127.0.0.1/feed.xml', // loopback
    'http://10.0.0.1/feed.xml', // private range
    'http://192.168.1.1/feed.xml', // private range
    'http://169.254.169.254/latest/meta-data/', // link-local / cloud metadata
    'http://[::1]/feed.xml', // IPv6 loopback
  ])('%s 被拒且不发请求', async (url) => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const a = new FeedAdapter() // 缺省传输 = safeFetchResponse 那条真守卫
    await expect(a.fetch({ url }, manifest)).rejects.toThrow(/fetch failed/)
    expect(spy).not.toHaveBeenCalled()
  })

  // 守卫激活时（read_url 门的作用域里）走连接层逐跳判：拒绝原样冒泡为 CallerUrlBlockedError。
  it('guard active: private addresses reject with CallerUrlBlockedError', async () => {
    configureCallerFetchGuard(callerFetchGuardPolicy({ reject_private: true, allow: [] }))
    const a = new FeedAdapter()
    await expect(
      withCallerFetchGuard(() => a.fetch({ url: 'http://127.0.0.1:3425/feed.xml' }, manifest)),
    ).rejects.toBeInstanceOf(CallerUrlBlockedError)
  })
})

describe('FeedAdapter — 本地 feed 集成（采集→入库→新条目再采集）', () => {
  let server: Server
  let base = ''
  const entries: string[] = [
    '<item><guid>e1</guid><title>one</title><link>https://example.com/1</link></item>',
    '<item><guid>e2</guid><title>two</title><link>https://example.com/2</link></item>',
  ]

  const feedXml = () =>
    `<rss><channel><title>Local Feed</title>${entries.join('\n')}</channel></rss>`

  const start = async () =>
    new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.setHeader('content-type', 'application/rss+xml')
        res.end(feedXml())
      }).listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed.xml`
        resolve()
      })
    })

  it('first harvest N items; a new entry in the feed adds exactly that one', async () => {
    // 本地 feed 在回环地址上——用注入的 fetcher 打它（守卫对回环的拒绝已在上面的用例单独验）。
    const a = new FeedAdapter(async () => {
      const res = await fetch(base)
      return res.text()
    })
    await start()
    try {
      const { persistItems } = await import('../../src/stream-pipeline.ts')
      const { DedupStore } = await import('../../src/dedup-store.ts')
      const dedup = new DedupStore(':memory:')

      const first = await a.fetch({ url: base }, manifest)
      const w1 = await persistItems('feed-stream', base, (first as { items: unknown[] }).items, undefined, dedup)
      expect(w1).toEqual({ fetched: 2, written: 2 }) // 第一次：两条全进

      // feed 新增一条，其余不变：第二次采集只多这一条
      entries.push('<item><guid>e3</guid><title>three</title><link>https://example.com/3</link></item>')
      const second = await a.fetch({ url: base }, manifest)
      const w2 = await persistItems('feed-stream', base, (second as { items: unknown[] }).items, undefined, dedup)
      expect(w2).toEqual({ fetched: 3, written: 1 }) // 只多 e3

      // 内容没变的旧条目再采一遍：0 新（身份来自 feed 自己的 guid，不是 feed 地址）
      const third = await a.fetch({ url: base }, manifest)
      const w3 = await persistItems('feed-stream', base, (third as { items: unknown[] }).items, undefined, dedup)
      expect(w3).toEqual({ fetched: 3, written: 0 })
      dedup.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
