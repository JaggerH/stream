import { describe, it, expect } from 'vitest'
import { parseStreamDescriptor } from './descriptor.ts'

describe('parseStreamDescriptor', () => {
  it('parses a plugin-shaped descriptor', () => {
    const d = parseStreamDescriptor(
      {
        name: '@streamapp/pansou',
        version: '1.2.0',
        stream: {
          id: 'pansou',
          name: 'PanSou',
          tagline: '网盘资源搜索',
          backend: { image: 'ghcr.io/fish2018/pansou:latest', port: 8888 },
          credentials: ['quark.cn'],
          normalizer: 'pansou',
        },
      },
      'pansou/package.json',
    )
    expect(d.id).toBe('pansou')
    expect(d.pkgName).toBe('@streamapp/pansou')
    expect(d.pkgVersion).toBe('1.2.0')
    expect(d.backend).toEqual({ image: 'ghcr.io/fish2018/pansou:latest', port: 8888 })
    expect(d.credentials).toEqual(['quark.cn'])
    expect(d.normalizer).toBe('pansou')
    expect(d.legacySchemaVersion).toBeUndefined()
  })

  it('backend.user 只接受 uid 或 uid:gid 数字形（Config.User 的形状），别的拒', () => {
    const with_ = (user: string) =>
      parseStreamDescriptor(
        { name: 'x', version: '1.0.0', stream: { id: 'x', name: 'x', backend: { image: 'i', port: 1, user } } },
        'x/package.json',
      )
    expect(with_('0:0').backend?.user).toBe('0:0')
    expect(with_('1001').backend?.user).toBe('1001')
    expect(() => with_('root')).toThrow()
    expect(() => with_('')).toThrow()
  })

  it('parses a legacy recipe-shaped descriptor and derives id from facility', () => {
    const d = parseStreamDescriptor(
      {
        name: '@streamapp/xhs',
        version: '1.0.0',
        stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1, cookieDomain: '.xiaohongshu.com' },
      },
      'xhs/package.json',
    )
    expect(d.id).toBe('xhs')
    expect(d.facility).toBe('xhs')
    expect(d.cookieDomain).toBe('.xiaohongshu.com')
    expect(d.legacySchemaVersion).toBe(1)
  })

  it('carries rateLimit and hostVersion through', () => {
    const d = parseStreamDescriptor(
      { stream: { id: 'lizhi', facility: 'lizhi', hostVersion: '>=0.9.0', rateLimit: { burst: 3, perMinute: 20 } } },
      'lizhi/package.json',
    )
    expect(d.hostVersion).toBe('>=0.9.0')
    expect(d.rateLimit).toEqual({ burst: 3, perMinute: 20 })
  })

  it('carries the hourly budget (perHour) through — zod 会把没声明的键直接丢掉，漏了它就是静默降级', () => {
    // 漏在 rateLimitSchema 里不会报错，只会让包里写的 perHour 变成「没有累计上限」：
    // 一个本该在一百发处停下的搜索腿，会一路打到站点把整个出口封掉。
    const d = parseStreamDescriptor(
      { stream: { id: 'google', facility: 'google', rateLimit: { burst: 6, perMinute: 30, perHour: 100, maxWaitMs: 10000 } } },
      'google/package.json',
    )
    expect(d.rateLimit).toEqual({ burst: 6, perMinute: 30, perHour: 100, maxWaitMs: 10000 })
  })

  it('carries the code slot through and requires a non-empty entry', () => {
    const d = parseStreamDescriptor(
      { stream: { id: 'pansou', code: { entry: './activate.ts', adapters: ['pansou'], normalizers: ['pansou'] } } },
      'pansou/package.json',
    )
    expect(d.code).toEqual({ entry: './activate.ts', adapters: ['pansou'], normalizers: ['pansou'] })
    expect(() => parseStreamDescriptor({ stream: { id: 'x', code: { adapters: ['a'] } } }, 'x/package.json')).toThrow(
      /code\.entry/,
    )
    expect(() =>
      parseStreamDescriptor({ stream: { id: 'x', code: { entry: './a.ts', adapters: [''] } } }, 'x/package.json'),
    ).toThrow(/code\.adapters\[0\]/)
  })

  it('strips unknown fields instead of rejecting them', () => {
    const d = parseStreamDescriptor({ stream: { id: 'x', futureField: 42 } }, 'x/package.json')
    expect(d.id).toBe('x')
    expect((d as unknown as Record<string, unknown>).futureField).toBeUndefined()
  })

  it('throws with the label when there is no stream field', () => {
    expect(() => parseStreamDescriptor({ name: 'plain-npm-pkg' }, 'nope/package.json')).toThrow(
      /nope\/package\.json/,
    )
  })

  it('throws when neither id nor facility is present', () => {
    expect(() => parseStreamDescriptor({ stream: { name: 'x' } }, 'bad/package.json')).toThrow(/id/)
  })

  it('validates inline sources through manifestSchema', () => {
    expect(() =>
      parseStreamDescriptor({ stream: { id: 'x', sources: [{ id: 'no-adapter' }] } }, 'x/package.json'),
    ).toThrow(/sources\[0\]/)
  })

  // 取 cookie 是后缀匹配，所以申报一个后缀 = 申报它下面所有站点。
  // 申报名单是这个包的授权边界，边界必须落在具体站点上。
  describe('credentials 必须是具体站点域名', () => {
    const parse = (creds: string[]) =>
      parseStreamDescriptor({ stream: { id: 'p', credentials: creds } }, 'p/package.json')

    it('accepts a concrete site domain', () => {
      expect(parse(['douyin.com', 'tiktok.com']).credentials).toEqual(['douyin.com', 'tiktok.com'])
    })

    it('accepts a subdomain', () => {
      expect(parse(['pan.quark.cn']).credentials).toEqual(['pan.quark.cn'])
    })

    it.each(['cn', 'com', 'localhost'])('rejects the single-label %s', (d) => {
      expect(() => parse([d])).toThrow(/credentials/)
    })

    it.each(['com', 'net', 'org', 'cn', 'io', 'com.cn', 'co.uk'])('rejects the public suffix %s', (d) => {
      expect(() => parse([d])).toThrow()
    })

    it('rejects a public suffix regardless of case or leading dot', () => {
      expect(() => parse(['.CO.UK'])).toThrow()
    })

    it('names the package, the offending entry, the reason and the fix', () => {
      let msg = ''
      try {
        parse(['cn'])
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toMatch(/p\/package\.json/) // 哪个包
      expect(msg).toMatch(/'cn'|"cn"|`cn`/) // 哪一条
      expect(msg).toMatch(/它下面所有站点/) // 为什么
      expect(msg).toMatch(/pan\.quark\.cn/) // 该写什么
    })

    it('rejects an empty entry', () => {
      expect(() => parse([''])).toThrow()
    })
  })
})

