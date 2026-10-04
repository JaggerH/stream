import { describe, it, expect } from 'vitest'
import { parseStreamDescriptor } from './descriptor.ts'

const base = { name: '@t/x', version: '1.0.0', stream: { type: 'recipe', facility: 'x' } }
const withStream = (stream: Record<string, unknown>) => ({ ...base, stream: { ...base.stream, ...stream } })

describe('stream.providers —— expand 组合体与 provides', () => {
  const ROW = {
    id: 'x-combo', category: 'search', serveKeys: ['x-combo'], strategy: 'expand',
    label: 'X 组合', description: '关键词 → 卡片 → 详情',
    members: [{ source: 'x-search', params: { name: '$input' } }, { source: 'x-detail' }],
    expand: { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } },
    provides: ['search-download'],
  }
  it('expand / provides 整条读进描述符', () => {
    expect(parseStreamDescriptor(withStream({ providers: [ROW] }), 'x').providers).toEqual([ROW])
  })
  it('expand 缺 map / assemble → 整个包拒', () => {
    expect(() => parseStreamDescriptor(withStream({ providers: [{ ...ROW, expand: { map: {} } }] }), 'x')).toThrow(/expand/)
  })
  it('expand 与 strategy:expand 同进同退（只有一半 = 执行器里一条取不到东西的顺序梯子）', () => {
    const { expand: _e, ...noExpand } = ROW
    expect(() => parseStreamDescriptor(withStream({ providers: [noExpand] }), 'x')).toThrow(/expand/)
    expect(() => parseStreamDescriptor(withStream({ providers: [{ ...ROW, strategy: 'sequential' }] }), 'x')).toThrow(/expand/)
  })
  it('provides 不可有空串', () => {
    expect(() => parseStreamDescriptor(withStream({ providers: [{ ...ROW, provides: [''] }] }), 'x')).toThrow(/provides/)
  })
})

describe('stream.searchSources —— 资源搜索里这个源怎么认', () => {
  const S = { source: 'x-search', key: 'x', label: 'X 站', param: 'keyword', kind: 'flat', searchUrl: 'https://x.example/s?q={q}' }
  it('读进描述符', () => {
    expect(parseStreamDescriptor(withStream({ searchSources: [S] }), 'x').searchSources).toEqual([S])
  })
  it('指向本包的 Provider 行（provider）也行', () => {
    const P = { provider: 'x-combo', key: 'x', label: 'X', param: 'name', kind: 'digest' }
    expect(parseStreamDescriptor(withStream({ searchSources: [P] }), 'x').searchSources).toEqual([P])
  })
  it('source 与 provider 恰给一个', () => {
    const { source: _s, ...none } = S
    expect(() => parseStreamDescriptor(withStream({ searchSources: [none] }), 'x')).toThrow(/searchSources/)
    expect(() => parseStreamDescriptor(withStream({ searchSources: [{ ...S, provider: 'p' }] }), 'x')).toThrow(/searchSources/)
  })
  it('kind 只认 digest / flat', () => {
    expect(() => parseStreamDescriptor(withStream({ searchSources: [{ ...S, kind: 'pansou' }] }), 'x')).toThrow()
  })
  it('searchUrl 必须带 {q} 占位、是 http(s)', () => {
    expect(() => parseStreamDescriptor(withStream({ searchSources: [{ ...S, searchUrl: 'https://x.example/' }] }), 'x')).toThrow(/\{q\}/)
    expect(() => parseStreamDescriptor(withStream({ searchSources: [{ ...S, searchUrl: 'javascript:{q}' }] }), 'x')).toThrow(/searchUrl/)
  })
})

// `downloadPages` 是迁移期别名：装载时翻译成 `links.patterns`（kind download-page），再过同一把
// `linkPatternProblem`（它兼作 SSRF 白名单）。逐条红例在 links.test.ts。
describe('stream.downloadPages（迁移期别名）—— 翻译成 links', () => {
  const PAGES = [
    { pattern: '^https://(www\\.)?x\\.example/tdown/\\d+\\.html$', kind: 'magnet' },
    { pattern: '^https://(www\\.)?x\\.example/pdown/\\d+\\.html$', kind: 'unknown' },
  ]
  it('翻译成 download-page，yields = 原 kind', () => {
    expect(parseStreamDescriptor(withStream({ downloadPages: PAGES }), 'x').links?.patterns).toEqual(
      PAGES.map((p) => ({ kind: 'download-page', pattern: p.pattern, platform: 'x', yields: p.kind })))
  })
  it.each([
    ['https://x\\.example/tdown/\\d+$', '没有 ^ 锚'],
    ['^https://x\\.example/tdown/\\d+', '没有 $ 锚'],
    ['^http://x\\.example/\\d+$', '不是 https'],
    ['^https://.*$', '主机是通配（等于把整个网都放进白名单）'],
    ['^https://x\\.example/(\\d+$', '编不出来'],
  ])('%s（%s）→ 整个包拒', (pattern) => {
    expect(() => parseStreamDescriptor(withStream({ downloadPages: [{ pattern, kind: 'magnet' }] }), 'x/package.json')).toThrow(/x\/package\.json/)
  })
  it('kind 只认下载项类型', () => {
    expect(() => parseStreamDescriptor(withStream({ downloadPages: [{ ...PAGES[0], kind: 'ftp' }] }), 'x')).toThrow()
  })
})
