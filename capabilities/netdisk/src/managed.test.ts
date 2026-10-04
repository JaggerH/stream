// capabilities/netdisk/src/managed.test.ts
//
// managed 档（spec §5.2 / §8 阶段 5）+ 归属让位（§8 阶段 6）：插件自己拉 OpenList 容器、接管 admin、
// 换永久 token、挂载、空闲回收。docker 与网络全部经注入，不碰真 daemon。
import { describe, it, expect } from 'vitest'
import type { DockerClient, DockerContainer, ContainerSpec } from '../../../shared/docker/engine-api.ts'
import { createManagedOpenList, MANAGED_SERVICE, type ManagedCreds, type ManagedDeps } from './managed.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface DockerHarnessOpts {
  /** `listByService('alist')` 的答案——非空 = Stream 在本机管着 OpenList。 */
  streamContainers?: DockerContainer[]
  /** 我们自己那个容器的现状；undefined = 还没建。 */
  own?: { id: string; running: boolean }
  hostPort?: number | null
  unreachable?: boolean
}

function fakeDocker(o: DockerHarnessOpts = {}) {
  const calls: string[] = []
  const created: ContainerSpec[] = []
  let own = o.own
  const docker: DockerClient = {
    async ping() { calls.push('ping'); return !o.unreachable },
    async listByService(service) {
      calls.push(`list:${service}`)
      if (service === 'alist') return o.streamContainers ?? []
      if (service === MANAGED_SERVICE && own) return [{ Id: own.id, State: own.running ? 'running' : 'exited', Names: [`/stream-${MANAGED_SERVICE}`] }]
      return []
    },
    async start(id) { calls.push(`start:${id}`); if (own) own.running = true },
    async stop(id) { calls.push(`stop:${id}`); if (own) own.running = false },
    async inspectHostPort(id, port) { calls.push(`port:${id}:${port}`); return o.hostPort === undefined ? 45678 : o.hostPort },
    async pullImage(image) { calls.push(`pull:${image}`) },
    async createContainer(spec) { calls.push(`create:${spec.service}`); created.push(spec); own = { id: 'own-1', running: false }; return 'own-1' },
    async removeContainer(id) { calls.push(`remove:${id}`) },
    async ensureNetwork(name) { calls.push(`network:${name}`) },
    async inspectState() { return own ? { running: own.running, image: 'openlistteam/openlist:latest' } : null },
    async logs() { return [] },
    async exec(id, cmd) { calls.push(`exec:${id}:${cmd.join(' ')}`); return { exitCode: 0, output: 'ok' } },
  }
  return { docker, calls, created, get own() { return own } }
}

/** 假 OpenList：/ping、login、setting/get、storage list/create。 */
function fakeOpenList(o: { pingOk?: boolean; storages?: unknown[] } = {}) {
  const urls: string[] = []
  const bodies: unknown[] = []
  const fetchFn = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u)
    urls.push(url)
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    if (url.endsWith('/ping')) return o.pingOk === false ? new Response('', { status: 502 }) : new Response('pong')
    if (url.includes('/api/auth/login')) return json({ code: 200, data: { token: 'jwt-1' } })
    if (url.includes('/api/admin/setting/get')) return json({ code: 200, data: { key: 'token', value: 'alist-perm-1' } })
    if (url.includes('/api/admin/storage/list')) return json({ code: 200, data: { content: o.storages ?? [] } })
    if (url.includes('/api/admin/storage/create')) return json({ code: 200, data: null })
    return json({ code: 404, message: 'unrouted' }, 404)
  }) as unknown as typeof fetch
  return { fetchFn, urls, bodies }
}

function depsWith(over: Partial<ManagedDeps> & { docker: DockerClient | null; fetchFn: typeof fetch }): ManagedDeps & { stored: () => ManagedCreds | undefined; logs: string[] } {
  let stored: ManagedCreds | undefined = (over as { initialCreds?: ManagedCreds }).initialCreds
  const logs: string[] = []
  let t = 0
  return {
    store: { read: () => stored, write: (c) => { stored = c } },
    genPassword: () => 'generated-pw',
    sleep: async () => { t += 1000 },
    now: () => t,
    log: (l) => logs.push(l),
    ...over,
    stored: () => stored,
    logs,
  }
}

const CFG = { idleMinutes: 240, mounts: ['quark'] as string[] }

