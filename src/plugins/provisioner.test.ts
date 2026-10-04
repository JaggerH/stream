import { describe, it, expect } from 'vitest'
import { specFor, provisionBackend } from './provisioner.ts'
import { makeDockerClient } from './standby/docker-api.ts'
import type { DockerClient, DockerContainer, ContainerSpec, RawRequest } from './standby/docker-api.ts'
import type { PluginDescriptor } from './types.ts'

/** 记录调用序列的假 DockerClient。**这个文件绝不碰真 daemon** —— 活体上跑着用户在用的容器。 */
interface FakeOpts {
  ping?: boolean
  containers?: DockerContainer[]
  /** id → inspectState 的答复(null = 容器不在) */
  states?: Record<string, { running: boolean; image: string } | null>
  hostPort?: number | null
  /** 让某个方法抛错 */
  throwOn?: { method: string; error: Error }
  /** createContainer 之后 inspectState 该回什么(新容器) */
  createdId?: string
  /** logs() 的答复 */
  logs?: string[]
}

function fakeDocker(o: FakeOpts = {}) {
  const calls: string[] = []
  const created: ContainerSpec[] = []
  const states: Record<string, { running: boolean; image: string } | null> = { ...(o.states ?? {}) }
  const newId = o.createdId ?? 'new-id'
  const boom = (m: string) => {
    if (o.throwOn?.method === m) throw o.throwOn.error
  }
  const client: DockerClient = {
    async ping() { calls.push('ping'); boom('ping'); return o.ping !== false },
    async listByService(service) { calls.push(`listByService:${service}`); boom('listByService'); return o.containers ?? [] },
    async start(id) { calls.push(`start:${id}`); boom('start'); const s = states[id]; if (s) s.running = true },
    async stop(id) { calls.push(`stop:${id}`); boom('stop') },
    async inspectHostPort(id, port) { calls.push(`inspectHostPort:${id}:${port}`); boom('inspectHostPort'); return o.hostPort === undefined ? 41234 : o.hostPort },
    async pullImage(image) { calls.push(`pullImage:${image}`); boom('pullImage') },
    async createContainer(spec) {
      calls.push(`createContainer:${spec.service}:${spec.image}`)
      boom('createContainer')
      created.push(spec)
      states[newId] = { running: false, image: spec.image }
      return newId
    },
    async removeContainer(id) { calls.push(`removeContainer:${id}`); boom('removeContainer'); delete states[id] },
    async ensureNetwork(name) { calls.push(`ensureNetwork:${name}`); boom('ensureNetwork') },
    async inspectState(id) { calls.push(`inspectState:${id}`); boom('inspectState'); return states[id] ?? null },
    async logs(id) { calls.push(`logs:${id}`); boom('logs'); return o.logs ?? [] },
    async exec(id) { calls.push(`exec:${id}`); boom('exec'); return { exitCode: 0, output: '' } },
  }
  return { client, calls, created, states }
}

const WRITES = ['start:', 'stop:', 'pullImage:', 'createContainer:', 'removeContainer:', 'ensureNetwork:']
const writesIn = (calls: string[]) => calls.filter((c) => WRITES.some((w) => c.startsWith(w)))

const plugin = (over: Partial<PluginDescriptor> = {}, backend: Partial<PluginDescriptor['backend']> = {}): PluginDescriptor => ({
  id: 'pansou',
  backend: { image: 'fjy/pansou:v1', port: 8888, ...backend } as PluginDescriptor['backend'],
  ...over,
})

const running = (id: string): DockerContainer => ({ Id: id, State: 'running', Names: [`/stream-pansou`] })
const exited = (id: string): DockerContainer => ({ Id: id, State: 'exited', Names: [`/stream-pansou`] })

const opts = { network: 'stream', publishLoopback: false, pollMs: 0 }

