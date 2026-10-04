import { describe, expect, it, vi } from 'vitest'
import { charsetOf, decodeBody, makeHtmlFetch } from './html-fetch.ts'
import type { HtmlRecipe } from './recipe.ts'

const base: HtmlRecipe = {
  version: 1, kind: 'html', sourceId: 'test',
  request: { url: 'https://s.com/list', method: 'GET' },
  list: { selector: 'li', fields: { title: { text: true } } },
  pagination: { mode: 'increment', param: 'page', start: 1, step: 1, maxPages: 1 },
  assert: [{ selector: 'li', desc: 'has rows' }],
}

describe('makeHtmlFetch', () => {
  it('returns the response body as text for a public URL', async () => {
    const doFetch = vi.fn(async () => new Response('<li>hi</li>', { status: 200 }))
    const fetchHtml = makeHtmlFetch(base, undefined, doFetch as unknown as typeof fetch)
    const out = await fetchHtml({ url: 'https://s.com/list', method: 'GET', headers: {} })
    expect(out).toBe('<li>hi</li>')
  })

  it('refuses a non-public URL before fetching (SSRF guard)', async () => {
    const doFetch = vi.fn()
    const fetchHtml = makeHtmlFetch(base, undefined, doFetch as unknown as typeof fetch)
    await expect(fetchHtml({ url: 'http://127.0.0.1:4555/api/health', method: 'GET', headers: {} })).rejects.toThrow(/non-public/)
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('throws on an upstream error status rather than returning empty', async () => {
    const doFetch = vi.fn(async () => new Response('nope', { status: 502 }))
    const fetchHtml = makeHtmlFetch(base, undefined, doFetch as unknown as typeof fetch)
    await expect(fetchHtml({ url: 'https://s.com/list', method: 'GET', headers: {} })).rejects.toThrow(/502/)
  })
})

// 非 UTF-8 的中文站（GBK/GB2312/Big5）过去一律读成乱码，**而乱码不报错**：选择器一条都不
// 命中，表现成「这个源今天没有内容」，跟站点改版长得一模一样。实测 2026-09-02：中关村在线
// 产品库 `content-type: text/html; charset=GBK`。
const gbk = (s: string): Uint8Array => {
  // 「中国」的 GBK 字节，够验解码走没走对——UTF-8 解出来是 4 个替换字符。
  const table: Record<string, number[]> = { 中: [0xd6, 0xd0], 国: [0xb9, 0xfa] }
  const out: number[] = []
  for (const ch of s) out.push(...(table[ch] ?? [ch.charCodeAt(0)]))
  return new Uint8Array(out)
}

describe('按响应声明的字符集解码', () => {
  it('Content-Type 里写了 charset 就照它解', async () => {
    const body = gbk('<li>中国</li>')
    const doFetch = vi.fn(
      async () => new Response(body.buffer as ArrayBuffer, { status: 200, headers: { "content-type": "text/html; charset=GBK" } }),
    )
    const fetchHtml = makeHtmlFetch(base, undefined, doFetch as unknown as typeof fetch)
    expect(await fetchHtml({ url: 'https://s.com/list', method: 'GET', headers: {} })).toBe('<li>中国</li>')
  })

  it('头里没说就嗅探页面自己的 <meta charset>', () => {
    const body = gbk('<html><head><meta charset="gbk"></head><body>中国')
    expect(charsetOf(null, body.buffer as ArrayBuffer)).toBe('gbk')
    expect(decodeBody(null, body.buffer as ArrayBuffer)).toContain('中国')
  })

  it('两处都没说 → UTF-8（老行为不变）', () => {
    const body = new TextEncoder().encode('<li>hi</li>')
    expect(charsetOf(null, body.buffer as ArrayBuffer)).toBe('utf-8')
    expect(decodeBody('text/html', body.buffer as ArrayBuffer)).toBe('<li>hi</li>')
  })

  it('编码标签不认识 → 退回 UTF-8，不许整条源挂掉', () => {
    const body = new TextEncoder().encode('<li>hi</li>')
    expect(decodeBody('text/html; charset=x-not-a-charset', body.buffer as ArrayBuffer)).toBe('<li>hi</li>')
  })
})
