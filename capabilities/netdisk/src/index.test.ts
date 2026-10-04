// capabilities/netdisk/src/index.test.ts
//
// 能力体只做三件事：判档（external / managed / invalid）、借登录态（`ctx.require` 现取浏览器包的
// 服务）、挂四个动词。每一种「起不来」都只记日志、不抛（红线：跑在宿主自己的进程里）。
// 宿主那一面全部经 `fakeCapabilityContext`——不经 MCP / DSH 任何一份翻译。
import { describe, it, expect } from 'vitest'
import { fakeCapabilityContext, type FakeCapabilityContext } from '../../../shared/capability/test-ctx.ts'
import { BROWSER_COOKIE_SERVICE, mount, type ApplyDeps, type ManagedStore } from './index.ts'
import { MANAGED_SERVICE, type ManagedCreds } from './managed.ts'
import type { DockerClient, DockerContainer } from '../../../shared/docker/engine-api.ts'

// 占位值：形状对（`alist-<uuid><随机串>`）但**不是任何真实凭证**。别换成真 token——这个文件要公开。
const PERMANENT = 'alist-00000000-0000-0000-0000-000000000000fakefakefake'
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.abcDEF123'

type CookieSvc = { cookieFor(d: string): Promise<string | undefined>; cookiesFor(d: string): Promise<Array<{ name: string; value: string; domain: string }>> }

interface Harness {
  ctx: FakeCapabilityContext
  warns: string[]
  infos: string[]
  tool(name: string): { execute(a: Record<string, unknown>): Promise<unknown> }
  toolNames(): string[]
}

/** `services.set(BROWSER_COOKIE_SERVICE, …)` 就是「浏览器包在场」——没 set 就是它不在，
 *  `ctx.require` 回 undefined，要登录态的动词回「没有浏览器插件」而不是挂着等。 */
function ctxHarness(opts: { cookieService?: CookieSvc | null } = {}): Harness {
  const ctx = fakeCapabilityContext()
  if (opts.cookieService) ctx.services.set(BROWSER_COOKIE_SERVICE, opts.cookieService)
  return {
    ctx,
    warns: ctx.logs.warn,
    infos: ctx.logs.info,
    toolNames: () => ctx.tools.map((t) => t.name),
    tool(name) {
      const hit = ctx.tools.find((t) => t.name === name)
      if (!hit) throw new Error(`no tool ${name}`)
      return hit
    },
  }
}

function memoryStore(initial?: ManagedCreds): ManagedStore {
  let stored = initial
  return { read: () => stored, write: (c) => { stored = c } }
}

/** 最小的假 docker（形状同 managed.test.ts 那份，这里只要「让位」与「自己的容器在跑」两种现状）。 */
function fakeDocker(o: { streamContainers?: DockerContainer[]; own?: { id: string; running: boolean }; hostPort?: number } = {}) {
  const calls: string[] = []
  const docker: DockerClient = {
    async ping() { return true },
    async listByService(service) {
      calls.push(`list:${service}`)
      if (service === 'alist') return o.streamContainers ?? []
      if (service === MANAGED_SERVICE && o.own) return [{ Id: o.own.id, State: o.own.running ? 'running' : 'exited', Names: [`/stream-${MANAGED_SERVICE}`] }]
      return []
    },
    async start(id) { calls.push(`start:${id}`) },
    async stop(id) { calls.push(`stop:${id}`) },
    async inspectHostPort() { return o.hostPort ?? 45678 },
    async pullImage(i) { calls.push(`pull:${i}`) },
    async createContainer() { calls.push('create'); return 'new' },
    async removeContainer() {},
    async ensureNetwork() {},
    async inspectState() { return null },
    async logs() { return [] },
    async exec() { return { exitCode: 0, output: '' } },
  }
  return { docker, calls }
}

function deps(over: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    fetchFn: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    docker: () => null,
    managedStore: memoryStore(),
    ...over,
  }
}