describe('specFor', () => {
  it('service 缺省取 plugin id（与 compose 生成器一致）', () => {
    expect(specFor(plugin(), 'stream', false).service).toBe('pansou')
    expect(specFor(plugin({}, { service: 'alist' }), 'stream', false).service).toBe('alist')
  })

  it('env / volumes / mem 原样带过，gpu 声明时带上', () => {
    const spec = specFor(
      plugin({}, { env: { A: '1', B: '中文' }, volumes: ['pansou-cache:/cache'], mem: '8G', gpu: true }),
      'stream',
      true,
    )
    expect(spec).toEqual({
      image: 'fjy/pansou:v1',
      service: 'pansou',
      port: 8888,
      env: { A: '1', B: '中文' },
      volumes: ['pansou-cache:/cache'],
      mem: '8G',
      gpu: true,
      publishLoopback: true,
      network: 'stream',
    })
  })

  it('user 声明时透传到 ContainerSpec（alist 靠它以 root 起，绕开 root 属主的新命名卷），没声明就不带这一格', () => {
    expect(specFor(plugin({}, { user: '0:0' }), 'stream', true).user).toBe('0:0')
    expect('user' in specFor(plugin({}, {}), 'stream', true)).toBe(false)
  })

  it('没有 backend 的包不该走到这里 —— 抛错而不是造一个空规格', () => {
    expect(() => specFor({ id: 'xhs' }, 'stream', false)).toThrow(/backend/)
  })
})

/**
 * 建出来的容器 env 里**不许有凭证**。宿主是唯一调度方——容器不自己去要 cookie，凭证由
 * adapter 随请求递下去（撤销缘由见 `src/http/app.ts` 里 credential broker 那段）。
 *
 * 留这一条是因为回归会很安静：往 env 里多注一个变量，没有任何既有断言会红。
 */
describe('specFor 不注入凭证', () => {
  it('申报了 credentials 的包，env 也原样透出，一个凭证都不加', () => {
    const spec = specFor(plugin({ credentials: ['pansou.example'] }, { env: { A: '1' } }), 'stream', false)
    expect(spec.env).toEqual({ A: '1' })
  })

  it('建容器时也不加（compose 与运行时接管两条路产出同一份 env）', async () => {
    const f = fakeDocker({ containers: [] })
    const r = await provisionBackend(f.client, plugin({ credentials: ['pansou.example'] }, { env: { A: '1' } }), {
      network: 'stream', publishLoopback: false, pollMs: 0, probeHealth: async () => true,
    })
    expect(r.action).toBe('created')
    expect(f.created[0]?.env).toEqual({ A: '1' })
  })
})