describe('stream.capability 槽位', () => {
  const parse = (capability: unknown) =>
    parseStreamDescriptor({ name: '@streamapp/x', stream: { id: 'x', capability } }, 'x/package.json')

  it('受理字面量 dist/index.js', () => {
    expect(parse('dist/index.js').capability).toBe('dist/index.js')
  })

  // 白名单只对这一个含 `/` 的路径开例外（recipe-install 的 isAllowedPackageFile）——
  // schema 松一格，安装门就得再判一次同一件事，两份判据迟早分家。
  it.each(['dist/main.js', 'index.js', '../evil.js', ''])('拒绝 %s', (bad) => {
    expect(() => parse(bad)).toThrow(/capability/)
  })

  it('缺席时描述里没有这一格', () => {
    expect('capability' in parseStreamDescriptor({ stream: { id: 'x' } }, 'x/package.json')).toBe(false)
  })
})

describe('stream.code 的 enrichers / connect 两份名单', () => {
  it('code.enrichers / code.connect 读进描述符', () => {
    const d = parseStreamDescriptor(
      { name: '@t/x', version: '1.0.0', stream: { type: 'recipe', facility: 'x', code: { entry: 'a.ts', enrichers: ['x-comments'], connect: ['x.com'] } } },
      'x/package.json',
    )
    expect(d.code?.enrichers).toEqual(['x-comments'])
    expect(d.code?.connect).toEqual(['x.com'])
  })
  it('两个名单里的空条目拒', () => {
    const bad = (code: Record<string, unknown>) => () => parseStreamDescriptor(
      { name: '@t/x', version: '1.0.0', stream: { type: 'recipe', facility: 'x', code: { entry: 'a.ts', ...code } } }, 'x')
    expect(bad({ enrichers: [''] })).toThrow()
    expect(bad({ connect: [''] })).toThrow()
  })
})
