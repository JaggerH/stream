import { describe, it, expect } from 'vitest'
import { linkPatternProblem, normalizeLinks, literalHostsOf, hostCovered, translateLegacyTrackUrl } from './links.ts'
import { parseStreamDescriptor } from './descriptor.ts'

const HOSTS = ['pkgsite.com']
const track = (pattern: string) => ({ kind: 'track' as const, pattern })
const page = (pattern: string, yields?: string) => ({ kind: 'download-page' as const, pattern, yields })

describe('linkPatternProblem —— 一条 links.patterns 能不能用', () => {
  it('合格的 track / download-page 过（子域落在 hosts 里也算）', () => {
    expect(linkPatternProblem(track('^https://pkgsite\\.com/song/(?<id>\\d+)'), HOSTS)).toBeNull()
    expect(linkPatternProblem(track('^https?://(?:www\\.)?pkgsite\\.com/(?:#/)?song\\?id=(?<id>\\d+)'), HOSTS)).toBeNull()
    expect(linkPatternProblem(page('^https://(www\\.)?pkgsite\\.com/down/\\d+\\.html$', 'magnet'), HOSTS)).toBeNull()
  })

  it.each([
    ['不以 ^https 开头', track('pkgsite\\.com/song/(?<id>\\d+)'), /\^https/],
    ['http 明文', track('^http://pkgsite\\.com/song/(?<id>\\d+)'), /\^https/],
    ['超长', track(`^https://pkgsite\\.com/${'a'.repeat(300)}(?<id>\\d+)`), /超过上限/],
    ['嵌套量词', track('^https://pkgsite\\.com/(?<id>(a+)+)'), /嵌套量词/],
    ['编译失败', track('^https://pkgsite\\.com/(?<id>\\d+'), /不是合法正则/],
    ['track 缺命名组 id', track('^https://pkgsite\\.com/song/(\\d+)'), /\(\?<id>/],
    ['track 带 yields', { ...track('^https://pkgsite\\.com/song/(?<id>\\d+)'), yields: 'magnet' }, /yields 只给/],
    ['download-page 不以 $ 结尾', page('^https://pkgsite\\.com/down/\\d+', 'magnet'), /\$ 结尾/],
    ['download-page 缺 yields', page('^https://pkgsite\\.com/down/\\d+$'), /yields/],
    ['主机段没有字面域名', track('^https://[a-z]+/song/(?<id>\\d+)'), /字面域名/],
    ['主机段有越界通配', page('^https://.*\\.pkgsite\\.com/x$', 'magnet'), /通配/],
    ['域名不在本包 hosts 里', track('^https://other\\.com/song/(?<id>\\d+)'), /不在本包的 links\.hosts/],
    ['命中控制 URL', track('^https?://(?:[a-z]+\\.)?(?:pkgsite\\.com|[a-z]+\\.(?:com|org))/(?<id>.*)'), /不在本包|命中了与它无关/],
  ])('%s → 红', (_name, p, reason) => {
    expect(linkPatternProblem(p as never, HOSTS)).toMatch(reason)
  })
})

describe('literalHostsOf / hostCovered', () => {
  it('只取主机段里的字面域名（路径里的 \\.html 不算）', () => {
    expect(literalHostsOf('^https://(www\\.)?pkgsite\\.com/down/abc\\.html$')).toEqual(['pkgsite.com'])
    expect(literalHostsOf('^https?://(?:a\\.com|b\\.org)/x')).toEqual(['a.com', 'b.org'])
  })
  it('按 label 边界后缀匹配', () => {
    expect(hostCovered('m.pkgsite.com', HOSTS)).toBe(true)
    expect(hostCovered('pkgsite.com', HOSTS)).toBe(true)
    expect(hostCovered('evil-pkgsite.com', HOSTS)).toBe(false)
  })
})

describe('normalizeLinks —— 归一 + 迁移期别名翻译', () => {
  const pkg = { facility: 'pkg', id: 'pkg' }

  it('字符串 host 取 facility 当 platform；{host, platform} 保留；host 归一成小写去前导点', () => {
    const d = normalizeLinks({ hosts: ['PkgSite.com', { host: '.other.net', platform: 'oth' }] }, {}, pkg)!
    expect(d.hosts).toEqual([{ host: 'pkgsite.com', platform: 'pkg' }, { host: 'other.net', platform: 'oth' }])
    expect(d.shortHosts).toEqual([])
    expect(d.patterns).toEqual([])
    expect(d.legacy).toBeUndefined()
  })

  it('没有 facility 又没写 platform → 抛', () => {
    expect(() => normalizeLinks({ hosts: ['pkgsite.com'] }, {}, { id: 'x' })).toThrow(/platform/)
    expect(normalizeLinks({ hosts: [{ host: 'pkgsite.com', platform: 'p' }] }, {}, { id: 'x' })!.hosts[0].platform).toBe('p')
  })

  it('platform 不是标识符形状 → 抛', () => {
    expect(() => normalizeLinks({ hosts: [{ host: 'pkgsite.com', platform: 'a.b' }] }, {}, pkg)).toThrow(/平台键/)
  })

  it.each([['localhost'], ['10.0.0.1'], ['com.cn'], ['127.0.0.1']])('host %s → 抛', (host) => {
    expect(() => normalizeLinks({ hosts: [host] }, {}, pkg)).toThrow(/links\.hosts\[0\]/)
  })

  it('重复主机 → 抛', () => {
    expect(() => normalizeLinks({ hosts: ['pkgsite.com', 'PKGSITE.com'] }, {}, pkg)).toThrow(/重复/)
  })

  it('shortHost 必须被 hosts 覆盖（子域算覆盖）', () => {
    expect(normalizeLinks({ hosts: ['pkgsite.com'], shortHosts: ['s.pkgsite.com'] }, {}, pkg)!.shortHosts).toEqual(['s.pkgsite.com'])
    expect(() => normalizeLinks({ hosts: ['pkgsite.com'], shortHosts: ['sho.rt'] }, {}, pkg)).toThrow(/shortHosts\[0\].*不在 links\.hosts/)
  })

  it('pattern 带着 platform，坏 pattern 抛且点名下标', () => {
    const d = normalizeLinks({ hosts: ['pkgsite.com'], patterns: [{ kind: 'track', pattern: '^https://pkgsite\\.com/s/(?<id>\\d+)' }] }, {}, pkg)!
    expect(d.patterns).toEqual([{ kind: 'track', pattern: '^https://pkgsite\\.com/s/(?<id>\\d+)', platform: 'pkg' }])
    expect(() => normalizeLinks({ hosts: ['pkgsite.com'], patterns: [{ kind: 'track', pattern: '^https://other\\.com/(?<id>\\d+)' }] }, {}, pkg)).toThrow(/patterns\[0\]/)
  })

  it('老 trackUrl 翻译成 track pattern，hosts 从字面域名推出来，legacy 留痕', () => {
    const d = normalizeLinks(undefined, { trackUrl: ['pkgsite\\.com/song/(\\d+)'] }, pkg)!
    expect(d.hosts).toEqual([{ host: 'pkgsite.com', platform: 'pkg' }])
    expect(d.legacy).toEqual(['trackUrl'])
    const re = new RegExp(d.patterns[0].pattern, 'i')
    expect(re.exec('https://pkgsite.com/song/9')?.groups?.id).toBe('9')
    expect(re.exec('https://m.pkgsite.com/song/9')?.groups?.id).toBe('9')   // 老文法未锚定，任何子域都认——语义保住
  })

  it('老 trackUrl 用裸点写域名也能翻（老校验认它）', () => {
    expect(translateLegacyTrackUrl('pkgsite.com/(?:#/)?song\\?id=(\\d+)')).toBe('^https?://(?:[a-z0-9-]+\\.)*pkgsite\\.com/(?:#/)?song\\?id=(?<id>\\d+)')
  })

  it('老 trackUrl 过宽（只写协议 + 通配）翻译后照样被拒', () => {
    expect(() => normalizeLinks(undefined, { trackUrl: ['https?://(.+)'] }, pkg)).toThrow()
    expect(() => normalizeLinks(undefined, { trackUrl: ['no-group'] }, pkg)).toThrow(/捕获组/)
  })

  it('老 downloadPages 翻译成 download-page，platform = facility ?? id', () => {
    const d = normalizeLinks(undefined, { downloadPages: [{ pattern: '^https://pkgsite\\.com/down/\\d+$', kind: 'magnet' }] }, { id: 'onlyid' })!
    expect(d.patterns).toEqual([{ kind: 'download-page', pattern: '^https://pkgsite\\.com/down/\\d+$', platform: 'onlyid', yields: 'magnet' }])
    expect(d.hosts).toEqual([{ host: 'pkgsite.com', platform: 'onlyid' }])
    expect(d.legacy).toEqual(['downloadPages'])
  })

  it('什么都没声明 → undefined', () => {
    expect(normalizeLinks(undefined, {}, pkg)).toBeUndefined()
  })
})

describe('parseStreamDescriptor 接上 links', () => {
  const withStream = (stream: Record<string, unknown>) => ({ name: '@x/pkg', version: '1.0.0', stream: { facility: 'pkg', ...stream } })

  it('带 links 的包解析出归一形状', () => {
    const d = parseStreamDescriptor(withStream({ links: { hosts: ['pkgsite.com', 'sho.rt'], shortHosts: ['sho.rt'] } }), 'x')
    expect(d.links).toEqual({ hosts: [{ host: 'pkgsite.com', platform: 'pkg' }, { host: 'sho.rt', platform: 'pkg' }], shortHosts: ['sho.rt'], patterns: [] })
  })

  it('pattern 的域名不在 hosts 里 → 整个包拒（报包路径）', () => {
    expect(() => parseStreamDescriptor(withStream({
      links: { hosts: ['pkgsite.com'], patterns: [{ kind: 'track', pattern: '^https://other\\.com/(?<id>\\d+)' }] },
    }), 'x/package.json')).toThrow(/Invalid Stream package x\/package\.json: links\.patterns\[0\]/)
  })

  it('结构错（未知 kind）→ 拒', () => {
    expect(() => parseStreamDescriptor(withStream({ links: { hosts: ['pkgsite.com'], patterns: [{ kind: 'video', pattern: '^https://pkgsite\\.com/$' }] } }), 'x')).toThrow()
  })
})