describe('provisionBackend 判定顺序', () => {
  it('档 1+2：有且 running、镜像一致 → ran，一次 list、零写操作', async () => {
    const f = fakeDocker({ containers: [running('c1')], states: { c1: { running: true, image: 'fjy/pansou:v1' } } })
    const r = await provisionBackend(f.client, plugin(), opts)
    expect(r).toEqual({ service: 'pansou', action: 'ran', containerId: 'c1' })
    expect(writesIn(f.calls)).toEqual([])
    expect(f.calls.filter((c) => c.startsWith('listByService')).length).toBe(1)
  })

  it('档 3：有但停着、镜像一致 → start → started', async () => {
    const f = fakeDocker({ containers: [exited('c1')], states: { c1: { running: false, image: 'fjy/pansou:v1' } } })
    const r = await provisionBackend(f.client, plugin(), opts)
    expect(r.action).toBe('started')
    expect(r.containerId).toBe('c1')
    expect(r.error).toBeUndefined()
    expect(writesIn(f.calls)).toEqual(['start:c1'])
  })

  it('档 3b：有但停着、镜像一致、**归 standby 管** → asleep，零写操作', async () => {
    const f = fakeDocker({ containers: [exited('c1')], states: { c1: { running: false, image: 'fjy/pansou:v1' } } })
    const r = await provisionBackend(f.client, plugin({}, { standby: { idleMinutes: 30 } }), opts)
    // 停着不是故障，是 standby 刚做出的正确决定（闲置回收）。备齐把它起来 = 两个主人抢同一件事，
    // 而后端每次重启都会重来一遍——standby 省内存那件事就此作废。
    expect(r).toEqual({ service: 'pansou', action: 'asleep', containerId: 'c1' })
    expect(writesIn(f.calls)).toEqual([])
  })

  it('档 3b：asleep 不去等健康 —— 容器压根没转，等下去只会烧满整个 timeout', async () => {
    const f = fakeDocker({ containers: [exited('c1')], states: { c1: { running: false, image: 'fjy/pansou:v1' } } })
    let probed = 0
    const r = await provisionBackend(f.client, plugin({}, { standby: { idleMinutes: 30 }, health: '/healthz' }), {
      ...opts,
      healthTimeoutMs: 60_000,
      probeHealth: async () => { probed++; return false },
      now: () => 0, // 时钟不走：真去等的话这个用例会挂死，而不是失败
    })
    expect(r.action).toBe('asleep')
    expect(probed).toBe(0)
  })

  it('档 4a：镜像与声明不一致，不传开关 → image-mismatch，零写操作', async () => {
    const f = fakeDocker({ containers: [running('old')], states: { old: { running: true, image: 'fjy/pansou:v0' } } })
    const r = await provisionBackend(f.client, plugin(), opts)
    // 「动不动用户的容器」是调用方的立场，这一层不替它拍（接线层传 true，见档 4b）。
    expect(r).toEqual({ service: 'pansou', action: 'image-mismatch', containerId: 'old' })
    expect(writesIn(f.calls)).toEqual([])
  })

  it('档 4b：显式 recreateOnImageMismatch → remove + 重建 → recreated', async () => {
    const f = fakeDocker({ containers: [running('old')], states: { old: { running: true, image: 'fjy/pansou:v0' } } })
    const r = await provisionBackend(f.client, plugin(), { ...opts, recreateOnImageMismatch: true })
    expect(r.action).toBe('recreated')
    expect(r.containerId).toBe('new-id')
    expect(writesIn(f.calls)).toEqual([
      'removeContainer:old',
      'ensureNetwork:stream',
      'pullImage:fjy/pansou:v1',
      'createContainer:pansou:fjy/pansou:v1',
      'start:new-id',
    ])
  })

  it('档 5：没有容器 → ensureNetwork + pull + create + start → created', async () => {
    const f = fakeDocker({ containers: [] })
    const r = await provisionBackend(f.client, plugin(), opts)
    expect(r.action).toBe('created')
    expect(r.containerId).toBe('new-id')
    expect(writesIn(f.calls)).toEqual([
      'ensureNetwork:stream',
      'pullImage:fjy/pansou:v1',
      'createContainer:pansou:fjy/pansou:v1',
      'start:new-id',
    ])
    expect(f.created[0]).toMatchObject({ service: 'pansou', network: 'stream', port: 8888 })
  })

  it('容器已消失（list 有、inspect 回 null）→ 按"没有"走新建', async () => {
    const f = fakeDocker({ containers: [running('ghost')], states: { ghost: null } })
    const r = await provisionBackend(f.client, plugin(), opts)
    expect(r.action).toBe('created')
  })

  it('多个残留：running 的那个优先', async () => {
    const f = fakeDocker({
      containers: [exited('c-old'), running('c-live')],
      states: { 'c-old': { running: false, image: 'fjy/pansou:v1' }, 'c-live': { running: true, image: 'fjy/pansou:v1' } },
    })
    const r = await provisionBackend(f.client, plugin(), opts)
    expect(r).toMatchObject({ action: 'ran', containerId: 'c-live' })
  })
})

