import { describe, it, expect } from 'vitest'
import { parseStreamDescriptor, rsshubCookieEnvProblem } from './descriptor.ts'

const base = { name: '@t/x', version: '1.0.0', stream: { type: 'recipe', facility: 'x' } }
const withStream = (stream: Record<string, unknown>) => ({ ...base, stream: { ...base.stream, ...stream } })
const ROW = {
  id: 'x-track', category: 'resolve', serveKeys: ['x', 'x.com'], strategy: 'sequential',
  label: 'X 取歌', description: 'id → 地址',
  members: [{ mode: 'auto', matches: 'x.com/song', params: { id: '$input' } }],
  callsites: ['music.track.resolve'],
}

describe('stream.providers —— 包出 Provider 行', () => {
  it('整条读进描述符', () => {
    expect(parseStreamDescriptor(withStream({ providers: [ROW] }), 'x/package.json').providers).toEqual([ROW])
  })
  it('fallback / contract / callsites 可省略', () => {
    const { callsites: _c, ...noCallsites } = ROW
    const d = parseStreamDescriptor(withStream({ providers: [noCallsites] }), 'x')
    expect(d.providers?.[0].callsites).toBeUndefined()
    expect(d.providers?.[0].fallback).toBeUndefined()
  })
  it('label / description 不可空', () => {
    expect(() => parseStreamDescriptor(withStream({ providers: [{ ...ROW, label: '' }] }), 'x')).toThrow(/label/)
  })
  it('serveKeys 不可为空数组（一条谁都不服务的行 = 死配置）', () => {
    expect(() => parseStreamDescriptor(withStream({ providers: [{ ...ROW, serveKeys: [] }] }), 'x')).toThrow(/serveKeys/)
  })
  it('category 必须是已知的 ProviderCategory', () => {
    expect(() => parseStreamDescriptor(withStream({ providers: [{ ...ROW, category: 'nope' }] }), 'x')).toThrow()
  })
  it('members 至少一条，且每条必须是合法成员形状', () => {
    expect(() => parseStreamDescriptor(withStream({ providers: [{ ...ROW, members: [] }] }), 'x')).toThrow(/members/)
    expect(() => parseStreamDescriptor(withStream({ providers: [{ ...ROW, members: [{ nonsense: 1 }] }] }), 'x')).toThrow(/members/)
  })
})

// `trackUrl` 是迁移期别名：装载时翻译成 `links.patterns`（kind track），再过同一把 `linkPatternProblem`。
// 规则本身的逐条红例在 links.test.ts；这里只钉「老写法照样被读进来 / 照样被拒」。
describe('stream.trackUrl（迁移期别名）—— 翻译成 links', () => {
  it('翻译成 track pattern，platform = facility，legacy 留痕', () => {
    const d = parseStreamDescriptor(withStream({ trackUrl: ['x\\.com/song\\?id=(\\d+)'] }), 'x')
    expect(d.links?.patterns).toEqual([{ kind: 'track', platform: 'x', pattern: '^https?://(?:[a-z0-9-]+\\.)*x\\.com/song\\?id=(?<id>\\d+)' }])
    expect(d.links?.hosts).toEqual([{ host: 'x.com', platform: 'x' }])
    expect(d.links?.legacy).toEqual(['trackUrl'])
  })
  it.each([
    ['x\\.com/song\\?id=\\d+', '没有捕获组'],
    ['(.*)', '只有通配'],
    ['https?://(.+)', '只写协议（会把任何粘进来的链接改标成这家的曲目）'],
    ['song/(\\d+)', '不指名域名'],
    ['x\\.com/(', '编不出来'],
    ['x\\.com/(a+)+$', '嵌套量词'],
    [`x\\.com/${'a'.repeat(300)}(\\d+)`, '超长'],
  ])('%s（%s）→ 整个包拒', (src) => {
    expect(() => parseStreamDescriptor(withStream({ trackUrl: [src] }), 'x/package.json')).toThrow(/x\/package\.json/)
  })
})

describe('stream.rsshubNamespaces —— 这些命名空间的路由用我的 normalizer', () => {
  it('读进描述符', () => {
    expect(parseStreamDescriptor(withStream({ rsshubNamespaces: ['163'] }), 'x').rsshubNamespaces).toEqual(['163'])
  })
  it('空条目拒', () => {
    expect(() => parseStreamDescriptor(withStream({ rsshubNamespaces: [''] }), 'x')).toThrow()
  })
})

describe('stream.rsshubNoBrowserNamespaces —— 标了 puppeteer 但带 cookie 纯 HTTP 能跑的命名空间', () => {
  it('读进描述符', () => {
    expect(parseStreamDescriptor(withStream({ rsshubNoBrowserNamespaces: ['ns-a'] }), 'x').rsshubNoBrowserNamespaces).toEqual(['ns-a'])
  })
  it('不声明就是 undefined（不补空数组）', () => {
    expect(parseStreamDescriptor(withStream({}), 'x').rsshubNoBrowserNamespaces).toBeUndefined()
  })
  it('空条目拒', () => {
    expect(() => parseStreamDescriptor(withStream({ rsshubNoBrowserNamespaces: [''] }), 'x')).toThrow()
  })
})

describe('stream.rsshubCookieEnv —— RSSHub 要的那个环境变量名', () => {
  const parse = (v: unknown) => parseStreamDescriptor(
    { name: '@t/x', version: '1.0.0', stream: { type: 'recipe', facility: 'x', rsshubCookieEnv: v } }, 'x/package.json')
  it('读进描述符', () => {
    expect(parse('SITE_COOKIE_{UserId}').rsshubCookieEnv).toBe('SITE_COOKIE_{UserId}')
  })
  it('没有占位符也合法（固定变量名）', () => {
    expect(parse('SITE_COOKIE').rsshubCookieEnv).toBe('SITE_COOKIE')
  })
  it.each([
    ['site_cookie_{X}', '小写开头'],
    ['SITE-COOKIE', '带连字符'],
    ['{X}_COOKIE', '占位符开头'],
    ['SITE_COOKIE_{X', '括号没闭'],
    ['SITE_COOKIE_{}', '空占位符'],
  ])('%s（%s）→ 整个包拒', (tpl) => {
    expect(() => parse(tpl)).toThrow(/x\/package\.json/)
    expect(rsshubCookieEnvProblem(tpl as string)).not.toBeNull()
  })
})
