import { describe, it, expect, afterEach } from 'vitest'
import { IntentResolver, DEFAULT_RULES } from './intent.ts'
import { setLinkDeclarationSource } from '../links/recognize.ts'
import { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(id: string, provides: string[], priority = 1): SourceManifest {
  return {
    schema_version: 1, id, adapter: 'fake', type: 'post', description: id,
    topics: [], example_queries: [], capabilities: ['timeline'],
    auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true,
    provides, priority,
  }
}

const registry = new Registry([
  mk('site-author-feed', ['site-author'], 1),
  mk('browser-page', ['site-author', 'generic-url'], 99),
  mk('pkg-search', ['pkg'], 1),
])
const ir = new IntentResolver(registry, DEFAULT_RULES)

/** 一条注入的非曲目规则（作者页）——生产表今天是空的，这里只用它钉规则循环本身。 */
const AUTHOR_RULE = {
  targetType: 'site-author',
  match: (t: string) => { const m = t.match(/example\.com\/user\/profile\/([\w-]+)/i); return m ? m[1] : null },
}

/** 站点文法在生产上来自包的 `stream.trackUrl`；测试里注入一条，源码里没有任何站的正则。 */
const trackRef = (url: string) => {
  const m = url.match(/pkgsite\.com\/song\/(\d+)/)
  return m ? { platform: 'pkg', track_id: m[1] } : null
}

describe('IntentResolver', () => {
  afterEach(() => setLinkDeclarationSource(() => []))

  // 上面每条用例都注入 trackRef，把默认实参换成 () => null 也照样绿——而那时贴进来的曲目 URL 会
  // 静默落 generic-url。这条不注入，钉住真正接在包声明表上的那条缝。
  it('不注入时走默认的 trackRefFromUrl —— 包声明的文法真的接上了', () => {
    setLinkDeclarationSource(() => [{ package: 'p', hosts: [], shortHosts: [], patterns: [{ kind: 'track', platform: 'p', pattern: '^https?://x\\.test/song/(?<id>\\d+)' }] }])
    const r = new IntentResolver(registry, DEFAULT_RULES).resolve('https://x.test/song/77')
    expect(r).toMatchObject({ targetType: 'p', key: '77' })
  })

  it('规则命中 → targetType / key 取自规则，candidates 按 provides 的优先级排', () => {
    const r = new IntentResolver(registry, [AUTHOR_RULE]).resolve('https://example.com/user/profile/abc123')
    expect(r.targetType).toBe('site-author')
    expect(r.key).toBe('abc123')
    expect(r.candidates).toEqual(['site-author-feed', 'browser-page']) // priority order
  })

  it('DEFAULT_RULES 为空：没有源能解析的作者页 URL 落 generic-url，而不是一个候选为空的目标', () => {
    expect(DEFAULT_RULES).toEqual([])
    const r = ir.resolve('https://example.com/user/profile/abc123')
    expect(r.targetType).toBe('generic-url')
    expect(r.candidates).toEqual(['browser-page'])
  })

  it('曲目 URL → targetType = 平台键、key = track id（文法来自包，不是源码里的正则）', () => {
    const ir2 = new IntentResolver(registry, DEFAULT_RULES, undefined, trackRef)
    expect(ir2.resolve('https://pkgsite.com/song/123')).toMatchObject({ targetType: 'pkg', key: '123' })
  })

  it('没有任何包声明曲目文法时，同一个 URL 落 generic-url', () => {
    const ir2 = new IntentResolver(registry, DEFAULT_RULES, undefined, () => null)
    expect(ir2.resolve('https://pkgsite.com/song/123').targetType).toBe('generic-url')
  })

  it('规则表优先于曲目文法', () => {
    const ir2 = new IntentResolver(registry, [AUTHOR_RULE], undefined, () => ({ platform: 'pkg', track_id: 'x' }))
    expect(ir2.resolve('https://example.com/user/profile/abc').targetType).toBe('site-author')
  })

  it('falls back to generic-url for an unmatched URL', () => {
    const r = ir.resolve('https://example.com/some/page')
    expect(r.targetType).toBe('generic-url')
    expect(r.key).toBe('https://example.com/some/page')
    expect(r.candidates).toEqual(['browser-page'])
  })

  it('marks a non-URL unmatched input as unknown with no candidates', () => {
    const r = ir.resolve('just some text')
    expect(r.targetType).toBe('unknown')
    expect(r.candidates).toEqual([])
  })

  it('uses the injected candidates resolver (live resolve ladder) instead of provides tags', () => {
    // 平台键的解析能力住在 radar matchers 里，不在 provides —— 注入的解析器给出 Provider 行展开后的
    // 目录源，默认的 providesOf 看不到它们。
    const ladder: Record<string, string[]> = { pkg: ['pkg-dl-a', 'pkg-dl-b'] }
    const ir2 = new IntentResolver(registry, DEFAULT_RULES, (tt) => ladder[tt] ?? [], trackRef)
    const r = ir2.resolve('https://pkgsite.com/song/1')
    expect(r.targetType).toBe('pkg')
    expect(r.candidates).toEqual(['pkg-dl-a', 'pkg-dl-b'])
  })
})
