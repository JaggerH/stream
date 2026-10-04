import { describe, it, expect } from 'vitest'
import { wireStandby, type StandbyWiringDeps } from './wire.ts'
import type { PluginDescriptor } from '../types.ts'
import type { DockerClient } from './docker-api.ts'
import { makeStandbyManager, type StandbyManager } from './manager.ts'
import { BackendDirectory } from '../../kernel/plugins/backend-directory.ts'

/**
 * 这一层守的是 serve.ts 那个 buildStandbyOrDegrade 回调**内部**的接线顺序,而不是降级包装本身
 * (那个在 serve.standby.test.ts)。TODO 记下的那颗雷:把 adopt()/setInterval 挪到回调外面,
 * 「配置错掀翻开机」会悄悄回来,而套件照样全绿——因为整段接线过去是 serve.ts 里的一个匿名闭包,
 * 没有任何测试能拿到它。抽成 wireStandby 之后,下面这些断言才写得出来。
 */

function descriptor(id: string, standby: boolean, service?: string): PluginDescriptor {
  return {
    id,
    name: id,
    description: id,
    ...(standby || service
      ? { backend: { image: 'x', port: 80, health: '/health', ...(service ? { service } : {}), ...(standby ? { standby: { idleMinutes: 10 } } : {}) } }
      : {}),
  } as PluginDescriptor
}

const okDocker = (over: Partial<DockerClient> = {}): DockerClient => ({
  ping: async () => true,
  listByService: async () => [],
  start: async () => {},
  stop: async () => {},
  inspectHostPort: async () => null,
  // 创建类动作不归 standby 接线管;桩成"调了就抛",误调立刻响。
  pullImage: async () => { throw new Error('standby must not pull images') },
  createContainer: async () => { throw new Error('standby must not create containers') },
  removeContainer: async () => { throw new Error('standby must not remove containers') },
  ensureNetwork: async () => { throw new Error('standby must not create networks') },
  inspectState: async () => { throw new Error('standby must not inspect state') },
  logs: async () => { throw new Error('standby must not read logs') },
  exec: async () => { throw new Error('standby must not exec') },
  ...over,
})

function deps(over: Partial<StandbyWiringDeps> = {}): StandbyWiringDeps {
  return {
    descriptors: [descriptor('voiceprint', true)],
    mode: 'compose',
    isEnabled: () => true,
    resolveEndpoint: () => ({ socketPath: '/var/run/docker.sock' }),
    makeClient: () => okDocker(),
    makeManager: () => fakeManager(),
    setHook: () => {},
    log: () => {},
    ...over,
  }
}

function fakeManager(over: Partial<StandbyManager> = {}): StandbyManager {
  return {
    ensureAwake: async () => {},
    withAwake: async (_s, fn) => fn(),
    adopt: async () => {},
    tick: async () => {},
    shutdown: async () => {},
    snapshot: () => [],
    origin: () => null,
    managed: () => false,
    diagnose: async (s) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown', containerId: null, hostPort: null }),
    ...over,
  }
}