describe('provisionBackend 健康等待', () => {
  it('声明了 health → 轮询那个路径直到 2xx（compose 档打容器 DNS）', async () => {
    const f = fakeDocker({ containers: [] })
    const seen: string[] = []
    let n = 0
    const r = await provisionBackend(f.client, plugin({}, { health: '/healthz' }), {
      ...opts,
      probeHealth: async (url) => { seen.push(url); n += 1; return n >= 3 },
    })
    expect(r.action).toBe('created')
    expect(r.error).toBeUndefined()
    expect(seen).toEqual(['http://pansou:8888/healthz', 'http://pansou:8888/healthz', 'http://pansou:8888/healthz'])
  })

  it('host 档（publishLoopback）→ 探 inspect 出来的 loopback 口', async () => {
    const f = fakeDocker({ containers: [], hostPort: 43210 })
    const seen: string[] = []
    const r = await provisionBackend(f.client, plugin({}, { health: '/ping' }), {
      ...opts,
      publishLoopback: true,
      probeHealth: async (url) => { seen.push(url); return true },
    })
    expect(r.action).toBe('created')
    expect(seen).toEqual(['http://127.0.0.1:43210/ping'])
  })

  // 纵深（终审 Important 1）：安装期钳制已经拒了这类 health，但盘上的 package.json 手改得动。
  // 拼 URL 这一步自己不能被 `@` / `//` 骗走 —— 探活是**宿主后端**每秒发一次的出站请求。
  it.each(['@evil.com/', '//evil.com/', 'healthz'])('畸形 health %j → 探活 URL 的 host 仍是本机', async (health) => {
    const f = fakeDocker({ containers: [], hostPort: 43210 })
    const seen: string[] = []
    await provisionBackend(f.client, plugin({}, { health }), {
      ...opts,
      publishLoopback: true,
      probeHealth: async (url) => { seen.push(url); return true },
    })
    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]!).host).toBe('127.0.0.1:43210')
  })

  it('没声明 health → 只等容器 running，不发任何探活', async () => {
    const f = fakeDocker({ containers: [] })
    let probes = 0
    const r = await provisionBackend(f.client, plugin(), { ...opts, probeHealth: async () => { probes += 1; return true } })
    expect(r.action).toBe('created')
    expect(r.error).toBeUndefined()
    expect(probes).toBe(0)
  })

  it('健康等待超时 → error，且**绝不回滚删容器**（留现场给 docker logs）', async () => {
    const f = fakeDocker({ containers: [] })
    const r = await provisionBackend(f.client, plugin({}, { health: '/healthz' }), {
      ...opts,
      healthTimeoutMs: 5,
      probeHealth: async () => false,
    })
    expect(r.action).toBe('created')
    expect(r.containerId).toBe('new-id')
    expect(r.error?.message).toMatch(/pansou/)
    expect(f.calls.filter((c) => c.startsWith('removeContainer'))).toEqual([])
  })

  it('已在跑的容器不做健康等待（幂等：零探活）', async () => {
    const f = fakeDocker({ containers: [running('c1')], states: { c1: { running: true, image: 'fjy/pansou:v1' } } })
    let probes = 0
    const r = await provisionBackend(f.client, plugin({}, { health: '/healthz' }), {
      ...opts,
      probeHealth: async () => { probes += 1; return true },
    })
    expect(r.action).toBe('ran')
    expect(probes).toBe(0)
  })
})

/**
 * 第三方包（用户数据目录里装的）走的是同一个 provisioner，但多一道**运行时**断言：
 * 内存上限必须在。安装期钳制（src/packages/container-policy.ts）已经强制过这一格，
 * 但盘上的 package.json 是可以手改的——删掉一行就能拿到一个不限内存的容器。
 */
