// 门装在 app 上之后还成立吗——判据的单测在 access-guard.test.ts，这里测的是**接线**：
// 中间件盖住了该盖的路由、放过了刻意豁免的那几条、以及"后挂的路由也在门后"。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createHttpApiFixture, type HttpApiFixture } from './__fixtures__/app-harness.ts'

const TOKEN = 'c'.repeat(64)
const EXT_ID = 'dmhlfkdjljnilhnfajjpaobehenbokij'

let fixture: HttpApiFixture
beforeEach(() => { fixture = createHttpApiFixture() })
afterEach(() => { fixture.close() })

/** 门后挂一个不依赖任何业务 dep 的探针：这里要测的是门，不是某个端点自己的死活。
 *  挂载时机也刻意复刻 serve.ts——业务路由和 /api/mcp 都是在 createHttpApp **之后**才上去的。 */
function build(guard: { token: string; extId?: string; trustedHosts?: string[]; trustedOrigins?: string[] } | null = {
  token: TOKEN,
  extId: EXT_ID,
}) {
  const app = fixture.build(undefined, { accessGuard: guard ?? undefined })
  app.get('/api/__probe', (c) => c.json({ ok: true }))
  app.post('/api/__probe', (c) => c.json({ ok: true }))
  return app
}

/**
 * 发一次请求。两个必要的伪造：
 * - `address` → Hono 的第三参就是 node-server 的 env，getConnInfo 读的正是这里，于是不起真 socket 也能定对端。
 * - `host` → 真实 HTTP 请求必然带 Host 头，进程内 `app.request()` 不带；不显式给就会撞上 fail-closed。
 */
const req = (
  app: ReturnType<typeof build>,
  path: string,
  o: { address?: string; host?: string; origin?: string; bearer?: string; method?: string } = {}
) => {
  const headers: Record<string, string> = { Host: o.host ?? '127.0.0.1:8900' }
  if (o.origin !== undefined) headers.Origin = o.origin
  if (o.bearer !== undefined) headers.Authorization = `Bearer ${o.bearer}`
  return app.request(
    path,
    { headers, method: o.method ?? 'GET' },
    o.address === undefined ? undefined : { incoming: { socket: { remoteAddress: o.address } } }
  )
}

describe('/api/* 的门 —— 来源维度（本机免密 / 外来要 token）', () => {
  it('放行本机，拦住不带凭证的局域网访问', async () => {
    const app = build()
    expect((await req(app, '/api/__probe', { address: '127.0.0.1' })).status).toBe(200)
    expect((await req(app, '/api/__probe', { address: '10.0.0.21', host: '10.0.0.21:8900' })).status).toBe(401)
  })

  it('局域网带对 token 就放行，带错的照拦', async () => {
    const app = build()
    const lan = (extra: Record<string, string>) =>
      req(app, '/api/__probe', { address: '10.0.0.21', host: '10.0.0.21:8900', ...extra })
    expect((await lan({ bearer: TOKEN })).status).toBe(200)
    expect((await lan({ bearer: 'd'.repeat(64) })).status).toBe(401)
    // ?token= 是给浏览器 WebSocket 和手机首访链接留的那条路
    const q = await req(app, `/api/__probe?token=${TOKEN}`, { address: '10.0.0.21', host: '10.0.0.21:8900' })
    expect(q.status).toBe(200)
  })

  it('取不到对端地址时按外来处理（fail-closed）', async () => {
    expect((await req(build(), '/api/__probe')).status).toBe(401)
  })
})

describe('/api/* 的门 —— 浏览器维度（这道才挡得住本机上的恶意网页）', () => {
  it('拦住任意网页 fetch 127.0.0.1，哪怕它就在本机上', async () => {
    // 这是"本机免密"挡不住的那一类：来源地址就是 loopback，跟我们自己的前端毫无区别。
    const app = build()
    const r = await req(app, '/api/__probe', { address: '127.0.0.1', origin: 'https://evil.com' })
    expect(r.status).toBe(403)
  })

  it('放行我们自己的前端（同源）和我们自己的扩展', async () => {
    const app = build()
    expect((await req(app, '/api/__probe', { address: '127.0.0.1', origin: 'http://127.0.0.1:8900' })).status).toBe(200)
    const fromExt = await req(app, '/api/__probe', {
      address: '127.0.0.1',
      origin: `chrome-extension://${EXT_ID}`,
      method: 'POST',
    })
    expect(fromExt.status).toBe(200)
    // 别的扩展不行
    const other = await req(app, '/api/__probe', {
      address: '127.0.0.1',
      origin: `chrome-extension://${'a'.repeat(32)}`,
      method: 'POST',
    })
    expect(other.status).toBe(403)
  })

  it('拦住 DNS rebinding：域名没登记过就不认，哪怕它解析到了本机', async () => {
    const app = build()
    const rebind = { address: '127.0.0.1', host: 'evil.com', origin: 'http://evil.com' }
    expect((await req(app, '/api/__probe', rebind)).status).toBe(403)
    // 自托管登记过的域名照常放行
    const registered = build({ token: TOKEN, extId: EXT_ID, trustedHosts: ['stream.example.com'] })
    const ok = await req(registered, '/api/__probe', {
      address: '127.0.0.1',
      host: 'stream.example.com',
      origin: 'https://stream.example.com',
    })
    expect(ok.status).toBe(200)
  })
})

