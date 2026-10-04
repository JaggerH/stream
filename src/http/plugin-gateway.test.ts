import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mountPluginGateway } from './plugin-gateway.ts'
import { BackendDirectory } from '../kernel/plugins/backend-directory.ts'
import { mountMcp } from './mcp-mount.ts'
import { createHttpApp, type HealthInfo } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { UserStore } from '../store/user-store.ts'
import type { PluginDescriptor } from '../plugins/types.ts'
import { setStandbyManager } from '../plugins/standby/hook.ts'
import type { StandbyManager } from '../plugins/standby/manager.ts'

const descs: PluginDescriptor[] = [
  { id: 'pansou', backend: { image: 'x', service: 'pansou', port: 8888 } } as PluginDescriptor,
]

function appWith(fetchImpl: typeof fetch, mode: 'compose' | 'none' = 'compose') {
  const app = new Hono()
  mountPluginGateway(app, { descriptors: descs, mode, fetchImpl })
  return app
}

describe('mountPluginGateway', () => {
  it('把 /_p/pansou/api/search 反代到 http://pansou:8888/api/search（剥前缀、透传 method/query）', async () => {
    const seen: { url: string; method: string } = { url: '', method: '' }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.url = String(input)
      seen.method = init?.method ?? 'GET'
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    const res = await appWith(fetchImpl).request('/_p/pansou/api/search?q=x', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(seen.url).toBe('http://pansou:8888/api/search?q=x')
    expect(seen.method).toBe('POST')
  })

  it('逐跳头(transfer-encoding/connection 等)不得透传给上游 fetch', async () => {
    // 真实事故(2026-07-23):Caddy 转发大 body 时以 Transfer-Encoding: chunked 分帧,
    // 网关照抄全部头喂 undici → 立即 "fetch failed" 502。RFC 7230:代理转发必须剥逐跳头,
    // 消息分帧由本跳(undici)自己决定。端到端头(content-type/authorization)必须保留。
    let forwarded: Headers | undefined
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = init?.headers as Headers
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    const res = await appWith(fetchImpl).request('/_p/pansou/api/search', {
      method: 'POST',
      headers: {
        'transfer-encoding': 'chunked',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        trailer: 'x-checksum',
        upgrade: 'h2c',
        'proxy-authorization': 'Basic x',
        // curl 对大 body 自动加;Caddy 已替客户端完成 100-continue 握手仍透传,undici 拒收
        // (UND_ERR_NOT_SUPPORTED)——第二只真实事故,必须剥。
        expect: '100-continue',
        'content-type': 'multipart/form-data; boundary=x',
        authorization: 'Bearer keep-me',
      },
      body: 'payload',
    })
    expect(res.status).toBe(200)
    for (const h of ['transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'expect']) {
      expect(forwarded?.get(h), `${h} 必须被剥掉`).toBeNull()
    }
    expect(forwarded?.get('content-type')).toBe('multipart/form-data; boundary=x')
    expect(forwarded?.get('authorization')).toBe('Bearer keep-me')
  })

  it('上游状态 + body 原样回传（含 206 流式）', async () => {
    const fetchImpl = vi.fn(async () => new Response('partial', {
      status: 206,
      headers: { 'content-range': 'bytes 0-6/100' },
    })) as unknown as typeof fetch
    const res = await appWith(fetchImpl).request('/_p/pansou/media')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-6/100')
    expect(await res.text()).toBe('partial')
  })

  it('未知 plugin → 404，且不打上游', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const res = await appWith(fetchImpl).request('/_p/nope/x')
    expect(res.status).toBe(404)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('mode=none → 不注册路由（/_p/* 交给后续处理，返回 404 Not Found by Hono）', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const app = appWith(fetchImpl, 'none')
    const res = await app.request('/_p/pansou/x')
    expect(res.status).toBe(404)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('mode=compose 但无插件能解析出 target → 不注册路由（同 mode=none 的 404）', async () => {
    const noBackendDescs: PluginDescriptor[] = [
      { id: 'imdb' } as PluginDescriptor,
    ]
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const app = new Hono()
    mountPluginGateway(app, { descriptors: noBackendDescs, mode: 'compose', fetchImpl })
    const res = await app.request('/_p/anything/x')
    expect(res.status).toBe(404)
    expect(fetchImpl).not.toHaveBeenCalled()
    // 路由压根没注册（Hono 默认 404 文案），不是路由内部对未知 service 的 json 404
    expect(await res.text()).toBe('404 Not Found')
  })

  describe('standby wake-on-request（注入假 manager）', () => {
    afterEach(() => {
      // 断言若中途抛出也不能让假 manager 漏到别的测试文件里 —— 必须在 afterEach 里回收，
      // 不能写成 try 块末尾的收尾语句。
      setStandbyManager(null)
    })

    it('代理前先唤醒 service；withAwake 实际执行 fn，上游照常收到请求', async () => {
      const woken: string[] = []
      const fake: StandbyManager = {
        ensureAwake: async (s) => { woken.push(s) },
        withAwake: async (s, fn) => { woken.push(s); return fn() },
        adopt: async () => {},
        tick: async () => {},
        shutdown: async () => {},
        snapshot: () => [],
        origin: () => null,
        managed: () => false,
        diagnose: async (s: string) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown' as const, containerId: null, hostPort: null }),
      }
      setStandbyManager(fake)
      const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
      const res = await appWith(fetchImpl).request('/_p/pansou/x')
      expect(woken).toContain('pansou')
      expect(res.status).toBe(200)
      expect(fetchImpl).toHaveBeenCalled()
    })

    it('唤醒失败/超时 → 502，body 带上错误信息，且不打上游', async () => {
      const fake: StandbyManager = {
        ensureAwake: async () => {},
        withAwake: async () => { throw new Error('standby wake timeout for pansou after 120s') },
        adopt: async () => {},
        tick: async () => {},
        shutdown: async () => {},
        snapshot: () => [],
        origin: () => null,
        managed: () => false,
        diagnose: async (s: string) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown' as const, containerId: null, hostPort: null }),
      }
      setStandbyManager(fake)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const res = await appWith(fetchImpl).request('/_p/pansou/x')
      expect(res.status).toBe(502)
      expect(await res.text()).toContain('standby wake timeout')
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  it('请求头透传：自定义 header 送达上游，host 被剥离/覆盖', async () => {
    const seenHeaders: { custom: string | null; host: string | null } = { custom: null, host: null }
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      seenHeaders.custom = h.get('x-custom-header')
      seenHeaders.host = h.get('host')
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    const res = await appWith(fetchImpl).request('/_p/pansou/api/search', {
      method: 'POST',
      headers: { 'x-custom-header': 'hello', host: 'localhost:4555' },
    })
    expect(res.status).toBe(200)
    expect(seenHeaders.custom).toBe('hello')
    expect(seenHeaders.host).not.toBe('localhost:4555')
  })
})

// 集成层：serve.ts 按 mountMcp → mountPluginGateway 同序组装出的真实 app，/api/* 与 /_p/* 必须共存
// （backend-single-entry「Backend owns the plugin gateway」）——这条覆盖的是「挂载函数本身没问题，
// 但 serve.ts 漏接线导致端点静默不存在」这个高危坑（memory「后端加 dep/recipe 的两个接线坑」）。
describe('mountPluginGateway + createHttpApp + mountMcp（serve.ts 组装序）', () => {
  let dir: string
  let dedup: DedupStore
  let itemStore: ItemStore

  const health: () => Promise<HealthInfo> = async () => ({
    cookies: { domains: [], updatedAt: null },
    manifests: 0,
    streams: 0,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plugin-gateway-assembly-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    itemStore = new ItemStore(join(dir, 'items.db'))
  })

  afterEach(() => {
    dedup.close()
    itemStore.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function assembledApp(mode: 'compose' | 'none', fetchImpl: typeof fetch) {
    const scheduler = new Scheduler({
      registry: new Registry([]),
      streams: [],
      adapters: new Map(),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
    const service = new StreamService({
      registry: new Registry([]),
      scheduler,
      channels: new UserStore(join(dir, 'stream.db')),
    })
    const app = createHttpApp({ service, itemStore, health })
    return { app, service }
  }

  it('/api/health 与 /_p/pansou 各自命中：mountMcp 之后接线 mountPluginGateway 不吞 /api/*', async () => {
    const { app, service } = assembledApp('compose', fetch)
    await mountMcp(app, service, { isCommunitySource: () => false })
    const okFetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    mountPluginGateway(app, { descriptors: descs, mode: 'compose', fetchImpl: okFetch })

    const healthRes = await app.request('/api/health')
    expect(healthRes.status).toBe(200)

    const plugin = await app.request('/_p/pansou/x')
    expect(plugin.status).toBe(200)
    expect(okFetch).toHaveBeenCalled()
  })

  it('mode=none（桌面无门）：/api/health 照常，/_p/* 未注册路由', async () => {
    const { app, service } = assembledApp('none', fetch)
    await mountMcp(app, service, { isCommunitySource: () => false })
    const neverFetch = vi.fn() as unknown as typeof fetch
    mountPluginGateway(app, { descriptors: descs, mode: 'none', fetchImpl: neverFetch })

    const healthRes = await app.request('/api/health')
    expect(healthRes.status).toBe(200)

    const plugin = await app.request('/_p/pansou/x')
    expect(plugin.status).toBe(404)
    expect(neverFetch).not.toHaveBeenCalled()
  })
})

describe('mountPluginGateway（host 档）', () => {
  it('host 档挂载网关(有 backend 即挂),取址延迟到 withAwake 回调内', async () => {
    const app = new Hono()
    const descriptors = [{ id: 'mineru', backend: { image: 'x', port: 9000 } }] as unknown as PluginDescriptor[]
    const fetched: string[] = []
    mountPluginGateway(app, {
      descriptors,
      mode: 'host',
      fetchImpl: (async (url: string) => { fetched.push(String(url)); return new Response('ok') }) as typeof fetch,
      resolveHostOrigin: () => 'http://127.0.0.1:44728',
    })
    const res = await app.request('/_p/mineru/health')
    expect(res.status).toBe(200)
    expect(fetched[0]).toBe('http://127.0.0.1:44728/health')
  })
  it('host 档 origin 不可得(standby 未接线)→ 502 而非崩', async () => {
    const app = new Hono()
    const descriptors = [{ id: 'mineru', backend: { image: 'x', port: 9000 } }] as unknown as PluginDescriptor[]
    mountPluginGateway(app, { descriptors, mode: 'host', resolveHostOrigin: () => null })
    const res = await app.request('/_p/mineru/health')
    expect(res.status).toBe(502)
  })
  it('host 档未知 service → 404', async () => {
    const app = new Hono()
    const descriptors = [{ id: 'mineru', backend: { image: 'x', port: 9000 } }] as unknown as PluginDescriptor[]
    mountPluginGateway(app, { descriptors, mode: 'host', resolveHostOrigin: () => null })
    expect((await app.request('/_p/nope/x')).status).toBe(404)
  })

  // 终审 Important 3：serve.ts 原本只喂内置那层描述符，第三方包的容器建起来了却恒 404。
  // 这里锁的是「喂进来就通」这半边；serve.ts 那半边由 `kernel.packages.backendDirectory` 接线。
  it('第三方包的 backend 也在名单里 → /_p/<包 id> 通，不是 404', async () => {
    const app = new Hono()
    const descriptors = new BackendDirectory(
      [{ id: 'mineru', backend: { image: 'x', port: 9000 } }] as unknown as PluginDescriptor[],
      [{ id: 'acme-scraper', backend: { image: 'y', service: 'acme-scraper', port: 7000 } }] as unknown as PluginDescriptor[],
    ).all()
    const fetched: string[] = []
    mountPluginGateway(app, {
      descriptors,
      mode: 'host',
      fetchImpl: (async (url: string) => { fetched.push(String(url)); return new Response('ok') }) as typeof fetch,
      resolveHostOrigin: () => 'http://127.0.0.1:41111',
    })
    const res = await app.request('/_p/acme-scraper/health')
    expect(res.status).toBe(200)
    expect(fetched[0]).toBe('http://127.0.0.1:41111/health')
  })
})