describe('wireStandby', () => {
  it('happy path: manager 接上 hook、adopt 跑过,不再自建 reaper 定时器', async () => {
    const events: string[] = []
    let hooked: StandbyManager | null = null
    const mgr = fakeManager({ adopt: async () => void events.push('adopt') })
    const w = await wireStandby(deps({
      makeManager: () => mgr,
      setHook: (m) => { hooked = m; events.push('setHook') },
    }))
    expect(w.manager).toBe(mgr)
    expect(hooked).toBe(mgr)
    expect(w).not.toHaveProperty('timer')
    // hook 必须在 adopt 之前接上:adopt 期间到达的请求要能看到管理器,而不是打在一个已停的容器上。
    expect(events).toEqual(['setHook', 'adopt'])
  })

  it('adopt() 抛 → 异常传出去(交给 buildStandbyOrDegrade 降级),hook 复位', async () => {
    const hooked: Array<StandbyManager | null> = []
    await expect(wireStandby(deps({
      makeManager: () => fakeManager({ adopt: async () => { throw new Error('docker socket vanished mid-adopt') } }),
      setHook: (m) => void hooked.push(m),
    }))).rejects.toThrow(/vanished mid-adopt/)
    // hook 在 adopt 之前已经指向这个管理器,抛出时必须复位——否则后续 withAwake 会打在一个
    // 收养到一半、状态不完整的管理器上(serve.ts 的降级清理也会再复位一次,但那是第二道网,
    // 不是第一道:wireStandby 自己制造的副作用,得由它自己收干净)。
    expect(hooked.at(-1)).toBeNull()
  })

  it('makeManager 抛(重名 service)→ 异常传出去,hook 没被指向半成品', async () => {
    let hooked: StandbyManager | null | undefined
    await expect(wireStandby(deps({
      makeManager: () => { throw new Error('standby: duplicate service names in config: voiceprint') },
      setHook: (m) => { hooked = m },
    }))).rejects.toThrow(/duplicate service names/)
    expect(hooked).toBeUndefined()
  })

  // inert 的三个出口必须**各自报出原因**,而不是一律返回一个光秃秃的 null。
  // 为什么:调用方要据此决定喊不喊人。「Docker 不在」是外部事故(所有容器插件一起没,该喊);
  // 「没插件声明 standby」「桌面档没有容器门」是按设计如此(喊了只会教用户忽略这个通知)。
  // 原因在函数内部丢掉的那一天,这个区分就没法在外面做——2026-09-02 活体撞到的正是这个:
  // Docker 引擎挂着的窗口里重启后端,全站网盘搜索静默归零,唯一线索是一行没人看的启动日志。
  it('docker ping 不通 → 不接线、留一行日志,容器保持常驻,并报出 docker-unreachable', async () => {
    const logs: string[] = []
    const w = await wireStandby(deps({
      makeClient: () => okDocker({ ping: async () => false }),
      log: (m) => void logs.push(m),
    }))
    // affected 说清影响面:这些 service 从此不再被唤醒。通知里要报出来,否则用户看到的
    // 只是"某个插件不好使",看不出是**全体**容器插件一起没了。
    expect(w).toEqual({ manager: null, inertReason: 'docker-unreachable', affected: ['voiceprint'] })
    expect(logs.join('\n')).toContain('docker API unreachable')
  })

  it('解不出 Docker 端点 → 同样降级直通,不去造 client,原因同为 docker-unreachable', async () => {
    let made = 0
    const w = await wireStandby(deps({
      resolveEndpoint: () => null,
      makeClient: () => { made++; return okDocker() },
    }))
    // 端点解不出与 ping 不通,对用户是同一件事:这台机器上够不着 Docker。
    expect(w).toEqual({ manager: null, inertReason: 'docker-unreachable', affected: ['voiceprint'] })
    expect(made).toBe(0)
  })

  it('两道构造闸没过(mode=none)→ 连 Docker 端点都不解析,原因是 not-gated(按设计如此)', async () => {
    let resolved = 0
    const w = await wireStandby(deps({
      mode: 'none',
      resolveEndpoint: () => { resolved++; return null },
    }))
    expect(w).toEqual({ manager: null, inertReason: 'not-gated' })
    expect(resolved).toBe(0)
  })

  it('没有插件声明 standby → 同样彻底 inert,原因也是 not-gated(不是故障)', async () => {
    let resolved = 0
    const w = await wireStandby(deps({
      descriptors: [descriptor('plain', false)],
      resolveEndpoint: () => { resolved++; return null },
    }))
    expect(w).toEqual({ manager: null, inertReason: 'not-gated' })
    expect(resolved).toBe(0)
  })

  it('声明了 standby 但一个 target 都解不出 → 不造空管理器', async () => {
    const logs: string[] = []
    let made = 0
    const w = await wireStandby(deps({
      // 走 planServices 注入口。理由见 wire.ts 上那段注释:这条防御分支通过真实 planner 不可达
      // (声明了 standby 就必然有 backend,origin 一定解得出),换掉 planner 是唯一诚实的到达方式;
      // 靠拧夹具去"假装"够到一个不可达状态,测的就不是真东西了。
      planServices: () => ({ gated: true, services: [], skipped: ['ghost'], disabled: [] }),
      makeManager: () => { made++; return fakeManager() },
      log: (m) => void logs.push(m),
    }))
    expect(w).toEqual({ manager: null, inertReason: 'no-resolvable-services' })
    expect(made).toBe(0)
    expect(logs.join('\n')).toContain('standby inert this boot')
  })

  it('skipped 的服务会被点名(否则一个解不出 origin 的插件会安静地消失)', async () => {
    const logs: string[] = []
    await wireStandby(deps({
      planServices: () => ({
        gated: true,
        services: [{ service: 'voiceprint', idleMinutes: 10, startTimeoutSeconds: 60, healthUrl: 'http://voiceprint:80/health' }],
        skipped: ['ghost'],
        disabled: [],
      }),
      log: (m) => void logs.push(m),
    }))
    expect(logs.join('\n')).toContain('no resolvable target')
    expect(logs.join('\n')).toContain('ghost')
  })
})

/**
 * 第三方包的 standby 名册。container-policy 给第三方兜了 `standby: { idleMinutes: 30 }`，
 * 而且这个数写在安装确认页上（= 对用户的一句承诺）。名册只吃内置那层的话，那 30 分钟
 * 就是一句空话：容器建起来就一直跑，没有 reaper 收。
 *
 * 合并本身住在 `BackendDirectory`（serve.ts 传 `kernel.packages.backendDirectory.all()` 进来），
 * 所以下面这些 descriptors 也照那条路造——两层的顺序与过滤都由它说了算。
 */
describe('wireStandby 第三方包', () => {
  it('第三方声明的 backend.standby 进名册（否则兜底的 30 分钟闲置回收是空话）', async () => {
    let managed: { service: string; idleMinutes: number }[] = []
    await wireStandby(deps({
      descriptors: new BackendDirectory([descriptor('voiceprint', true)], [descriptor('acme-scraper', true)]).all(),
      makeManager: (d) => {
        managed = d.services.map((s) => ({ service: s.service, idleMinutes: s.idleMinutes }))
        return fakeManager()
      },
    }))
    expect(managed.map((s) => s.service)).toEqual(['voiceprint', 'acme-scraper'])
  })

  it('只有第三方声明 standby 时也接线（内置那层可以一个都没有）', async () => {
    const w = await wireStandby(deps({
      descriptors: new BackendDirectory([descriptor('xhs', false)], [descriptor('acme-scraper', true)]).all(),
    }))
    expect(w.manager).not.toBeNull()
  })

  it('第三方 service 名与内置撞名 → 名册重名照旧抛（安装期已挡住，这里是最后一道）', async () => {
    await expect(wireStandby(deps({
      descriptors: new BackendDirectory([descriptor('acme-scraper', true)], [descriptor('acme-scraper', true)]).all(),
      makeManager: makeStandbyManager,   // 这一条要的就是真管理器的重名断言
    }))).rejects.toThrow(/duplicate service names/)
  })
})
