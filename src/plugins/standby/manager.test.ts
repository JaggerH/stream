import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeStandbyManager } from './manager.ts'
import type { StandbyManagerDeps } from './manager.ts'
import type { DockerClient, DockerContainer } from './docker-api.ts'
import { setStandbyManager, withAwake as hookWithAwake, standbySnapshot } from './hook.ts'
import { StandbyWakeTimeoutError } from './wake-error.ts'
import { isRetryable } from '../../retryable.ts'

/** standby 只唤醒/停止**已经存在**的容器,创建类动作(拉镜像/建容器/删容器/建网络)不归它管。
 *  桩成"调了就抛",这样哪天 manager 偷偷调了它们,测试立刻响而不是静默通过。 */
const NOT_USED_BY_STANDBY = {
  pullImage: async () => { throw new Error('standby must not pull images') },
  createContainer: async () => { throw new Error('standby must not create containers') },
  removeContainer: async () => { throw new Error('standby must not remove containers') },
  ensureNetwork: async () => { throw new Error('standby must not create networks') },
  inspectState: async () => { throw new Error('standby must not inspect state') },
  logs: async () => { throw new Error('standby must not read logs') },
  exec: async () => { throw new Error('standby must not exec') },
} satisfies Pick<DockerClient, 'pullImage' | 'createContainer' | 'removeContainer' | 'ensureNetwork' | 'inspectState' | 'logs' | 'exec'>

function fakeDocker(state: { running: boolean }) {
  const log: string[] = []
  const docker: DockerClient = {
    ...NOT_USED_BY_STANDBY,
    ping: async () => true,
    listByService: async (s) => [{ Id: `${s}-id`, State: state.running ? 'running' : 'exited', Names: [`/${s}`] } as DockerContainer],
    start: async (id) => { log.push(`start ${id}`); state.running = true },
    stop: async (id) => { log.push(`stop ${id}`); state.running = false },
    inspectHostPort: async () => null,
  }
  return { docker, log }
}
const SPEC = { service: 'voiceprint', idleMinutes: 10, startTimeoutSeconds: 60, healthUrl: 'http://voiceprint:80/health' }

/** 把当前排队的 microtask 全部跑干净 —— 用来断言"到这一刻为止某件事还没发生"。 */
async function drain(): Promise<void> { for (let i = 0; i < 50; i++) await Promise.resolve() }
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void
  const wait = new Promise<void>((r) => { release = r })
  return { wait, release }
}

