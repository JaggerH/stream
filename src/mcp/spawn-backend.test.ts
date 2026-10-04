import { describe, it, expect } from 'vitest'
import { resolveSpawnCmd, spawnBackend, backendPortOf } from './spawn-backend.ts'

describe('resolveSpawnCmd', () => {
  it('STREAM_BACKEND_CMD wins (space-split)', () => {
    expect(resolveSpawnCmd({ STREAM_BACKEND_CMD: 'node /opt/stream/server.mjs' }, 'file:///repo/src/mcp/stdio-entry.ts'))
      .toEqual({ cmd: 'node', args: ['/opt/stream/server.mjs'] })
  })
  it('default: current runtime + execArgv + ../serve.ts relative to entry', () => {
    const r = resolveSpawnCmd({}, 'file:///repo/src/mcp/stdio-entry.ts')
    expect(r.cmd).toBe(process.execPath)
    expect(r.args.at(-1)).toBe('/repo/src/serve.ts')
    expect(r.args.slice(0, -1)).toEqual(process.execArgv)
  })
})

describe('spawnBackend', () => {
  it('resolves once probe turns healthy; kill() terminates the child', async () => {
    const killed: boolean[] = []
    const fakeChild = { kill: () => void killed.push(true), unref: () => {} }
    let calls = 0
    const b = await spawnBackend({
      spawnImpl: (() => fakeChild) as never,
      probe: async () => ++calls >= 3, // 第三次探活才绿
      timeoutMs: 5000, pollMs: 1,
    })
    expect(b.url).toBe('http://127.0.0.1:8900')
    b.kill()
    expect(killed).toEqual([true])
  })
  /**
   * 子进程当场就死了 → **别等满超时**。不接这个的样子是：`stream mcp` 拉起一份秒退的后端，
   * 然后对着一个永远不会绿的探针静默轮询 60 秒。用户看到的是一条卡住的命令，而真正的原因
   * 早就打在 stderr 上了——"卡住"和"起得慢"长得一模一样，这是最难自查的一种。
   */
  it('子进程秒退 → 当场报错，不空等到超时', async () => {
    const handlers = new Map<string, (code: number | null, signal: null) => void>()
    const fakeChild = {
      kill: () => {},
      unref: () => {},
      once: (ev: string, fn: (code: number | null, signal: null) => void) => { handlers.set(ev, fn) },
    }
    const p = spawnBackend({
      spawnImpl: (() => fakeChild) as never,
      // 探针永不绿；靠 exit 事件收场。超时给得很大——真等到它就说明这条路没接上。
      probe: async () => false,
      timeoutMs: 30_000, pollMs: 1,
    })
    handlers.get('exit')?.(1, null)
    await expect(p).rejects.toThrow(/exited before it answered/)
  })

  /** 注入的假 child 没有事件接口时不许炸——上面那几条用例就是这样的。 */
  it('假 child 没有 once 也照常走老路（超时）', async () => {
    await expect(spawnBackend({
      spawnImpl: (() => ({ kill: () => {}, unref: () => {} })) as never,
      probe: async () => false, timeoutMs: 20, pollMs: 5,
    })).rejects.toThrow(/spawn timeout/)
  })

  it('timeout kills the child and rejects', async () => {
    const killed: boolean[] = []
    await expect(spawnBackend({
      spawnImpl: (() => ({ kill: () => void killed.push(true), unref: () => {} })) as never,
      probe: async () => false, timeoutMs: 20, pollMs: 5,
    })).rejects.toThrow(/backend spawn timeout/)
    expect(killed).toEqual([true])
  })
  it('spawns the child with stdout ignored and stderr inherited (JSON-RPC channel safety)', async () => {
    const fakeChild = { kill: () => {}, unref: () => {} }
    let capturedOptions: { stdio?: unknown } | undefined
    const spawnImpl = ((_cmd: string, _args: string[], options: { stdio?: unknown }) => {
      capturedOptions = options
      return fakeChild
    }) as never
    await spawnBackend({ spawnImpl, probe: async () => true, timeoutMs: 5000, pollMs: 1 })
    expect(capturedOptions?.stdio).toEqual(['ignore', 'ignore', 'inherit'])
  })
  it('onChild fires synchronously right after spawn, before the first health probe', async () => {
    const order: string[] = []
    const fakeChild = { kill: () => {}, unref: () => {} }
    await spawnBackend({
      spawnImpl: (() => fakeChild) as never,
      onChild: () => order.push('onChild'),
      probe: async () => { order.push('probe'); return true },
      timeoutMs: 5000, pollMs: 1,
    })
    expect(order).toEqual(['onChild', 'probe'])
  })
  it('a kill via onChild while still polling and the timeout-path kill do not double-kill', async () => {
    // 模拟真实场景:调用方(路由)拿到 onChild 交出的句柄后,在探针还没变绿之前就把它杀了
    // (对应关停撞上一次在途 spawn)。spawnBackend 自己浑然不知,轮询会继续跑到 deadline,
    // 兜底再调一次 kill——这必须是安全的 no-op,不能对底层子进程杀两次。
    const kills: number[] = []
    const fakeChild = { kill: () => void kills.push(1), unref: () => {} }
    let earlyKill: (() => void) | undefined
    await expect(spawnBackend({
      spawnImpl: (() => fakeChild) as never,
      onChild: (c) => { earlyKill = () => c.kill() },
      probe: async () => { earlyKill?.(); return false },
      timeoutMs: 20, pollMs: 5,
    })).rejects.toThrow(/backend spawn timeout/)
    expect(kills).toEqual([1]) // 不是 [1, 1]
  })
  // C1 的回归门:曾经 spawn 出来的 serve.ts 绑 STREAM_PORT ?? 4555,而探针打 8900
  // (gateway 的发布端口)——默认配置下"起在 4555、探 8900",必然探不绿,白烧满 60s。
  // 断言的是**端口一致性**本身:交给 spawnImpl 的 env.STREAM_PORT 必须等于被探那个 URL 的端口。
  const captureEnv = async (env: NodeJS.ProcessEnv) => {
    let captured: NodeJS.ProcessEnv | undefined
    const b = await spawnBackend({
      env,
      spawnImpl: ((_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => {
        captured = o.env
        return { kill: () => {}, unref: () => {} }
      }) as never,
      probe: async () => true,
      timeoutMs: 5000, pollMs: 1,
    })
    return { url: b.url, port: captured?.STREAM_PORT }
  }
  it('default: the child is told to bind exactly the port we then probe', async () => {
    const { url, port } = await captureEnv({})
    expect(url).toBe('http://127.0.0.1:8900')
    expect(port).toBe(new URL(url).port)
    expect(port).toBe('8900')
  })
  it('explicit STREAM_BACKEND_URL with a non-default port: STREAM_PORT follows it', async () => {
    const { url, port } = await captureEnv({ STREAM_BACKEND_URL: 'http://127.0.0.1:4555' })
    expect(url).toBe('http://127.0.0.1:4555')
    expect(port).toBe(new URL(url).port)
    expect(port).toBe('4555')
  })
  it('backendPortOf: implicit scheme ports, and a broken URL leaves STREAM_PORT unset', async () => {
    expect(backendPortOf('http://host/')).toBe('80')
    expect(backendPortOf('https://host/')).toBe('443')
    expect(backendPortOf('not a url')).toBe(null)
    const { port } = await captureEnv({ STREAM_BACKEND_URL: 'not a url' })
    expect(port).toBeUndefined()
  })
  // Task 10:stdio 后端在宿主上,默认开「一扇门」(host 档)。Docker 不可用时 wireStandby
  // 降级闸自动落回 inert,等价 none——默认 host 无害。显式设置者优先,不被覆盖。
  it('spawn env 默认带 STREAM_PLUGIN_NETWORK=host(stdio 后端在宿主上,走一扇门)', async () => {
    let captured: NodeJS.ProcessEnv | undefined
    await spawnBackend({
      env: {},
      spawnImpl: ((_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => {
        captured = o.env
        return { kill: () => {}, unref: () => {} }
      }) as never,
      probe: async () => true,
      timeoutMs: 5000, pollMs: 1,
    })
    expect(captured?.STREAM_PLUGIN_NETWORK).toBe('host')
  })
  it('显式 STREAM_PLUGIN_NETWORK 原样透传不覆盖', async () => {
    let captured: NodeJS.ProcessEnv | undefined
    await spawnBackend({
      env: { STREAM_PLUGIN_NETWORK: 'none' },
      spawnImpl: ((_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => {
        captured = o.env
        return { kill: () => {}, unref: () => {} }
      }) as never,
      probe: async () => true,
      timeoutMs: 5000, pollMs: 1,
    })
    expect(captured?.STREAM_PLUGIN_NETWORK).toBe('none')
  })
  // 查询档:stdio MCP spawn 出的即用即回收后端不该启动采集调度。默认带 STREAM_NO_SCHEDULER=1,
  // serve.ts 据此跳过 scheduler.start()——查询型用户连上问一句不该顺带触发全量采集。
  it('spawn env 默认带 STREAM_NO_SCHEDULER=1(查询档不启动采集调度)', async () => {
    let captured: NodeJS.ProcessEnv | undefined
    await spawnBackend({
      env: {},
      spawnImpl: ((_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => {
        captured = o.env
        return { kill: () => {}, unref: () => {} }
      }) as never,
      probe: async () => true,
      timeoutMs: 5000, pollMs: 1,
    })
    expect(captured?.STREAM_NO_SCHEDULER).toBe('1')
  })
  it('显式 STREAM_NO_SCHEDULER 原样透传不覆盖', async () => {
    let captured: NodeJS.ProcessEnv | undefined
    await spawnBackend({
      env: { STREAM_NO_SCHEDULER: '0' },
      spawnImpl: ((_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => {
        captured = o.env
        return { kill: () => {}, unref: () => {} }
      }) as never,
      probe: async () => true,
      timeoutMs: 5000, pollMs: 1,
    })
    expect(captured?.STREAM_NO_SCHEDULER).toBe('0')
  })
  // 包更新闭环:POST /api/restart 让后端以 RESTART_EXIT_CODE(75)退出,`stream mcp` 那层壳
  // 靠 childEnv.STREAM_SUPERVISED 告诉后端「有人管你」,靠 exited promise 判断该不该再拉起一份。
  it('子进程 env 带 STREAM_SUPERVISED=1;exited 在子进程退出后 resolve 出退出码', async () => {
    const listeners: Record<string, (code: number | null, signal: NodeJS.Signals | null) => void> = {}
    const child = { kill: () => {}, unref: () => {}, once: (ev: string, cb: never) => { listeners[ev] = cb as never } }
    let capturedEnv: NodeJS.ProcessEnv | undefined
    const spawnImpl = ((_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = options.env
      return child
    }) as never
    const s = await spawnBackend({ env: { STREAM_BACKEND_URL: 'http://127.0.0.1:1' }, spawnImpl, probe: async () => true })
    expect(capturedEnv?.STREAM_SUPERVISED).toBe('1')
    // 调用方 shell 里的 STREAM_RESTART_MODE（dev.sh 会 export watch）不许继承进来：壳只认 75。
    expect(capturedEnv?.STREAM_RESTART_MODE).toBe('supervised')
    listeners.exit(75, null)
    expect(await s.exited).toEqual({ code: 75, signal: null })
  })

  it('a rejecting probe does not orphan the child: it keeps polling until deadline, then kills it', async () => {
    const killed: boolean[] = []
    const fakeChild = { kill: () => void killed.push(true), unref: () => {} }
    let calls = 0
    await expect(spawnBackend({
      spawnImpl: (() => fakeChild) as never,
      probe: async () => {
        calls++
        throw new Error('transient connection error while backend still booting')
      },
      timeoutMs: 20, pollMs: 5,
    })).rejects.toThrow(/backend spawn timeout/)
    expect(calls).toBeGreaterThan(0)
    expect(killed).toEqual([true])
  })
})
