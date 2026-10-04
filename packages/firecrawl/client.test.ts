import { describe, it, expect, vi, afterEach } from 'vitest'
import { scrapeWithFirecrawl, FirecrawlError } from './client.ts'

afterEach(() => vi.restoreAllMocks())

/** 造一个 fetch 替身，返回给定的状态码与 JSON body，并把收到的请求记下来。 */
function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch)
  return calls
}

const OK_BODY = {
  success: true,
  data: {
    markdown: '# Hello\n\n正文若干。',
    metadata: { title: 'Hello', sourceURL: 'https://e.com/a', url: 'https://e.com/a/', creditsUsed: 1 },
  },
}

describe('scrapeWithFirecrawl', () => {
  it('打默认端点，keyless 时不发 Authorization 头', async () => {
    const calls = mockFetch(200, OK_BODY)
    const page = await scrapeWithFirecrawl('https://e.com/a')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.firecrawl.dev/v2/scrape')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      url: 'https://e.com/a',
      formats: ['markdown'],
    })
    expect(page.markdown).toContain('正文若干')
    expect(page.title).toBe('Hello')
    expect(page.creditsUsed).toBe(1)
  })

  it('finalUrl 取 metadata.url，缺席时退回 metadata.sourceURL，再缺席退回入参', async () => {
    mockFetch(200, OK_BODY)
    expect((await scrapeWithFirecrawl('https://e.com/a')).finalUrl).toBe('https://e.com/a/')

    vi.restoreAllMocks()
    mockFetch(200, { success: true, data: { markdown: 'x', metadata: { sourceURL: 'https://s.com' } } })
    expect((await scrapeWithFirecrawl('https://e.com/a')).finalUrl).toBe('https://s.com')

    vi.restoreAllMocks()
    mockFetch(200, { success: true, data: { markdown: 'x', metadata: {} } })
    expect((await scrapeWithFirecrawl('https://e.com/a')).finalUrl).toBe('https://e.com/a')
  })

  it('带 key 时发 Bearer 头', async () => {
    const calls = mockFetch(200, OK_BODY)
    await scrapeWithFirecrawl('https://e.com/a', { apiKey: 'fc-123' })
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer fc-123')
  })

  it('尊重自定义 baseUrl 并剥掉尾斜杠', async () => {
    const calls = mockFetch(200, OK_BODY)
    await scrapeWithFirecrawl('https://e.com/a', { baseUrl: 'http://127.0.0.1:3002/' })
    expect(calls[0].url).toBe('http://127.0.0.1:3002/v2/scrape')
  })

  // 下面三条是这个客户端存在的理由：**限流**和**页面取不到**的下一步完全不同
  // （前者是等/换 key，后者是这页就是抓不到），合并成"失败了"等于把最费时间的误诊固化进代码。
  it('429 分类成 rate_limited', async () => {
    mockFetch(429, { error: 'Rate limit exceeded' })
    await expect(scrapeWithFirecrawl('https://e.com/a')).rejects.toMatchObject({ kind: 'rate_limited' })
  })

  it('402（额度耗尽）也是 rate_limited', async () => {
    mockFetch(402, { error: 'Insufficient credits' })
    await expect(scrapeWithFirecrawl('https://e.com/a')).rejects.toMatchObject({ kind: 'rate_limited' })
  })

  it('success:false 分类成 unavailable', async () => {
    mockFetch(200, { success: false, error: 'This website is not supported' })
    await expect(scrapeWithFirecrawl('https://e.com/a')).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('200 但 markdown 为空 = unavailable，不返回一份空正文', async () => {
    mockFetch(200, { success: true, data: { markdown: '   ', metadata: {} } })
    await expect(scrapeWithFirecrawl('https://e.com/a')).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('网络异常分类成 transport', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'))
    await expect(scrapeWithFirecrawl('https://e.com/a')).rejects.toMatchObject({ kind: 'transport' })
  })

  // 5xx 是 Firecrawl 自己挂了、可重试——不是页面的问题。混进 unavailable（"这页就是抓不到，
  // 别再试"）会把一个应该重试的错误固化成永久放弃。
  it('500 分类成 transport，不是 unavailable', async () => {
    mockFetch(500, { success: false, error: 'Internal Server Error' })
    await expect(scrapeWithFirecrawl('https://e.com/a')).rejects.toMatchObject({ kind: 'transport' })
  })

  it('503 也分类成 transport', async () => {
    mockFetch(503, { error: 'Service Unavailable' })
    await expect(scrapeWithFirecrawl('https://e.com/a')).rejects.toMatchObject({ kind: 'transport' })
  })

  // data 信封整个缺席说明返回形状不是我们认识的那个（更像 transport），不是"这页没内容"
  // （unavailable 的"返回空正文"）——两种要分开，文案和分类都分开。
  it('data 字段整体缺席 → transport，文案与"返回空正文"分开', async () => {
    mockFetch(200, { success: true })
    const err = await scrapeWithFirecrawl('https://e.com/a').catch((e) => e)
    expect(err).toMatchObject({ kind: 'transport' })
    expect(String(err.message)).not.toContain('返回空正文')
  })

  it('抛的是 FirecrawlError，message 里带得上原因', async () => {
    mockFetch(429, { error: 'Rate limit exceeded' })
    const err = await scrapeWithFirecrawl('https://e.com/a').catch((e) => e)
    expect(err).toBeInstanceOf(FirecrawlError)
    expect(String(err.message)).toMatch(/429|rate/i)
  })
})
