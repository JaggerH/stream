import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArticleCache } from './extract.ts'

const articles = new ArticleCache()
import { ownedFetch } from '../http/owned-outbound.ts'

// safe-fetch（extractArticle 的取数器）现在走 ownedFetch —— 一条被内嵌 RSSHub rewriter 够不着的
// 通道。owned 在启动期快照原始 fetch，故意免疫运行时对 globalThis.fetch 的替换（vi.stubGlobal 与
// rewriter 是同一类东西），所以 mock 必须打在 ownedFetch 这个真实出站边界上，而非全局 fetch。
vi.mock('../http/owned-outbound.ts', () => ({
  ownedFetch: vi.fn(),
  owned: { httpGet: vi.fn(), httpsGet: vi.fn(), httpRequest: vi.fn(), httpsRequest: vi.fn() },
}))

function mockPage(html: string, contentType = 'text/html') {
  vi.mocked(ownedFetch).mockImplementation((url) =>
    Promise.resolve({
      ok: true,
      url: String(url),
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    } as unknown as Response)
  )
}

afterEach(() => vi.clearAllMocks())

describe('articles.extract（实例缓存）', () => {
  it('extracts the main content and strips scripts/handlers', async () => {
    mockPage(`<!DOCTYPE html><html><head><title>Hello World</title>
      <meta property="og:image" content="https://example.com/cover.jpg"></head>
      <body><nav>nav junk</nav>
      <article><h1>Hello World</h1>
      <p>Real body paragraph one with enough words to be scored as content here.</p>
      <p>Second paragraph also with a fair number of words to keep the scorer happy.</p>
      <script>alert('xss')</script>
      <p onclick="evil()">handler para</p></article>
      <footer>footer junk</footer></body></html>`)

    const a = await articles.extract('https://example.com/unique-1')
    expect(a).not.toBeNull()
    expect(a!.title).toBe('Hello World')
    expect(a!.html).toBeTruthy()
    expect(a!.html).not.toMatch(/<script/i)
    expect(a!.html).not.toMatch(/onclick/i)
    expect(a!.html).toContain('Real body paragraph')
    expect(a!.domain).toBe('example.com')
  })

  it('returns null for a non-html response', async () => {
    mockPage('', 'application/json')
    expect(await articles.extract('https://example.com/unique-2')).toBeNull()
  })

  it('refuses private/loopback hosts (SSRF guard)', async () => {
    expect(await articles.extract('http://127.0.0.1/secret')).toBeNull()
    expect(await articles.extract('http://localhost:8080/x')).toBeNull()
  })
})

describe('一个实例一张缓存', () => {
  it('A 命中内存缓存不再出网；B 看不到 A 的缓存，各自出网', async () => {
    const a = new ArticleCache()
    const b = new ArticleCache()
    let hits = 0
    vi.mocked(ownedFetch).mockImplementation((url) => {
      hits++
      return Promise.resolve({
        ok: true,
        url: String(url),
        headers: { get: () => 'text/html' },
        arrayBuffer: async () => new TextEncoder().encode(
          '<html><head><title>T</title></head><body><article><p>正文内容正文内容正文内容</p></article></body></html>',
        ).buffer,
      } as unknown as Response)
    })
    await a.extract('https://one.example/page')
    await a.extract('https://one.example/page')   // A 第二次：内存缓存命中，不出网
    await b.extract('https://one.example/page')   // B 没有这份缓存：再出网一次
    expect(hits).toBe(2)
  })
})