describe('/api/* 的门 —— 别的口上的页面（trustedOrigins 接线）', () => {
  it('放行登记的非本机 origin，仍然拦住没登记的', async () => {
    // 钉的是 app.ts 里 `trustedOrigins` 到 `isTrustedOrigin` 的 extraOrigins 那一段接线：
    // 光测 access-guard.test.ts 里的纯函数不够——真出问题的方式是接线本身被重构掉（少传了
    // 这个参数），那种改动不会碰纯函数一行，却会让登记过的页面的每一次 fetch 静默变回 403。
    const trusted = 'http://10.0.0.5:3000'
    const app = build({ token: TOKEN, extId: EXT_ID, trustedOrigins: [trusted] })
    const fromTrusted = await req(app, '/api/__probe', { address: '127.0.0.1', origin: trusted })
    expect(fromTrusted.status).toBe(200)
    const fromOther = await req(app, '/api/__probe', { address: '127.0.0.1', origin: 'http://10.0.0.6:3000' })
    expect(fromOther.status).toBe(403)
  })

  it('本机任意口上的页面不用登记就能打 /api —— 用户 DSH 里那张 Stream 页就是这种', async () => {
    const app = build({ token: TOKEN, extId: EXT_ID })
    const r = await req(app, '/api/__probe', { address: '127.0.0.1', origin: 'http://127.0.0.1:8901' })
    expect(r.status).toBe(200)
  })
})

describe('/api/* 的门 —— 覆盖面', () => {
  it('豁免的那几条仍然不需要凭证——它们正是连不上时要用的', async () => {
    const app = build()
    for (const path of ['/api/health', '/api/ext/relay-status', '/api/browser-capability']) {
      const r = await req(app, path, { address: '10.0.0.21', host: '10.0.0.21:8900' })
      expect(r.status).not.toBe(401)
    }
  })

  it('后挂上去的路由（/api/mcp 就是这么挂的）同样在门后', async () => {
    // serve.ts 在 createHttpApp 之后才 mountMcp。Hono 的中间件对**之后注册**的路由生效，
    // 这条钉住那个顺序——`/api/mcp` 能开任意网址 + 在登录态里执行任意 JS，它绝不能是敞开的。
    const app = build()
    app.post('/api/mcp', (c) => c.json({ reached: true }))
    const lan = await req(app, '/api/mcp', { address: '10.0.0.21', host: '10.0.0.21:8900', method: 'POST' })
    expect(lan.status).toBe(401)
    const web = await req(app, '/api/mcp', { address: '127.0.0.1', origin: 'https://evil.com', method: 'POST' })
    expect(web.status).toBe(403)
    expect((await req(app, '/api/mcp', { address: '127.0.0.1', method: 'POST' })).status).toBe(200)
  })

  it('根级 /v1/*（OpenAI 形状的生图口）和 /api/* 过同一道门', async () => {
    // `/v1/images/generations` 会驱动用户的 Chrome 去生图；它挂在 /api 之外只是为了合 OpenAI 的
    // Base URL 习惯（客户端拿源当 Base URL、自己拼 `/v1/…`），门的松紧不能因此不同。
    const app = build()
    app.post('/v1/images/generations', (c) => c.json({ reached: true }))
    const lan = await req(app, '/v1/images/generations', { address: '10.0.0.21', host: '10.0.0.21:8900', method: 'POST' })
    expect(lan.status).toBe(401)
    const web = await req(app, '/v1/images/generations', { address: '127.0.0.1', origin: 'https://evil.com', method: 'POST' })
    expect(web.status).toBe(403)
    expect((await req(app, '/v1/images/generations', { address: '127.0.0.1', method: 'POST' })).status).toBe(200)
  })

  it('访问令牌只在本机看得到', async () => {
    const app = build()
    const local = await req(app, '/api/access-token', { address: '127.0.0.1' })
    expect(local.status).toBe(200)
    // 令牌 + 直接能点开的局域网链接（手机上要用的是链接，不是 64 位十六进制手抄）
    const body = (await local.json()) as { token: string; urls: string[] }
    expect(body.token).toBe(TOKEN)
    expect(Array.isArray(body.urls)).toBe(true)
    for (const u of body.urls) expect(u).toContain(`token=${TOKEN}`)
    // 已经持 token 的外来请求也不给：它已经有了，再吐一遍只是多一个泄漏面。
    const remote = await req(app, '/api/access-token', {
      address: '10.0.0.21',
      host: '10.0.0.21:8900',
      bearer: TOKEN,
    })
    expect(remote.status).toBe(403)
  })

  it('不注入 accessGuard 就没有门（进程内测试的默认形态）', async () => {
    expect((await req(build(null), '/api/__probe')).status).toBe(200)
  })
})

describe('Hono 中间件顺序的前提', () => {
  it('use() 只对之后注册的路由生效——门的正确性依赖这条', async () => {
    const app = new Hono()
    app.get('/before', (c) => c.text('before'))
    app.use('/*', async (c) => c.text('blocked', 401))
    app.get('/after', (c) => c.text('after'))
    expect((await app.request('/before')).status).toBe(200)
    expect((await app.request('/after')).status).toBe(401)
  })
})
