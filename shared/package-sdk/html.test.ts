import { describe, expect, it } from 'vitest'

import { extractImages, extractLinks, firstLink } from './html.ts'

// 属性值是**转义过的 HTML**，取出来必须解码——不解码就会把 `&amp;` 原样留在 URL 里。
// 真实事故（掘金）：封面是签名 CDN 链（`?rk3s=…&x-expires=…&x-signature=…`），存下来的是
// `&amp;x-expires=…`，浏览器请求到的是一个查询参数名叫 `amp;x-expires` 的 URL，签名校验
// 不过 → 403，卡片上一张图都不出。而后端这边没有任何一处会喊：URL 非空、media 有值、
// archetype 是 gallery，全都"正常"。
describe('属性里的 HTML 实体', () => {
  it('extractImages 解码 src 里的 &amp;', () => {
    const html = '<img src="https://cdn.example.com/a.webp?rk3s=x&amp;x-expires=1&amp;x-signature=y%3D">'
    expect(extractImages(html)[0].url).toBe('https://cdn.example.com/a.webp?rk3s=x&x-expires=1&x-signature=y%3D')
  })

  it('extractLinks / firstLink 同样解码 href', () => {
    const html = '<a href="https://example.com/?a=1&amp;b=2">t</a>'
    expect(extractLinks(html)[0].url).toBe('https://example.com/?a=1&b=2')
    expect(firstLink(html)).toBe('https://example.com/?a=1&b=2')
  })

  it('数字实体与 &quot;/&#39; 也解码', () => {
    const html = '<img src="https://example.com/a.png?q=1&#38;w=&quot;2&quot;&#x26;e=&#39;3&#39;">'
    expect(extractImages(html)[0].url).toBe('https://example.com/a.png?q=1&w="2"&e=\'3\'')
  })

  it('不碰没有实体的 URL', () => {
    const html = '<img src="https://example.com/a.png?q=1&w=2">'
    expect(extractImages(html)[0].url).toBe('https://example.com/a.png?q=1&w=2')
  })
})