describe('createManagedOpenList —— 归属让位（阶段 6）', () => {
  it('本机已有 service=alist 的容器（Stream 在管）→ 让位：不拉、不建、不碰，理由点名那个容器', async () => {
    const d = fakeDocker({ streamContainers: [{ Id: 'abc', State: 'running', Names: ['/stream-alist-1'] }] })
    const net = fakeOpenList()
    const m = createManagedOpenList(CFG, depsWith({ docker: d.docker, fetchFn: net.fetchFn }))
    const r = await m.ensure()
    expect(r.ok).toBe(false)
    expect((r as { deferred?: boolean }).deferred).toBe(true)
    expect((r as { reason: string }).reason).toContain('stream-alist-1')
    expect(d.calls.filter((c) => /pull|create|start|exec/.test(c))).toEqual([])
    expect(net.urls).toEqual([])
  })

  it('ignoreOwner（只给冒烟用）→ 不让位，照常建自己的容器（标签 / 卷都与 Stream 的分开）', async () => {
    const d = fakeDocker({ streamContainers: [{ Id: 'abc', State: 'running', Names: ['/stream-alist-1'] }] })
    const m = createManagedOpenList({ ...CFG, ignoreOwner: true }, depsWith({ docker: d.docker, fetchFn: fakeOpenList().fetchFn }))
    const r = await m.ensure()
    expect(r.ok).toBe(true)
    expect(d.calls).toContain(`create:${MANAGED_SERVICE}`)
  })

  it('docker 够不着 → ok:false 说清是 docker，不抛', async () => {
    const d = fakeDocker({ unreachable: true })
    const m = createManagedOpenList(CFG, depsWith({ docker: d.docker, fetchFn: fakeOpenList().fetchFn }))
    const r = await m.ensure()
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/docker/i)
  })

  it('没有 docker 端点（DOCKER_HOST 解析不了）→ 同样是一条说人话的失败', async () => {
    const m = createManagedOpenList(CFG, depsWith({ docker: null, fetchFn: fakeOpenList().fetchFn }))
    await expect(m.ensure()).resolves.toMatchObject({ ok: false })
  })
})

describe('createManagedOpenList —— 自拉容器 + 接管（阶段 5）', () => {
  it('全新：建网络 → 拉镜像 → 建容器（命名卷、loopback 随机口、MCP_ENABLE）→ 起 → 等 /ping → admin set → login → 换永久 token → 落盘', async () => {
    const d = fakeDocker()
    const net = fakeOpenList()
    const deps = depsWith({ docker: d.docker, fetchFn: net.fetchFn })
    const m = createManagedOpenList(CFG, deps)
    const r = await m.ensure()
    expect(r.ok).toBe(true)
    expect((r as { baseUrl: string }).baseUrl).toBe('http://127.0.0.1:45678')
    expect(d.calls.filter((c) => !c.startsWith('list:') && c !== 'ping')).toEqual([
      'network:stream-netdisk',
      'pull:openlistteam/openlist:latest',
      `create:${MANAGED_SERVICE}`,
      'start:own-1',
      'port:own-1:5244',
      'exec:own-1:./openlist admin set generated-pw',
    ])
    expect(d.created[0]).toMatchObject({
      image: 'openlistteam/openlist:latest',
      service: MANAGED_SERVICE,
      port: 5244,
      env: { MCP_ENABLE: 'true' },
      volumes: [`${MANAGED_SERVICE}-data:/opt/openlist/data`],
      publishLoopback: true,
      network: 'stream-netdisk',
      // Engine API 新建的命名卷是 root 属主，而镜像以 UID 1001 跑、入口只查权限不 chown（活体撞到：
      // 容器秒退「does not have write permissions for ./data」）。以 root 起是唯一不需要第二个容器的解法。
      user: '0:0',
    })
    expect(net.urls.some((u) => u === 'http://127.0.0.1:45678/ping')).toBe(true)
    expect(deps.stored()).toEqual({ password: 'generated-pw', token: 'alist-perm-1' })
  })

  it('存的是永久 token（不是 JWT）：再次 ensure 不再 exec / login', async () => {
    const d = fakeDocker({ own: { id: 'own-1', running: true } })
    const net = fakeOpenList()
    const m = createManagedOpenList(CFG, depsWith({ docker: d.docker, fetchFn: net.fetchFn, initialCreds: { password: 'pw', token: 'alist-perm-old' } } as never))
    const r = await m.ensure()
    expect(r.ok).toBe(true)
    expect(d.calls.some((c) => c.startsWith('exec'))).toBe(false)
    expect(net.urls.some((u) => u.includes('/api/auth/login'))).toBe(false)
    expect((r as { client: { rawUrl: unknown } }).client).toBeTruthy()
  })

  it('容器在但停着 → 只 start，不拉不建', async () => {
    const d = fakeDocker({ own: { id: 'own-1', running: false } })
    const m = createManagedOpenList(CFG, depsWith({ docker: d.docker, fetchFn: fakeOpenList().fetchFn, initialCreds: { password: 'pw', token: 'alist-perm-old' } } as never))
    await m.ensure()
    expect(d.calls.some((c) => c.startsWith('pull') || c.startsWith('create'))).toBe(false)
    expect(d.calls).toContain('start:own-1')
  })

  it('容器起了但没发布口（秒退）→ ok:false，理由里带容器日志尾巴（不然只能去 docker logs 猜）', async () => {
    const d = fakeDocker({ hostPort: null })
    d.docker.logs = async () => ['Error: Current user does not have write permissions for ./data']
    const m = createManagedOpenList(CFG, depsWith({ docker: d.docker, fetchFn: fakeOpenList().fetchFn }))
    const r = await m.ensure()
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('write permissions')
  })

  it('等不到 /ping → ok:false 说清，不挂死', async () => {
    const d = fakeDocker()
    const m = createManagedOpenList({ ...CFG, pingTimeoutMs: 5000 }, depsWith({ docker: d.docker, fetchFn: fakeOpenList({ pingOk: false }).fetchFn }))
    const r = await m.ensure()
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('/ping')
  })

  it('admin set 非零退出 → ok:false 带输出', async () => {
    const d = fakeDocker()
    d.docker.exec = async () => ({ exitCode: 1, output: 'permission denied' })
    const m = createManagedOpenList(CFG, depsWith({ docker: d.docker, fetchFn: fakeOpenList().fetchFn }))
    const r = await m.ensure()
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('permission denied')
  })
})

