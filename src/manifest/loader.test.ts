import { describe, it, expect, vi } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { loadManifests, manifestSchema } from './loader.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => join(here, '__fixtures__', name)

describe('loadManifests', () => {
  it('loads valid manifests and applies defaults', () => {
    const m = loadManifests(fx('valid'))
    expect(m.map((x) => x.id)).toContain('hn-best')
    const hn = m.find((x) => x.id === 'hn-best')!
    expect(hn.schema_version).toBe(1)
    expect(hn.discoverable).toBe(true)
    expect(hn.auth).toEqual({ type: 'none' })
  })

  it('rejects a manifest missing a required field', () => {
    expect(() => loadManifests(fx('missing-id'))).toThrow(/id/)
  })

  it('loads a cookie manifest that declares its inject', () => {
    const m = loadManifests(fx('cookie-inject'))
    expect(m[0].auth).toEqual({
      type: 'cookie',
      domain: 'xueqiu.com',
      inject: { kind: 'env', name: 'XUEQIU_COOKIES' },
    })
  })

  it('keeps `optional: true` on a cookie auth — zod 剥未知键，这一格漏声明就静默丢', () => {
    // 消费端是 credentials/resolver.ts：没解析到 cookie 时 optional 放行游客态、否则抛。
    // 丢了这一位，一个「没登录也能搜」的源会在没 cookie 的机器上整条报错。
    const m = loadManifests(fx('cookie-optional'))
    expect(m[0].auth).toEqual({
      type: 'cookie',
      domain: 'example.com',
      inject: { kind: 'transform', ref: 'example' },
      optional: true,
    })
  })

  it('rejects a cookie manifest that omits inject', () => {
    expect(() => loadManifests(fx('cookie-no-inject'))).toThrow(/inject/)
  })

  it('accepts a login:oauth session manifest that omits account — recipe 不该写死某个用户的邮箱', () => {
    // account 是每个用户各一份的邮箱，而 manifest/recipe 是随包分发给所有用户的——包里写死
    // 某人的邮箱是荒谬的。缺席是合法的常态：语义是「不替用户自动选账号，让他自己点」，真正
    // 的值在登录发起时从用户的 runtime_config 现取（src/kernel/plugins/auth.ts 的 startLogin）。
    const m = loadManifests(fx('oauth-missing-account'))
    expect(m[0].auth).toMatchObject({ login: 'oauth', oauthButton: '#oauth-google' })
    expect((m[0].auth as { account?: string }).account).toBeUndefined()
  })

  it('rejects a login:oauth session manifest that omits loginUrl/oauthButton/accountSelector', () => {
    // 这三个字段是包该提供的东西（不是用户配置），缺了才是真的漏填。
    expect(() => loadManifests(fx('oauth-missing-required'))).toThrow(/oauthButton/)
  })

  it('accepts a fully-declared login:oauth session manifest, account included', () => {
    const m = loadManifests(fx('oauth-full'))
    expect(m[0].auth).toMatchObject({
      type: 'session', facility: 'groq', login: 'oauth',
      loginUrl: 'https://console.groq.com/login',
      oauthButton: '#oauth-google',
      accountSelector: '[data-identifier="{email}"]',
      account: 'me@example.com',
    })
  })

  it('tolerates unknown future fields', () => {
    const m = loadManifests(fx('unknown-field'))
    expect(m).toHaveLength(1)
    expect(m[0].id).toBe('future-source')
    // unknown `actions` key is stripped, not fatal
    expect((m[0] as unknown as Record<string, unknown>).actions).toBeUndefined()
  })

  it('defaults type to post when omitted', () => {
    const hn = loadManifests(fx('valid')).find((x) => x.id === 'hn-best')!
    expect(hn.type).toBe('post')
  })

  it('preserves a declared type', () => {
    const m = loadManifests(fx('typed'))
    expect(m[0].type).toBe('conversation')
  })

  it('rejects an unknown type', () => {
    expect(() => loadManifests(fx('bad-type'))).toThrow(/type/)
  })

  it('parses a fan_out declaration', () => {
    const m = loadManifests(fx('fanout'))
    expect(m[0].id).toBe('pansou-like')
    expect(m[0].fan_out).toEqual({
      dimension: 'channels',
      strategy: 'batch',
      batch_key: ['cloud_types', 'filter', 'src'],
    })
  })

  it('leaves fan_out undefined when not declared', () => {
    const hn = loadManifests(fx('valid')).find((x) => x.id === 'hn-best')!
    expect(hn.fan_out).toBeUndefined()
  })

  it('parses a declarative api binding (endpoint/query/unwrap)', () => {
    const d = loadManifests(fx('api-binding')).find((x) => x.id === 'decl-source')!
    expect(d.api).toEqual({
      endpoint: '/api/tiktok/web/fetch_user_post',
      query: {
        secUid: { from: 'sec_uid', required: true },
        count: { from: 'count', default: 35 },
      },
      unwrap: 'data.itemList',
    })
  })

  it('parses a handler api binding', () => {
    const h = loadManifests(fx('api-binding')).find((x) => x.id === 'handler-source')!
    expect(h.api).toEqual({ handler: 'douyin-search' })
  })

  it('leaves api undefined when not declared', () => {
    const hn = loadManifests(fx('valid')).find((x) => x.id === 'hn-best')!
    expect(hn.api).toBeUndefined()
  })

  it('parses a radar block', () => {
    const m = loadManifests(fx('radar'))[0]
    expect(m.radar).toEqual([{ source: ['douyin.com/user/:sec_user_id'] }])
  })

  it('parses a declared facility', () => {
    const m = loadManifests(fx('facility'))
    expect(m[0].facility).toEqual({ key: 'bilibili', label: '哔哩哔哩' })
  })

  it('leaves facility undefined when not declared', () => {
    const hn = loadManifests(fx('valid')).find((x) => x.id === 'hn-best')!
    expect(hn.facility).toBeUndefined()
  })

  it('parses a shared runtime configuration declaration with secret and value fields', () => {
    const parsed = manifestSchema.parse({
      id: 'tmdb-metadata', adapter: 'builtin', description: 'TMDb source runtime configuration fixture',
      topics: [], example_queries: [], capabilities: ['anchor'], auth: { type: 'none' },
      params_schema: {}, cadence_hint_seconds: 3600, discoverable: false,
      runtime_config: {
        ref: 'tmdb',
        fields: {
          apiKey: { type: 'secret', label: 'TMDb API Key', required: true, description: '申请说明', helpUrl: 'https://example.com/key' },
          language: { type: 'string', label: '语言', default: 'zh-CN' },
        },
      },
    })
    expect(parsed.runtime_config).toEqual({
      ref: 'tmdb',
      fields: {
        apiKey: { type: 'secret', label: 'TMDb API Key', required: true, description: '申请说明', helpUrl: 'https://example.com/key' },
        language: { type: 'string', label: '语言', default: 'zh-CN' },
      },
    })
  })

  it('warns on thin/undiscoverable manifests but still loads them', () => {
    const onWarn = vi.fn()
    const m = loadManifests(fx('thin'), { onWarn })
    expect(m).toHaveLength(1)
    expect(onWarn).toHaveBeenCalledOnce()
    expect(onWarn.mock.calls[0][0].message).toMatch(/undiscoverable/)
  })
})

describe('manifest mode', () => {
  const base = {
    adapter: 'builtin', description: 'fixture manifest for mode derivation tests',
    topics: [], example_queries: [], capabilities: ['anchor'] as const, auth: { type: 'none' } as const,
    params_schema: {}, cadence_hint_seconds: 3600, discoverable: false,
  }

  it('keeps explicit mode and defaults absent to undefined (feed at consume)', () => {
    expect(manifestSchema.parse({ ...base, id: 'y', mode: 'collection' }).mode).toBe('collection')
    expect(manifestSchema.parse({ ...base, id: 'z' }).mode).toBeUndefined()
  })

  // `ordering:'snapshot'` was mode's predecessor. The alias is retired: a manifest still declaring
  // it is simply a manifest without a mode (→ feed), and the field is stripped by the schema.
  it('ignores the retired ordering alias', () => {
    const m = manifestSchema.parse({ ...base, id: 'w', ordering: 'snapshot' }) as { mode?: string; ordering?: string }
    expect(m.mode).toBeUndefined()
    expect(m.ordering).toBeUndefined()
  })
})
