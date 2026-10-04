import { describe, expect, it } from 'vitest'

import { sourceIconFallbackUrl, sourceIconUrl, sourceNamespace } from './sourceIcon.ts'

describe('sourceIcon helpers', () => {
  it('包给的站点域名（site.domain）优先，前端不猜「这个包其实是哪个站」', () => {
    expect(sourceIconUrl('@acme/demo/demo-home', 'demo', 'demo.example')).toBe('https://icons.folo.is/demo.example')
    // 没有 site 时 facility.key 不是 RSSHub 命名空间 → 查不到就是查不到，不靠别名表凑。
    expect(sourceIconUrl('@acme/demo/demo-home', 'demo')).toBeUndefined()
  })

  it('keeps RSSHub namespaces and exposes a backend favicon fallback', () => {
    expect(sourceNamespace('rsshub:anime1/bangumi')).toBe('anime1')
    expect(sourceIconUrl('rsshub:anime1/bangumi')).toBe('https://icons.folo.is/anime1.me')
    expect(sourceIconFallbackUrl('rsshub:aljazeera/news')).toBe('/api/media/image?site=https%3A%2F%2Faljazeera.com')
  })
})