describe('createManagedOpenList —— 挂载与空闲回收', () => {
  it('浏览器插件交出 pan.quark.cn 的 cookie → 建一个 Quark storage（cookie 灌进 addition）', async () => {
    const d = fakeDocker()
    const net = fakeOpenList()
    const deps = depsWith({
      docker: d.docker,
      fetchFn: net.fetchFn,
      cookiesFor: async (domain) => (domain === 'pan.quark.cn' ? [{ name: '__pus', value: 'a', domain: '.quark.cn' }] : []),
    })
    const m = createManagedOpenList(CFG, deps)
    await m.ensure()
    const create = net.bodies.find((b) => (b as { driver?: string }).driver === 'Quark') as { mount_path: string; addition: string }
    expect(create.mount_path).toBe('/quark')
    expect(JSON.parse(create.addition)).toMatchObject({ cookie: '__pus=a' })
  })

  it('没有 cookie 来源 → 不建 storage，记一行 missingCookie', async () => {
    const d = fakeDocker()
    const net = fakeOpenList()
    const deps = depsWith({ docker: d.docker, fetchFn: net.fetchFn })
    await createManagedOpenList(CFG, deps).ensure()
    expect(net.bodies.some((b) => (b as { driver?: string }).driver === 'Quark')).toBe(false)
    expect(deps.logs.join()).toMatch(/quark/)
  })

  it('空闲超过 idleMinutes → 停容器；下一次 ensure 再起来', async () => {
    const d = fakeDocker({ own: { id: 'own-1', running: true } })
    let t = 0
    const deps = depsWith({ docker: d.docker, fetchFn: fakeOpenList().fetchFn, now: () => t, initialCreds: { password: 'pw', token: 'alist-perm' } } as never)
    const m = createManagedOpenList({ ...CFG, idleMinutes: 10 }, deps)
    await m.ensure()
    t = 5 * 60_000
    expect(await m.reapIfIdle()).toBe(false)
    t = 11 * 60_000
    expect(await m.reapIfIdle()).toBe(true)
    expect(d.calls).toContain('stop:own-1')
    expect(d.own?.running).toBe(false)
    await m.ensure()
    expect(d.calls.filter((c) => c === 'start:own-1')).toHaveLength(1)
  })
})