describe('mount', () => {
  it('external 档：四个动词挂上，日志说清指向哪个 OpenList，没有 warn', async () => {
    const c = ctxHarness()
    await mount(c.ctx, { openlistUrl: 'http://127.0.0.1:8900/_p/alist', openlistToken: PERMANENT }, deps())
    expect(c.toolNames().sort()).toEqual(['netdisk_folder_url', 'netdisk_play_link', 'netdisk_save_share', 'netdisk_verify_share'])
    expect(c.infos.join()).toContain('http://127.0.0.1:8900/_p/alist')
    expect(c.warns).toEqual([])
  })

  it('【spec §5.3】token 是 JWT → warn 说清要永久 token；动词照挂，取直链那个回「没有 OpenList」', async () => {
    const c = ctxHarness()
    await mount(c.ctx, { openlistUrl: 'http://o', openlistToken: JWT }, deps())
    expect(c.warns.join()).toMatch(/JWT/)
    const r = (await c.tool('netdisk_play_link').execute({ path: '/x' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/OpenList/)
  })

  it('没给 openlistUrl → managed 档：装载期只探一眼（不拉镜像），日志说清 docker/归属现状，四个动词照挂', async () => {
    const c = ctxHarness()
    const d = fakeDocker({ streamContainers: [{ Id: 'x', State: 'running', Names: ['/stream-alist-1'] }] })
    await mount(c.ctx, {}, deps({ docker: () => d.docker }))
    expect(c.infos.join()).toMatch(/managed/)
    expect(c.infos.join()).toContain('stream-alist-1')
    expect(c.toolNames()).toContain('netdisk_play_link')
    expect(d.calls.some((x) => /pull|create|start/.test(x))).toBe(false)
  })

  it('managed 档 + Stream 在本机管着 OpenList → 取直链让位：失败说清归谁、指路 external 档', async () => {
    const c = ctxHarness()
    const d = fakeDocker({ streamContainers: [{ Id: 'x', State: 'running', Names: ['/stream-alist-1'] }] })
    await mount(c.ctx, {}, deps({ docker: () => d.docker }))
    const r = (await c.tool('netdisk_play_link').execute({ path: '/quark/x' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('stream-alist-1')
    expect(String(r.error)).toContain('external')
  })

  it('managed 档 + 自己的容器在跑 + 存了永久 token → 取直链走 127.0.0.1:<随机口>', async () => {
    const c = ctxHarness()
    const d = fakeDocker({ own: { id: 'own-1', running: true }, hostPort: 45678 })
    const urls: string[] = []
    const fetchFn = (async (u: string | URL) => {
      const url = String(u)
      urls.push(url)
      if (url.endsWith('/ping')) return new Response('pong')
      if (url.includes('/api/fs/get')) return new Response(JSON.stringify({ code: 200, data: { raw_url: 'http://cdn/x' } }))
      if (url.includes('/api/admin/storage/list')) return new Response(JSON.stringify({ code: 200, data: { content: [] } }))
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    await mount(c.ctx, {}, deps({ docker: () => d.docker, fetchFn, managedStore: memoryStore({ password: 'pw', token: 'alist-perm' }) }))
    const r = await c.tool('netdisk_play_link').execute({ path: '/quark/x' })
    expect(r).toEqual({ rawUrl: 'http://cdn/x' })
    expect(urls).toContain('http://127.0.0.1:45678/ping')
    expect(urls).toContain('http://127.0.0.1:45678/api/fs/get')
  })

  it('浏览器包在场 → 转存拿到的就是它交出的 cookie', async () => {
    const seen: string[] = []
    const c = ctxHarness({ cookieService: { cookieFor: async (d) => { seen.push(d); return '__pus=a' }, cookiesFor: async () => [] } })
    const fetchFn = (async (u: string | URL, init?: RequestInit) => {
      // token 一步就够证明 cookie 到了；答一个死链让流程就此停住。
      if (String(u).includes('/sharepage/token')) {
        return new Response(JSON.stringify({ code: 41006, message: `cookie=${(init?.headers as Record<string, string>).cookie}` }), { status: 404 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    await mount(c.ctx, { openlistUrl: 'http://o', openlistToken: PERMANENT }, deps({ fetchFn }))
    const r = (await c.tool('netdisk_save_share').execute({ pwd_id: 'p', dest: 'd' })) as Record<string, unknown>
    expect(seen).toEqual(['quark.cn'])
    expect(String(r.message)).toBe('cookie=__pus=a')
  })

  it('浏览器包不在场（require 回 undefined）→ 转存回失败 + 指路，不是挂着等', async () => {
    const c = ctxHarness({ cookieService: null })
    await mount(c.ctx, { openlistUrl: 'http://o', openlistToken: PERMANENT }, deps())
    const r = (await c.tool('netdisk_save_share').execute({ pwd_id: 'p', dest: 'd' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String(r.hint)).toContain('Stream Desktop')
  })

  it('登录态**调用时现取**：mount 之后才到位的浏览器包，转存照样借得到', async () => {
    const c = ctxHarness()
    const fetchFn = (async (u: string | URL, init?: RequestInit) => {
      if (String(u).includes('/sharepage/token')) {
        return new Response(JSON.stringify({ code: 41006, message: `cookie=${(init?.headers as Record<string, string>).cookie}` }), { status: 404 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    await mount(c.ctx, { openlistUrl: 'http://o', openlistToken: PERMANENT }, deps({ fetchFn }))
    // mount 时它还不在——装配期取快照的写法在这里就会永远回「没有浏览器插件」。
    c.ctx.services.set(BROWSER_COOKIE_SERVICE, { cookieFor: async () => '__pus=late', cookiesFor: async () => [] })
    const r = (await c.tool('netdisk_save_share').execute({ pwd_id: 'p', dest: 'd' })) as Record<string, unknown>
    expect(String(r.message)).toBe('cookie=__pus=late')
  })

  it('浏览器包中途被收掉 → 下一次调用就回「没有浏览器插件」，不是拿着失效的快照打', async () => {
    const c = ctxHarness({ cookieService: { cookieFor: async () => '__pus=a', cookiesFor: async () => [] } })
    await mount(c.ctx, { openlistUrl: 'http://o', openlistToken: PERMANENT }, deps())
    c.ctx.services.delete(BROWSER_COOKIE_SERVICE)
    const r = (await c.tool('netdisk_save_share').execute({ pwd_id: 'p', dest: 'd' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String(r.hint)).toContain('Stream Desktop')
  })

  it('ctx.onDispose 在任何 await 之前就挂好（dispose 落在 await 期间也够得到）', () => {
    const c = ctxHarness()
    void mount(c.ctx, {}, deps())
    expect(c.ctx.disposers).toHaveLength(1)
  })

  it('dispose：managed 档的空闲回收定时器被停掉', async () => {
    const c = ctxHarness()
    let stopped = 0
    const d = fakeDocker()
    await mount(c.ctx, {}, deps({ docker: () => d.docker, setInterval: () => () => { stopped++ } }))
    await c.ctx.dispose()
    expect(stopped).toBe(1)
  })
})