describe('standby manager', () => {
  it('wakes an asleep container once for N concurrent callers', async () => {
    const st = { running: false }
    const { docker, log } = fakeDocker(st)
    const health = vi.fn(async () => st.running) // 起来即绿
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => 1000, probeHealth: health, pollMs: 1 })
    await Promise.all([m.ensureAwake('voiceprint'), m.ensureAwake('voiceprint'), m.ensureAwake('voiceprint')])
    expect(log.filter((l) => l.startsWith('start'))).toHaveLength(1)
    expect(m.snapshot()[0].state).toBe('awake')
    expect(m.snapshot()[0].lastWakeMs).not.toBeNull()
  })
  it('unknown service is a no-op', async () => {
    const { docker } = fakeDocker({ running: false })
    const m = makeStandbyManager({ docker, services: [SPEC], probeHealth: async () => true })
    await expect(m.ensureAwake('alist')).resolves.toBeUndefined()
  })
  it('rejects duplicate service names at construction', () => {
    const { docker } = fakeDocker({ running: false })
    expect(() => makeStandbyManager({ docker, services: [SPEC, { ...SPEC, idleMinutes: 99 }] })).toThrow(/duplicate service/)
  })
  // MINOR F:调用点写死的是插件 id,cell 键是 backend.service ?? id。两者不同的那天,
  // withAwake(id) 会静默 no-op(请求打在停着的容器上,没有任何日志指向 standby)。别名让这类
  // 错误不可能发生——而且必须是**同一个 Cell**,不是第二个。
  it('an alias resolves to the same cell as the service name (one container, one state)', async () => {
    const st = { running: false }
    const { docker, log } = fakeDocker(st)
    const spec = { ...SPEC, service: 'voiceprint-engine', aliases: ['voiceprint'] }
    const m = makeStandbyManager({ docker, services: [spec], now: () => 1000, probeHealth: async () => st.running, pollMs: 1 })
    // 按**别名**唤醒:必须真的把容器起起来,而不是 no-op
    await m.withAwake('voiceprint', async () => {})
    expect(log.filter((l) => l.startsWith('start'))).toEqual(['start voiceprint-engine-id'])
    // 同一个 cell:snapshot 只有一条(别名不产生第二个 cell),且报的是 service 名
    expect(m.snapshot()).toHaveLength(1)
    expect(m.snapshot()[0].service).toBe('voiceprint-engine')
    expect(m.snapshot()[0].state).toBe('awake')
  })
  it('managed() 问的是"管不管得着"——含别名命中,未知 service → false,与醒睡无关', async () => {
    const st = { running: false }
    const { docker } = fakeDocker(st)
    const spec = { ...SPEC, service: 'voiceprint-engine', aliases: ['voiceprint'] }
    const m = makeStandbyManager({ docker, services: [spec], now: () => 1000, probeHealth: async () => st.running, pollMs: 1 })
    expect(m.managed('voiceprint-engine')).toBe(true)
    expect(m.managed('voiceprint')).toBe(true) // 别名同样命中同一个 Cell
    expect(m.managed('nope')).toBe(false)
    // 睡着也算"管得着"——managed 不看 state
    expect(m.snapshot()[0].state).toBe('asleep')
    expect(m.managed('voiceprint-engine')).toBe(true)
  })
  // 唤醒超时不是任务的死刑判决:容器多半还在装权重,下次唤醒就绿。超时错误必须自述"可重试",
  // 且 cell 落回 asleep(下一次唤醒还能正常走 wake())。startTimeoutSeconds:0 → deadline=t0,
  // while(now()<t0) 直接不进循环,不 poll 即抛超时。
  it('wake timeout throws a retryable StandbyWakeTimeoutError and leaves the cell asleep (re-wakeable)', async () => {
    const st = { running: false }
    const { docker } = fakeDocker(st)
    const spec = { ...SPEC, startTimeoutSeconds: 0 }
    const m = makeStandbyManager({ docker, services: [spec], now: () => 1000, probeHealth: async () => false, pollMs: 1 })
    let caught: unknown
    try { await m.ensureAwake('voiceprint') } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(StandbyWakeTimeoutError)
    expect(isRetryable(caught)).toBe(true)
    // message 一字不改:日志/诊断沿用旧文案
    expect((caught as Error).message).toMatch(/standby wake timeout for voiceprint after 0s/)
    // 落回 asleep —— 下次唤醒还能走 wake(),不是卡死在 starting
    expect(m.snapshot()[0].state).toBe('asleep')
  })
  it('an alias colliding with another service name is rejected at construction', () => {
    const { docker } = fakeDocker({ running: false })
    expect(() => makeStandbyManager({
      docker,
      services: [SPEC, { ...SPEC, service: 'mineru', aliases: ['voiceprint'] }],
    })).toThrow(/duplicate service/)
  })
  // MINOR B:成功日志一旦留在停止那段 try 里,一次 EPIPE 的 console.log 会掉进 catch,
  // 把已经真的停掉的容器状态回滚成 awake —— 一行日志改写了一次成功的停止。
  it('a throwing log sink cannot roll a completed stop back to awake', async () => {
    const st = { running: true }
    const { docker, log } = fakeDocker(st)
    let now = 0
    const m = makeStandbyManager({
      docker, services: [SPEC], now: () => now, probeHealth: async () => true,
      log: () => { throw new Error('EPIPE') },
    })
    await m.adopt()
    now = 11 * 60_000
    await expect(m.tick()).resolves.toBeUndefined() // 永不 reject
    expect(log).toEqual(['stop voiceprint-id']) // 容器确实停了
    expect(m.snapshot()[0].state).toBe('asleep') // 状态没被日志回滚
  })
  it('reaper stops after idleMinutes, not before', async () => {
    const st = { running: true }
    const { docker, log } = fakeDocker(st)
    let now = 0
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => now, probeHealth: async () => true })
    await m.adopt() // running → awake, lastUsed=0
    now = 9 * 60_000; await m.tick()
    expect(log).toHaveLength(0)
    now = 11 * 60_000; await m.tick()
    expect(log).toEqual(['stop voiceprint-id'])
    expect(m.snapshot()[0].state).toBe('asleep')
  })
  it('wake during stop waits for stop then starts', async () => {
    // stop 卡在闸门上,于是"stop 还没完成时有没有发出 start"成为可观测事实 ——
    // 少了 ensureAwake 里的 stopping 串行化守卫,这个断言会当场炸(见 task-4 报告的变异验证)。
    const st = { running: true }
    const log: string[] = []
    const g = gate()
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async (s) => [{ Id: `${s}-id`, State: st.running ? 'running' : 'exited', Names: [`/${s}`] } as DockerContainer],
      start: async (id) => { log.push(`start ${id}`); st.running = true },
      stop: async (id) => { await g.wait; log.push(`stop ${id}`); st.running = false },
      inspectHostPort: async () => null,
    }
    let now = 0
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => now, probeHealth: async () => st.running, pollMs: 1 })
    await m.adopt()
    now = 11 * 60_000
    const stopping = m.tick()
    const waking = m.ensureAwake('voiceprint')
    await drain()
    expect(log).toEqual([]) // stop 尚在飞行中 → 一个 start 都不许发出
    expect(m.snapshot()[0].state).toBe('stopping')
    g.release()
    await Promise.all([stopping, waking])
    expect(log).toEqual(['stop voiceprint-id', 'start voiceprint-id'])
    expect(m.snapshot()[0].state).toBe('awake')
  })
  it('wake timeout → asleep + throws', async () => {
    const st = { running: false }
    const { docker } = fakeDocker(st)
    let now = 0
    const m = makeStandbyManager({
      docker, services: [{ ...SPEC, startTimeoutSeconds: 5 }],
      now: () => (now += 3000), // 每次询问推进 3s,两轮即超时
      probeHealth: async () => false, pollMs: 1,
    })
    await expect(m.ensureAwake('voiceprint')).rejects.toThrow(/standby wake timeout/)
    expect(m.snapshot()[0].state).toBe('asleep')
  })
  it('docker.start failure → asleep (not stranded in starting) and a later wake still works', async () => {
    const st = { running: false }
    const log: string[] = []
    let failNext = true
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async (s) => [{ Id: `${s}-id`, State: st.running ? 'running' : 'exited', Names: [`/${s}`] } as DockerContainer],
      start: async (id) => {
        if (failNext) { failNext = false; throw new Error('docker start HTTP 500') }
        log.push(`start ${id}`); st.running = true
      },
      stop: async (id) => { log.push(`stop ${id}`); st.running = false },
      inspectHostPort: async () => null,
    }
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => 1000, probeHealth: async () => st.running, pollMs: 1 })
    await expect(m.ensureAwake('voiceprint')).rejects.toThrow(/HTTP 500/)
    expect(m.snapshot()[0].state).toBe('asleep')
    await m.ensureAwake('voiceprint')
    expect(m.snapshot()[0].state).toBe('awake')
    expect(log).toEqual(['start voiceprint-id'])
  })
  it('adopt marks running containers awake, exited ones asleep', async () => {
    const { docker } = fakeDocker({ running: true })
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => 5, probeHealth: async () => true })
    await m.adopt()
    expect(m.snapshot()).toEqual([{ service: 'voiceprint', state: 'awake', lastUsed: 5, lastWakeMs: null }])
  })
  it('shutdown stops awake containers best-effort', async () => {
    const st = { running: true }
    const { docker, log } = fakeDocker(st)
    const m = makeStandbyManager({ docker, services: [SPEC], probeHealth: async () => true })
    await m.adopt()
    await m.shutdown()
    expect(log).toEqual(['stop voiceprint-id'])
  })
  it('shutdown waits for an in-flight wake, then stops what it started', async () => {
    const st = { running: false }
    const log: string[] = []
    const g = gate()
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async (s) => [{ Id: `${s}-id`, State: st.running ? 'running' : 'exited', Names: [`/${s}`] } as DockerContainer],
      start: async (id) => { await g.wait; log.push(`start ${id}`); st.running = true },
      stop: async (id) => { log.push(`stop ${id}`); st.running = false },
      inspectHostPort: async () => null,
    }
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => 1000, probeHealth: async () => st.running, pollMs: 1 })
    const waking = m.ensureAwake('voiceprint')
    await drain()
    expect(m.snapshot()[0].state).toBe('starting')
    const down = m.shutdown()
    g.release()
    await Promise.all([waking, down])
    expect(log).toEqual(['start voiceprint-id', 'stop voiceprint-id'])
    expect(m.snapshot()[0].state).toBe('asleep')
  })
  it('ensureAwake after shutdown is a silent no-op (never starts, never rejects)', async () => {
    const st = { running: false }
    const { docker, log } = fakeDocker(st)
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => 1000, probeHealth: async () => st.running, pollMs: 1 })
    await m.shutdown()
    await expect(m.ensureAwake('voiceprint')).resolves.toBeUndefined()
    expect(log.filter((l) => l.startsWith('start'))).toEqual([])
    expect(m.snapshot()[0].state).toBe('asleep')
    // 抽干期间的长请求照样能跑完 —— withAwake 不因 shutdown 而失败
    await expect(m.withAwake('voiceprint', async () => 'done')).resolves.toBe('done')
  })
  it('a caller parked on a gated stop must not start after shutdown() has already returned', async () => {
    // 镜像"shutdown waits for an in-flight wake"那个用例,但这次是 stop 被闸住 ——
    // ensureAwake 卡在 stopping 的 await 上,shutdown() 先跑完并置位 shuttingDown,
    // 松闸后卡住的调用方恢复过来,必须看到 shuttingDown 已经是 true,而不是径直把
    // 已经被 shutdown 收干净的容器又拉起来。
    const st = { running: true }
    const log: string[] = []
    const g = gate()
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async (s) => [{ Id: `${s}-id`, State: st.running ? 'running' : 'exited', Names: [`/${s}`] } as DockerContainer],
      start: async (id) => { log.push(`start ${id}`); st.running = true },
      stop: async (id) => { await g.wait; log.push(`stop ${id}`); st.running = false },
      inspectHostPort: async () => null,
    }
    let now = 0
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => now, probeHealth: async () => st.running, pollMs: 1 })
    await m.adopt()
    now = 11 * 60_000
    const stopping = m.tick()
    const waking = m.ensureAwake('voiceprint') // 停在 stopping 上等 cell.inflight
    await drain()
    expect(m.snapshot()[0].state).toBe('stopping')
    const down = m.shutdown() // shutdown 自己也在等同一个 inflight,和 waking 一起排队
    await drain()
    g.release() // 放行 stop:tick 的 stop、shutdown 里等的 stop、ensureAwake 里等的 stop 一起解开
    await Promise.all([stopping, waking, down])
    expect(log).toEqual(['stop voiceprint-id']) // 绝不能出现 start
    expect(m.snapshot()[0].state).toBe('asleep')
  })
  it('tick never rejects even when both the stop and the log sink fail', async () => {
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async (s) => [{ Id: `${s}-id`, State: 'running', Names: [`/${s}`] } as DockerContainer],
      start: async (id) => {},
      stop: async () => { throw new Error('docker stop HTTP 500') },
      inspectHostPort: async () => null,
    }
    let now = 0
    const throwingLog = () => { throw new Error('log sink is on fire') }
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => now, probeHealth: async () => true, log: throwingLog })
    await m.adopt()
    now = 11 * 60_000
    await expect(m.tick()).resolves.toBeUndefined()
    expect(m.snapshot()[0].state).toBe('awake') // 停失败,仍在 reaper 视野内
  })
  it('tick isolates a failing stop: later services are still reaped and tick never rejects', async () => {
    const SPEC_B = { ...SPEC, service: 'docparse', healthUrl: 'http://docparse:80/health' }
    const log: string[] = []
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async (s) => [{ Id: `${s}-id`, State: 'running', Names: [`/${s}`] } as DockerContainer],
      start: async (id) => { log.push(`start ${id}`) },
      stop: async (id) => {
        if (id === 'voiceprint-id') throw new Error('docker stop HTTP 500')
        log.push(`stop ${id}`)
      },
      inspectHostPort: async () => null,
    }
    let now = 0
    const m = makeStandbyManager({ docker, services: [SPEC, SPEC_B], now: () => now, probeHealth: async () => true })
    await m.adopt()
    now = 11 * 60_000
    await expect(m.tick()).resolves.toBeUndefined()
    expect(log).toEqual(['stop docparse-id'])
    expect(m.snapshot().find((e) => e.service === 'docparse')!.state).toBe('asleep')
  })
  it('a failed stop leaves the cell awake so the next tick retries', async () => {
    let failNext = true
    const log: string[] = []
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async (s) => [{ Id: `${s}-id`, State: 'running', Names: [`/${s}`] } as DockerContainer],
      start: async (id) => { log.push(`start ${id}`) },
      stop: async (id) => {
        if (failNext) { failNext = false; throw new Error('docker stop HTTP 500') }
        log.push(`stop ${id}`)
      },
      inspectHostPort: async () => null,
    }
    let now = 0
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => now, probeHealth: async () => true })
    await m.adopt()
    now = 11 * 60_000
    await m.tick()
    expect(log).toEqual([]) // 没停成
    expect(m.snapshot()[0].state).toBe('awake') // 仍在 reaper 视野内
    await m.tick()
    expect(log).toEqual(['stop voiceprint-id'])
    expect(m.snapshot()[0].state).toBe('asleep')
  })
  it('withAwake keeps a cell un-reapable while the request runs, reapable after', async () => {
    const st = { running: true }
    const { docker, log } = fakeDocker(st)
    let now = 0
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => now, probeHealth: async () => st.running, pollMs: 1 })
    await m.adopt()
    now = 11 * 60_000
    const g = gate()
    const using = m.withAwake('voiceprint', async () => { await g.wait; return 42 })
    await drain()
    now = 60 * 60_000 // 早已越过闲置线,但引用还压着
    await m.tick()
    expect(log).toEqual([])
    expect(m.snapshot()[0].state).toBe('awake')
    g.release()
    await expect(using).resolves.toBe(42)
    now = 90 * 60_000
    await m.tick()
    expect(log).toEqual(['stop voiceprint-id'])
  })
  it('withAwake counts its reference before ensureAwake\'s shuttingDown early-return, not after', async () => {
    // ensureAwake 走 shuttingDown 提前返回那条路径时完全同步、不盖 lastUsed。
    // 如果 withAwake 等 ensureAwake 的 await 落地才去加 inUse,两者之间就有一个真实存在的
    // 挂起点 —— 这里不用猜微任务顺序,直接用同步代码验证:withAwake() 调用返回控制权
    // 给调用方的那一刻(卡在它自己的第一个 await 上)，同一条同步执行流里紧接着调
    // tick(),tick() 的 inUse 检查读到的是"此刻"的计数,不是"最终"的计数。
    const st = { running: true }
    const g = gate() // 让 shutdown 卡在给这个 cell 发的 docker.stop 上,shuttingDown=true 但 state 还是 awake
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async (s) => [{ Id: `${s}-id`, State: st.running ? 'running' : 'exited', Names: [`/${s}`] } as DockerContainer],
      start: async (id) => { st.running = true },
      stop: async (id) => { await g.wait; st.running = false },
      inspectHostPort: async () => null,
    }
    let now = 0
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => now, probeHealth: async () => st.running, pollMs: 1 })
    await m.adopt() // awake, lastUsed = 0
    now = 11 * 60_000 // stale 的 lastUsed 之后看起来早已过闲置线
    const down = m.shutdown()
    await drain()
    expect(m.snapshot()[0].state).toBe('awake') // shutdown 还没来得及把它标 asleep,卡在 gate 上

    const fnGate = gate()
    const using = m.withAwake('voiceprint', async () => { await fnGate.wait; return 'ok' })
    m.tick() // 同一条同步执行流里抢跑:withAwake 此刻卡在它自己第一个 await 上
    // 有引用保护 → tick 的 inUse 检查直接 continue,state 原地不动;
    // 没有 → tick 会同步把 state 改成 stopping(哪怕它自己的 stop 调用随后也会被同一个 gate 挡住)。
    expect(m.snapshot()[0].state).toBe('awake')

    g.release()
    fnGate.release()
    await Promise.all([down, using])
  })
  it('withAwake releases its reference even when fn throws', async () => {
    const st = { running: true }
    const { docker, log } = fakeDocker(st)
    let now = 0
    const m = makeStandbyManager({ docker, services: [SPEC], now: () => now, probeHealth: async () => st.running, pollMs: 1 })
    await m.adopt()
    await expect(m.withAwake('voiceprint', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    now = 30 * 60_000
    await m.tick()
    expect(log).toEqual(['stop voiceprint-id'])
  })
})

