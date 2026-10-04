import { describe, it, expect, vi } from 'vitest'
import { EventSourceRelay } from './relay.ts'
import { wireCookiesFeed } from './cookies-feed.ts'

describe('wireCookiesFeed', () => {
  it('hello 报出的域 → 取 cookie → 拼串一次性推给子进程', async () => {
    const sent: string[] = []
    const relay = new EventSourceRelay(
      () => {},
      undefined,
      () => {},
    )
    relay.connect({ send: (r) => sent.push(r) })
    const cookiesFor = vi.fn(async (d: string) =>
      d === 'goofish.com' ? [{ name: 'a', value: '1' } as any, { name: 'b', value: '2' } as any] : [],
    )
    const feed = wireCookiesFeed(relay, { cookiesFor })
    await feed.onHello(['goofish.com'])
    expect(cookiesFor).toHaveBeenCalledWith('goofish.com')
    expect(JSON.parse(sent[0])).toEqual({ t: 'cookies', pairs: 'a=1; b=2' })
  })

  it('多域合并：多个域的 cookie 按域序拼成一条', async () => {
    const sent: string[] = []
    const relay = new EventSourceRelay(
      () => {},
      undefined,
      () => {},
    )
    relay.connect({ send: (r) => sent.push(r) })
    const cookiesFor = vi.fn(async (d: string) => {
      if (d === 'a.com') return [{ name: 'x', value: '1' } as any]
      if (d === 'b.com') return [{ name: 'y', value: '2' } as any]
      return []
    })
    const feed = wireCookiesFeed(relay, { cookiesFor })
    await feed.onHello(['a.com', 'b.com'])
    expect(cookiesFor).toHaveBeenCalledWith('a.com')
    expect(cookiesFor).toHaveBeenCalledWith('b.com')
    expect(cookiesFor).toHaveBeenCalledTimes(2)
    expect(JSON.parse(sent[0])).toEqual({ t: 'cookies', pairs: 'x=1; y=2' })
  })

  it('跳过无 name 的 cookie', async () => {
    const sent: string[] = []
    const relay = new EventSourceRelay(
      () => {},
      undefined,
      () => {},
    )
    relay.connect({ send: (r) => sent.push(r) })
    const cookiesFor = vi.fn(async (d: string) =>
      d === 'mixed.com'
        ? [
            { name: 'a', value: '1' } as any,
            { value: '2' } as any, // 无 name
            { name: 'b', value: '3' } as any,
          ]
        : [],
    )
    const feed = wireCookiesFeed(relay, { cookiesFor })
    await feed.onHello(['mixed.com'])
    expect(JSON.parse(sent[0])).toEqual({ t: 'cookies', pairs: 'a=1; b=3' })
  })

  it('空结果仍推送空字符串', async () => {
    const sent: string[] = []
    const relay = new EventSourceRelay(
      () => {},
      undefined,
      () => {},
    )
    relay.connect({ send: (r) => sent.push(r) })
    const cookiesFor = vi.fn(async () => [])
    const feed = wireCookiesFeed(relay, { cookiesFor })
    await feed.onHello(['none.com'])
    expect(cookiesFor).toHaveBeenCalledWith('none.com')
    expect(JSON.parse(sent[0])).toEqual({ t: 'cookies', pairs: '' })
  })

  it('无域时推送空字符串', async () => {
    const sent: string[] = []
    const relay = new EventSourceRelay(
      () => {},
      undefined,
      () => {},
    )
    relay.connect({ send: (r) => sent.push(r) })
    const cookiesFor = vi.fn(async () => [])
    const feed = wireCookiesFeed(relay, { cookiesFor })
    await feed.onHello([])
    expect(cookiesFor).not.toHaveBeenCalled()
    expect(JSON.parse(sent[0])).toEqual({ t: 'cookies', pairs: '' })
  })
})