describe('provisionBackend 第三方：运行时再断言一次 mem', () => {
  it('requireMemLimit 且缺 mem → 拒绝创建，连 ping 都不发', async () => {
    const f = fakeDocker({ containers: [] })
    const r = await provisionBackend(f.client, plugin(), { ...opts, requireMemLimit: true })
    expect(r.action).toBe('skipped')
    expect(r.error?.message).toMatch(/mem|内存/)
    expect(f.calls).toEqual([])
  })

  it('requireMemLimit 且 mem 在 → 照常创建，mem 原样进规格', async () => {
    const f = fakeDocker({ containers: [] })
    const r = await provisionBackend(f.client, plugin({}, { mem: '1G' }), { ...opts, requireMemLimit: true })
    expect(r.action).toBe('created')
    expect(r.error).toBeUndefined()
    expect(f.created[0]?.mem).toBe('1G')
  })

  it('内置包（不带这个开关）缺 mem 照常创建 —— 行为一字不变', async () => {
    const f = fakeDocker({ containers: [] })
    const r = await provisionBackend(f.client, plugin(), opts)
    expect(r.action).toBe('created')
    expect(r.error).toBeUndefined()
  })

  it('手改盘上的声明塞进宿主 bind → 真 client 的 createContainer 拒，create 请求一个都没发出', async () => {
    const seen: string[] = []
    const impl: RawRequest = async (_ep, method, path) => {
      seen.push(`${method} ${path}`)
      if (path === '/_ping') return { status: 200, body: 'OK' }
      if (path.startsWith('/containers/json')) return { status: 200, body: '[]' }
      if (path === '/networks/create') return { status: 201, body: '{}' }
      if (path.startsWith('/images/')) return { status: 200, body: '{}' }
      if (path.startsWith('/containers/create')) return { status: 201, body: '{"Id":"should-not-happen"}' }
      return { status: 500, body: `unexpected ${path}` }
    }
    const docker = makeDockerClient({ socketPath: '/nope.sock' }, impl)
    const r = await provisionBackend(
      docker,
      plugin({}, { mem: '1G', volumes: ['/srv/host-data:/data'] }),
      { ...opts, requireMemLimit: true },
    )
    expect(r.error?.message).toMatch(/命名卷|named volume/)
    expect(seen.some((c) => c.includes('/containers/create'))).toBe(false)
  })
})

describe('provisionBackend 不掀翻调用方', () => {
  it('ping false → skipped，一个写操作都没有', async () => {
    const f = fakeDocker({ ping: false, containers: [running('c1')] })
    const r = await provisionBackend(f.client, plugin(), opts)
    expect(r).toEqual({ service: 'pansou', action: 'skipped' })
    expect(writesIn(f.calls)).toEqual([])
    expect(f.calls).toEqual(['ping'])
  })

  it('没有 backend 声明 → skipped，一个 docker 调用都没有', async () => {
    const f = fakeDocker()
    const r = await provisionBackend(f.client, { id: 'xhs' }, opts)
    expect(r).toEqual({ service: 'xhs', action: 'skipped' })
    expect(f.calls).toEqual([])
  })

  for (const method of ['ping', 'listByService', 'ensureNetwork', 'pullImage', 'createContainer', 'start', 'inspectState'] as const) {
    it(`${method} 抛错 → 结果带 error，函数本身不 throw`, async () => {
      const f = fakeDocker({ containers: [], throwOn: { method, error: new Error(`boom ${method}`) } })
      const r = await provisionBackend(f.client, plugin(), opts)
      expect(r.error).toBeInstanceOf(Error)
      expect(r.error?.message).toContain(`boom ${method}`)
      expect(r.service).toBe('pansou')
    })
  }

  it('镜像不一致时 remove 抛错 → error，不继续往下建', async () => {
    const f = fakeDocker({
      containers: [running('old')],
      states: { old: { running: true, image: 'fjy/pansou:v0' } },
      throwOn: { method: 'removeContainer', error: new Error('boom remove') },
    })
    const r = await provisionBackend(f.client, plugin(), { ...opts, recreateOnImageMismatch: true })
    expect(r.error?.message).toBe('boom remove')
    expect(f.calls.filter((c) => c.startsWith('createContainer'))).toEqual([])
  })

  it('探活函数自己抛 → 当作"还没绿"继续轮询，不炸出去', async () => {
    const f = fakeDocker({ containers: [] })
    let n = 0
    const r = await provisionBackend(f.client, plugin({}, { health: '/healthz' }), {
      ...opts,
      probeHealth: async () => { n += 1; if (n < 2) throw new Error('ECONNREFUSED'); return true },
    })
    expect(r.action).toBe('created')
    expect(r.error).toBeUndefined()
  })
})