describe('host 档 origin 生命周期', () => {
  const hostSpec = {
    service: 'asr', idleMinutes: 10, startTimeoutSeconds: 5,
    hostProbe: { containerPort: 9000, healthPath: '/health' },
  }
  function hostDeps(overrides: Partial<StandbyManagerDeps> = {}): StandbyManagerDeps {
    let t = 0
    return {
      docker: {
        ...NOT_USED_BY_STANDBY,
        ping: async () => true,
        listByService: async () => [{ Id: 'c1', State: 'exited', Names: ['/asr'] }],
        start: async () => {},
        stop: async () => {},
        inspectHostPort: async () => 44728,
      },
      services: [hostSpec],
      now: () => (t += 10),
      probeHealth: async () => true,
      pollMs: 1,
      log: () => {},
      ...overrides,
    }
  }
  it('唤醒后 origin 缓存 inspect 出的 loopback 口,health 打在它上面', async () => {
    const probed: string[] = []
    const m = makeStandbyManager(hostDeps({ probeHealth: async (u) => { probed.push(u); return true } }))
    await m.ensureAwake('asr')
    expect(m.origin('asr')).toBe('http://127.0.0.1:44728')
    expect(probed[0]).toBe('http://127.0.0.1:44728/health')
  })
  it('asleep 时 origin 为 null;reaper 停掉后清空', async () => {
    const m = makeStandbyManager(hostDeps({ services: [{ ...hostSpec, idleMinutes: 0 }] }))
    expect(m.origin('asr')).toBeNull()
    await m.ensureAwake('asr')
    expect(m.origin('asr')).not.toBeNull()
    await m.tick() // now() 每读 +10ms,idleMinutes:0 → 立刻越过闲置线
    expect(m.snapshot()[0].state).toBe('asleep')
    expect(m.origin('asr')).toBeNull()
  })
  it('inspect 返回 null(口没发布)→ 唤醒失败落回 asleep,origin 为 null', async () => {
    const m = makeStandbyManager(hostDeps({
      docker: {
        ...NOT_USED_BY_STANDBY,
        ping: async () => true,
        listByService: async () => [{ Id: 'c1', State: 'exited', Names: ['/asr'] }],
        start: async () => {},
        stop: async () => {},
        inspectHostPort: async () => null,
      },
    }))
    await expect(m.ensureAwake('asr')).rejects.toThrow('no host port mapping')
    expect(m.origin('asr')).toBeNull()
    expect(m.snapshot()[0].state).toBe('asleep')
  })
  it('adopt 收养 running 容器时顺手 inspect 填 origin', async () => {
    const m = makeStandbyManager(hostDeps({
      docker: {
        ...NOT_USED_BY_STANDBY,
        ping: async () => true,
        listByService: async () => [{ Id: 'c1', State: 'running', Names: ['/asr'] }],
        start: async () => {},
        stop: async () => {},
        inspectHostPort: async () => 45712,
      },
    }))
    await m.adopt()
    expect(m.origin('asr')).toBe('http://127.0.0.1:45712')
  })
  it('adopt 时 running 容器 inspect 不出口 → 不收养,保持 asleep', async () => {
    const m = makeStandbyManager(hostDeps({
      docker: {
        ...NOT_USED_BY_STANDBY,
        ping: async () => true,
        listByService: async () => [{ Id: 'c1', State: 'running', Names: ['/asr'] }],
        start: async () => {},
        stop: async () => {},
        inspectHostPort: async () => null,
      },
    }))
    await m.adopt()
    expect(m.snapshot()[0].state).toBe('asleep')
    expect(m.origin('asr')).toBeNull()
  })
  it('compose 档 Cell(静态 healthUrl)origin 恒 null,行为不变', async () => {
    const m = makeStandbyManager(hostDeps({
      services: [{ service: 'asr', idleMinutes: 10, startTimeoutSeconds: 5, healthUrl: 'http://asr:9000/health' }],
    }))
    await m.ensureAwake('asr')
    expect(m.origin('asr')).toBeNull()
  })

  describe('僵尸口恢复', () => {
    // 造一个"第一次连死口、恢复后连新口成功"的 fn
    it('ECONNREFUSED → 对质发现容器死了 → 重唤醒拿新口 → 重试成功', async () => {
      let containerState = 'exited'
      let port = 44728
      let startCalls = 0
      const deps = hostDeps({
        docker: {
          ...NOT_USED_BY_STANDBY,
          ping: async () => true,
          listByService: async () => [{ Id: 'c1', State: containerState, Names: ['/asr'] }],
          // wake() 在 inspectHostPort 之前调用 start——第一次冷启动port 沿用初始 44728,
          // 只有死后重启(第二次 start)才换发新口 45712,不然 origin 在最初那次 ensureAwake
          // 就已经变成 45712,后面整段"对质→重唤醒"就无从测起。
          start: async () => { startCalls += 1; containerState = 'running'; if (startCalls > 1) port = 45712 },
          stop: async () => { containerState = 'exited' },
          inspectHostPort: async () => port,
        },
      })
      const m = makeStandbyManager(deps)
      await m.ensureAwake('asr')            // 醒,origin 44728
      containerState = 'exited'             // 容器在背后死了(缓存仍 awake/44728)
      let calls = 0
      const result = await m.withAwake('asr', async () => {
        calls += 1
        if (m.origin('asr') === 'http://127.0.0.1:44728') {
          const err = new Error('fetch failed')
          ;(err as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
          throw err
        }
        return m.origin('asr')
      })
      expect(calls).toBe(2)                          // 恰好重试一次
      expect(result).toBe('http://127.0.0.1:45712')  // 拿到新口
    })
    it('非连接层错误(HTTP 500 逻辑错)原样上抛,不重启容器', async () => {
      const deps = hostDeps()
      const m = makeStandbyManager(deps)
      await m.ensureAwake('asr')
      let calls = 0
      await expect(
        m.withAwake('asr', async () => { calls += 1; throw new Error('upstream 500') }),
      ).rejects.toThrow('upstream 500')
      expect(calls).toBe(1)
    })
    it('e.cause === e(成环)不会死循环,当非连接层错误原样上抛', async () => {
      const m = makeStandbyManager(hostDeps())
      await m.ensureAwake('asr')
      let calls = 0
      await expect(
        m.withAwake('asr', async () => {
          calls += 1
          const e = new Error('cyclic') as Error & { cause?: unknown }
          e.cause = e // 自环 —— 曾经会让 isConnectFailure 的 for 循环永不终止
          throw e
        }),
      ).rejects.toThrow('cyclic')
      expect(calls).toBe(1) // 判定为非连接层失败,原样上抛、不重试
    })
    it('对质发现容器活着且口没变 → 原样上抛,不循环', async () => {
      const m = makeStandbyManager(hostDeps({
        docker: {
          ...NOT_USED_BY_STANDBY,
          ping: async () => true,
          listByService: async () => [{ Id: 'c1', State: 'running', Names: ['/asr'] }],
          start: async () => {},
          stop: async () => {},
          inspectHostPort: async () => 44728,   // 口始终没变
        },
      }))
      await m.ensureAwake('asr')
      let calls = 0
      const boom = () => { const e = new Error('x'); (e as Error & { cause?: unknown }).cause = { code: 'ECONNRESET' }; throw e }
      await expect(m.withAwake('asr', async () => { calls += 1; boom() })).rejects.toThrow('x')
      expect(calls).toBe(1)  // 口没变,连重试都不给(重试同一个死法没有意义)
    })
    it('B 晚失败、A 已恢复完 → B 跳过对质直接重试成功(originBefore 对比)', async () => {
      let containerState = 'exited'
      let port = 44728
      let startCalls = 0
      const bDelay = gate()
      const deps = hostDeps({
        docker: {
          ...NOT_USED_BY_STANDBY,
          ping: async () => true,
          listByService: async () => [{ Id: 'c1', State: containerState, Names: ['/asr'] }],
          start: async () => { startCalls += 1; containerState = 'running'; if (startCalls > 1) port = 45712 },
          stop: async () => { containerState = 'exited' },
          inspectHostPort: async () => port,
        },
      })
      const m = makeStandbyManager(deps)
      await m.ensureAwake('asr') // awake,origin 44728(startCalls=1)
      containerState = 'exited'  // 容器在背后死了,两个调用都会撞上这个僵尸口

      let aCalls = 0
      let bCalls = 0
      // B 的第一次失败故意延后到 A 已经恢复完成之后 —— originBefore 快照(A、B 都在
      // A 恢复之前捕获,值都是 44728)是关键:B 真正抛错时 cell.origin 早被 A 刷新成
      // 45712,catch 里 originBefore(44728) !== cell.origin(45712),应直接重试、
      // 不再走 reconcileDeadPort(晚到对质会误判)。
      const bPromise = m.withAwake('asr', async () => {
        bCalls += 1
        if (bCalls === 1) {
          await bDelay.wait
          const e = new Error('fetch failed') as Error & { cause?: unknown }
          e.cause = { code: 'ECONNREFUSED' }
          throw e
        }
        return 'b-done'
      })
      const aPromise = m.withAwake('asr', async () => {
        aCalls += 1
        if (aCalls === 1) {
          const e = new Error('fetch failed') as Error & { cause?: unknown }
          e.cause = { code: 'ECONNREFUSED' }
          throw e
        }
        return 'a-done'
      })
      await expect(aPromise).resolves.toBe('a-done') // A 走完整套"对质→重唤醒→重试"
      expect(m.origin('asr')).toBe('http://127.0.0.1:45712')
      bDelay.release() // 现在放 B 失败:此刻 origin 早已不是 B 的 originBefore
      await expect(bPromise).resolves.toBe('b-done')
      expect(startCalls).toBe(2) // 只有 A 触发过一次恢复性重启,B 没有再触发一次
    })
    it('并发撞僵尸口:恢复只跑一次(第二个等第一个的 in-flight)', async () => {
      let startCalls = 0
      let containerState = 'exited'
      let port = 44728
      let recovered = false // 第一次冷启动 port 沿用 44728,只有死后重启(本条测试要观测的那次)才换发新口
      const m = makeStandbyManager(hostDeps({
        docker: {
          ...NOT_USED_BY_STANDBY,
          ping: async () => true,
          listByService: async () => [{ Id: 'c1', State: containerState, Names: ['/asr'] }],
          start: async () => { startCalls += 1; containerState = 'running'; if (recovered) port = 45712 },
          stop: async () => {},
          inspectHostPort: async () => port,
        },
      }))
      await m.ensureAwake('asr')
      startCalls = 0
      containerState = 'exited'
      recovered = true
      const fn = async () => {
        if (m.origin('asr') === 'http://127.0.0.1:44728') {
          const e = new Error('fetch failed'); (e as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' }; throw e
        }
        return m.origin('asr')
      }
      const [a, b] = await Promise.all([m.withAwake('asr', fn), m.withAwake('asr', fn)])
      expect(a).toBe('http://127.0.0.1:45712')
      expect(b).toBe('http://127.0.0.1:45712')
      expect(startCalls).toBe(1)   // ensureAwake 的 starting/inflight 共享保证 start 只发一次
    })
  })
})

// pluginTarget 答空时的只读对质（spec 2026-08-19-plugin-target-empty-observability）：
// 缓存说什么 + Docker 本人说什么，两个数并排摆着才分得清「没醒」和「缓存陈旧」。
describe('diagnose（只读对质，不唤醒、不改状态）', () => {
  const hostSpec = {
    service: 'asr', idleMinutes: 10, startTimeoutSeconds: 5,
    hostProbe: { containerPort: 9000, healthPath: '/health' },
    aliases: ['sherpa'],
  }
  function mk(over: Partial<DockerClient> = {}, services: StandbyManagerDeps['services'] = [hostSpec]) {
    const docker: DockerClient = {
      ...NOT_USED_BY_STANDBY,
      ping: async () => true,
      listByService: async () => [{ Id: 'c1', State: 'exited', Names: ['/asr'] }],
      start: async () => {},
      stop: async () => {},
      inspectHostPort: async () => 44728,
      ...over,
    }
    let t = 0
    return makeStandbyManager({ docker, services, now: () => (t += 10), probeHealth: async () => true, pollMs: 1, log: () => {} })
  }

  it('睡着 + 容器 exited：缓存无口，Docker 说 stopped', async () => {
    const d = await mk().diagnose('asr')
    expect(d).toMatchObject({
      service: 'asr', managed: true, state: 'asleep', cachedOrigin: null,
      container: 'stopped', containerId: 'c1', hostPort: null,
    })
  })

  it('容器 running：现场 inspect 出宿主口 —— 与 cachedOrigin 并排，缓存陈旧一眼可判', async () => {
    const m = mk({
      listByService: async () => [{ Id: 'c1', State: 'running', Names: ['/asr'] }],
      inspectHostPort: async () => 46192,
    })
    const d = await m.diagnose('asr')
    expect(d.container).toBe('running')
    expect(d.hostPort).toBe(46192)
    expect(d.cachedOrigin).toBeNull() // cell 还没醒过 → 就是「容器活着而 standby 不知道」那一格
  })

  it('唤醒过之后 cachedOrigin 有值，状态是 awake', async () => {
    const m = mk({ inspectHostPort: async () => 44728 })
    await m.ensureAwake('asr')
    const d = await m.diagnose('asr')
    expect(d.state).toBe('awake')
    expect(d.cachedOrigin).toBe('http://127.0.0.1:44728')
  })

  it('容器不存在 → absent', async () => {
    const d = await mk({ listByService: async () => [] }).diagnose('asr')
    expect(d.container).toBe('absent')
    expect(d.containerId).toBeNull()
  })

  it('别名也查得到同一个 cell', async () => {
    const d = await mk().diagnose('sherpa')
    expect(d.managed).toBe(true)
    expect(d.state).toBe('asleep')
  })

  it('名册里没有它 → managed:false、state:null，但仍去问 Docker（"名单漏了它"要能和"容器没建"分开）', async () => {
    const d = await mk({ listByService: async () => [{ Id: 'zz', State: 'running', Names: ['/nope'] }] }).diagnose('nope')
    expect(d.managed).toBe(false)
    expect(d.state).toBeNull()
    expect(d.container).toBe('running')
  })

  it('docker 抛 → container:unknown，错误原文进 note（"为什么取不到"本身就是要记的字段）', async () => {
    const d = await mk({ listByService: async () => { throw new Error('boom') } }).diagnose('asr')
    expect(d.container).toBe('unknown')
    expect(d.note).toContain('boom')
  })

  it('spec 没有 hostProbe（compose 档）→ hostPort 为 null 且 note 说明原因,不是"取不到口"', async () => {
    const m = mk({ listByService: async () => [{ Id: 'c1', State: 'running', Names: ['/vp'] }] }, [SPEC])
    const d = await m.diagnose('voiceprint')
    expect(d.hostPort).toBeNull()
    expect(d.note).toMatch(/hostProbe/)
  })

  it('绝不改变 cell 状态、绝不唤醒容器', async () => {
    const started: string[] = []
    const m = mk({
      listByService: async () => [{ Id: 'c1', State: 'running', Names: ['/asr'] }],
      start: async (id) => { started.push(id) },
    })
    await m.diagnose('asr')
    expect(started).toEqual([])
    expect(m.snapshot()[0].state).toBe('asleep')
    expect(m.origin('asr')).toBeNull()
  })
})

describe('standby hook', () => {
  afterEach(() => setStandbyManager(null)) // 断言抛出时也要还原,别把 fake 泄漏给别的测试

  // MINOR E:hook 曾经还导出过 ensureAwake,五个调用点全部走 withAwake 之后它没人用了,已删。
  // 这条测试原本一并覆盖它,现在只留 withAwake/snapshot 两条真在用的路。
  it('no-op when unwired; delegates when wired', async () => {
    setStandbyManager(null)
    expect(standbySnapshot()).toEqual([])
    const calls: string[] = []
    setStandbyManager({
      ensureAwake: async (s) => void calls.push(s),
      withAwake: async (s, fn) => { calls.push(`with:${s}`); return fn() },
      adopt: async () => {}, tick: async () => {}, shutdown: async () => {}, snapshot: () => [], origin: () => null,
      managed: () => false,
      diagnose: async (s) => ({ service: s, managed: false, state: null, cachedOrigin: null, container: 'unknown', containerId: null, hostPort: null }),
    })
    await expect(hookWithAwake('voiceprint', async () => 7)).resolves.toBe(7)
    expect(calls).toEqual(['with:voiceprint'])
  })
  it('withAwake on an unwired hook just runs fn', async () => {
    setStandbyManager(null)
    await expect(hookWithAwake('voiceprint', async () => 'ran')).resolves.toBe('ran')
  })
})
