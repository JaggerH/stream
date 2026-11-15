import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TaskCenter, queueOf, silenceSidequestConsole } from './center.ts'
import type { ScheduledTask } from './types.ts'

/** 每条用例一个新中心（一个实例一个，见 center.ts 头注）。 */
let c = new TaskCenter()
beforeEach(() => { c = new TaskCenter() })

function fakeSidequest() {
  const calls: Record<string, unknown[]> = { schedule: [], createQueue: [], enqueue: [] }
  const builder = {
    queue: vi.fn().mockReturnThis(), maxAttempts: vi.fn().mockReturnThis(),
    retryDelay: vi.fn().mockReturnThis(), unique: vi.fn().mockReturnThis(),
    scheduleOptions: vi.fn().mockReturnThis(),
    schedule: vi.fn(async (cron: string, taskId: string) => { calls.schedule.push([cron, taskId]) }),
    enqueue: vi.fn(async (taskId: string) => { calls.enqueue.push(taskId) }),
  }
  return {
    facade: {
      start: vi.fn(async () => {}),
      // 运行期建队列：互斥组的队列是用户现敲出来的，静态 queues 里没有它
      createQueue: vi.fn(async (name: string, concurrency: number) => { calls.createQueue.push([name, concurrency]) }),
      build: vi.fn(() => builder),
      stop: vi.fn(async () => {}),
    },
    builder, calls,
  }
}

const mkTask = (over: Partial<ScheduledTask>): ScheduledTask => ({
  id: 't1', label: 'T1', schedule: '0 */5 * * * *', serial: false, maxAttempts: 3,
  run: async () => ({ summary: 'ok' }), ...over,
})

describe('startTaskCenter', () => {
  beforeEach(() => c.registry.clear())
  // 每条用例之后都要关停：`whenBusy: 'skip'` 那一档是我们自己持的 node-cron，
  // 不摘掉的话它带着真定时器活到下一条用例里（`destroyAllCrons` 头注说的正是这件事）。
  afterEach(async () => { await c.stop() })

  // sidequest 缺省会在 SIGINT/SIGTERM 上挂自己的「关引擎 → process.exit(0)」，跟宿主的优雅关竞速：
  // 它先退，宿主那条 quiesceKernel（关库、还标签、放数据目录锁）就没跑完。信号归宿主，sidequest 不许挂。
  it('不让 sidequest 自己挂进程信号（gracefulShutdown: false）', async () => {
    const { facade } = fakeSidequest()
    await c.start([mkTask({})], { dbPath: '/tmp/x.sqlite', log: () => {}, sidequest: facade as never })
    expect(facade.start).toHaveBeenCalledWith(expect.objectContaining({ gracefulShutdown: false }))
  })

  it('starts engine with inline no-fork sqlite and schedules each task', async () => {
    const { facade, builder, calls } = fakeSidequest()
    const r = await c.start([mkTask({}), mkTask({ id: 't2', serial: true })], {
      dbPath: '/tmp/x.sqlite', log: () => {}, sidequest: facade as never,
    })
    expect(r.ok).toBe(true)
    expect(facade.start).toHaveBeenCalledWith(expect.objectContaining({
      fork: false, runner: 'inline',
      backend: { driver: '@sidequest/sqlite-backend', config: '/tmp/x.sqlite' },
      queues: expect.arrayContaining([
        expect.objectContaining({ name: 'default' }),
        expect.objectContaining({ name: 'serial', concurrency: 1 }),
      ]),
    }))
    expect(calls.schedule).toEqual([['0 */5 * * * *', 't1'], ['0 */5 * * * *', 't2']])
    expect(builder.maxAttempts).toHaveBeenCalledWith(3)
    // serial 任务：存活唯一（上轮没完 → 本次拒入队 = 这一条不叠着自己跑）。
    // `withArgs` 是这条语义成立的前提（所有任务共用一个 job 类，taskId 只在 args 里）——
    // 语义那一端由 center.uniqueness.test.ts 用 sidequest 自己的 digest 钉着。
    expect(builder.unique).toHaveBeenCalledWith({ withArgs: true })
    // 每个任务都必须带放宽的 missed 容差——默认 1s 在这个重进程里等于任务永不执行(活体实测)
    expect(builder.scheduleOptions).toHaveBeenCalledWith(
      expect.objectContaining({ missedExecutionTolerance: 30_000 }),
    )
  })

  it('降级守卫：引擎起不来 → {ok:false} + 日志，不 throw', async () => {
    const log = vi.fn()
    const { facade } = fakeSidequest()
    facade.start.mockRejectedValueOnce(new Error('port taken'))
    const r = await c.start([mkTask({})], { dbPath: '/tmp/x.sqlite', log, sidequest: facade as never })
    expect(r.ok).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('task center disabled'))
  })

  it('注册进 c.registry，重复启动前先清旧表', async () => {
    const { facade } = fakeSidequest()
    await c.start([mkTask({})], { dbPath: '/tmp/x.sqlite', log: () => {}, sidequest: facade as never })
    expect(c.registry.has('t1')).toBe(true)
  })

  it('一行撞 id 的任务只丢它自己，其余照常起——不因一行坏的拖垮整个中心', async () => {
    const log = vi.fn()
    const { facade, calls } = fakeSidequest()
    const r = await c.start(
      [mkTask({ id: 'cookie-refresh' }), mkTask({ id: 'cookie-refresh', label: '撞名的用户行' }), mkTask({ id: 't2' })],
      { dbPath: '/tmp/x.sqlite', log, sidequest: facade as never },
    )
    expect(r.ok).toBe(true)
    // 先出现的那条（builtin，按调用方约定排在前面）保留、排上期；后来者被丢弃、不排期
    expect(calls.schedule).toEqual([['0 */5 * * * *', 'cookie-refresh'], ['0 */5 * * * *', 't2']])
    expect(c.registry.get('cookie-refresh')?.label).toBe('T1')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('丢弃重名任务 "cookie-refresh"'))
  })

  it('start 成功但 schedule 失败 → 停止已启动引擎，返回 {ok:false}', async () => {
    const log = vi.fn()
    const { facade, builder } = fakeSidequest()
    builder.schedule.mockRejectedValueOnce(new Error('bad cron'))
    const r = await c.start([mkTask({})], {
      dbPath: '/tmp/x.sqlite', log, sidequest: facade as never,
    })
    expect(r.ok).toBe(false)
    expect(facade.stop).toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('task center disabled'))
  })
})

describe('互斥组 → 队列', () => {
  beforeEach(() => c.registry.clear())
  afterEach(async () => { await c.stop() })

  it('队列名只由 exclusiveOn 定：有 → x:<组名>，没有 → default', () => {
    expect(queueOf({ exclusiveOn: 'netdisk' })).toBe('x:netdisk')
    expect(queueOf({})).toBe('default')
    expect(queueOf({ exclusiveOn: '' })).toBe('default')
    // 有人把互斥组起名叫 default 也不该掉进公共队列——前缀就是为这个在的
    expect(queueOf({ exclusiveOn: 'default' })).toBe('x:default')
  })

  it('serial 不再决定队列：标了 serial、没写互斥组的任务进 default', async () => {
    const { facade, builder } = fakeSidequest()
    await c.start([mkTask({ serial: true })], {
      dbPath: '/tmp/x.sqlite', log: () => {}, sidequest: facade as never,
    })
    expect(builder.queue).toHaveBeenCalledWith('default')
    expect(builder.queue).not.toHaveBeenCalledWith('serial')
  })

  it('有互斥组 → 运行期把 concurrency 1 的队列建出来，任务排进去', async () => {
    const { facade, builder, calls } = fakeSidequest()
    const r = await c.start(
      [mkTask({ id: 'a', exclusiveOn: 'netdisk' }), mkTask({ id: 'b', exclusiveOn: 'netdisk' })],
      { dbPath: '/tmp/x.sqlite', log: () => {}, sidequest: facade as never },
    )
    expect(r.ok).toBe(true)
    expect(builder.queue).toHaveBeenCalledWith('x:netdisk')
    // 同一组的第二条不再建一次：建过的记着（幂等那一层在 facade 里，这里省的是往返）
    expect(calls.createQueue).toEqual([['x:netdisk', 1]])
    expect(calls.schedule).toEqual([['0 */5 * * * *', 'a'], ['0 */5 * * * *', 'b']])
  })

  it('建不出队列 → 这条任务不排期（不能留一条落账但没人捡的任务）', async () => {
    const log = vi.fn()
    const { facade, calls } = fakeSidequest()
    facade.createQueue.mockRejectedValueOnce(new Error('backend down'))
    const r = await c.start([mkTask({ exclusiveOn: 'jq-bridge' })], {
      dbPath: '/tmp/x.sqlite', log, sidequest: facade as never,
    })
    expect(r.ok).toBe(true) // 一条排不上不该带走整个中心
    expect(calls.schedule).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('建不出队列 x:jq-bridge'))
  })
})

describe('whenBusy', () => {
  beforeEach(() => c.registry.clear())
  afterEach(async () => { await c.stop(); c.resetDeps() })

  const skipTask = mkTask({ id: 'ipo', exclusiveOn: 'broker', whenBusy: 'skip', schedule: '0 45 9 * * *' })

  it("skip：组忙时这一班不入队，且留痕（日志 + 事件）", async () => {
    const log = vi.fn()
    const append = vi.fn()
    c.setDeps({ log: () => {}, events: { append } })
    const { facade, calls } = fakeSidequest()
    await c.start([skipTask], {
      dbPath: '/tmp/x.sqlite', log, sidequest: facade as never,
      queueAlive: (q) => q === 'x:broker',
    })
    await c.runSkipSlot(skipTask, 'x:broker')
    expect(calls.enqueue).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('这一班不跑'))
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.skipped', severity: 'warn' }))
  })

  it('skip：组不忙时照常入队', async () => {
    const { facade, calls } = fakeSidequest()
    await c.start([skipTask], {
      dbPath: '/tmp/x.sqlite', log: () => {}, sidequest: facade as never,
      queueAlive: () => false,
    })
    await c.runSkipSlot(skipTask, 'x:broker')
    expect(calls.enqueue).toEqual(['ipo'])
  })

  it('skip 的节拍器是我们自己持的，不走 sidequest 的 schedule', async () => {
    const { facade, calls } = fakeSidequest()
    await c.start([skipTask, mkTask({ id: 'backfill', exclusiveOn: 'broker' })], {
      dbPath: '/tmp/x.sqlite', log: () => {}, sidequest: facade as never, queueAlive: () => false,
    })
    // 默认的 queue 档仍走 sidequest 的 schedule；skip 档不在里面（它到点要先问一句忙不忙）
    expect(calls.schedule).toEqual([['0 */5 * * * *', 'backfill']])
  })

  it('queue（缺省）：组忙也照常入队——排着就是它要的行为', async () => {
    const { facade, calls } = fakeSidequest()
    const queued = mkTask({ id: 'backfill', exclusiveOn: 'broker' })
    await c.start([queued], {
      dbPath: '/tmp/x.sqlite', log: () => {}, sidequest: facade as never,
      queueAlive: () => true, // 组一直忙
    })
    // 走的是 sidequest 自己的 schedule（到点直接落账），没有任何"忙就不入队"的分支
    expect(calls.schedule).toEqual([['0 */5 * * * *', 'backfill']])
  })

  it('读不到账本时按"组不忙"处理：宁可照常入队，也不让一条任务安静地再也不跑', async () => {
    const log = vi.fn()
    const { facade, calls } = fakeSidequest()
    await c.start([skipTask], {
      dbPath: '/definitely/not/a/real/path.sqlite', log, sidequest: facade as never,
    })
    await c.runSkipSlot(skipTask, 'x:broker')
    expect(calls.enqueue).toEqual(['ipo'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('读不到账本'))
  })

  it('启动巡检：终态行还带着 unique_digest 的清掉并记一行日志（不然那条任务永远"排着队"）', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbPath = join(mkdtempSync(join(tmpdir(), 'center-digest-')), 'sq.sqlite')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE sidequest_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, args TEXT NOT NULL,
      state TEXT NOT NULL, inserted_at INTEGER NOT NULL, errors TEXT, failed_at INTEGER, unique_digest TEXT)`)
    db.prepare("INSERT INTO sidequest_jobs (args, state, inserted_at, unique_digest) VALUES ('[\"t1\"]', 'completed', 1, 'stale')").run()
    db.close()
    const log = vi.fn()
    const { facade } = fakeSidequest()
    await c.start([mkTask({})], { dbPath, log, sidequest: facade as never })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 条已结束的执行还带着 unique_digest'))
    const after = new Database(dbPath, { readonly: true })
    expect(after.prepare('SELECT unique_digest FROM sidequest_jobs').get()).toEqual({ unique_digest: null })
    after.close()
  })

  it('runningTasks：读账本里 state=running 的行、按 registry 补 label；中心没起 / 停了 → 空', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    expect(await c.runningTasks()).toEqual([])   // 中心没起：没有可打断的东西
    const dbPath = join(mkdtempSync(join(tmpdir(), 'center-running-')), 'sq.sqlite')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE sidequest_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, args TEXT NOT NULL,
      state TEXT NOT NULL, inserted_at INTEGER NOT NULL, errors TEXT, failed_at INTEGER, unique_digest TEXT)`)
    const { facade } = fakeSidequest()
    await c.start([mkTask({ id: 't1', label: '东财登录' })], { dbPath, log: vi.fn(), sidequest: facade as never, watchdog: false })
    // 行在 start **之后**才落：启动巡检会把上一进程遗留的 running 行判成孤儿收掉，
    // 开机那一刻本来就没有"真在跑"的东西。
    db.prepare("INSERT INTO sidequest_jobs (args, state, inserted_at) VALUES ('[\"t1\"]', 'running', 1)").run()
    db.prepare("INSERT INTO sidequest_jobs (args, state, inserted_at) VALUES ('[\"ghost\"]', 'running', 2)").run()
    db.prepare("INSERT INTO sidequest_jobs (args, state, inserted_at) VALUES ('[\"t1\"]', 'completed', 3)").run()
    db.close()
    // 账本里的 id 不在 registry（已被删的任务）→ label 退化成 id，不丢行
    expect(await c.runningTasks()).toEqual([{ id: 't1', label: '东财登录' }, { id: 'ghost', label: 'ghost' }])
    await c.stop()
    expect(await c.runningTasks()).toEqual([])
  })
})

describe('silenceSidequestConsole', () => {
  // 滤的是「序列化错误对象被 errors() 展开」那一形状。判据的成立前提是 sidequest 自己的
  // format 链（errors({stack:true}) 在前），所以这里用真 winston 复现那条链再套 filter。
  const setup = async () => {
    const { toErrorData } = await import('sidequest')
    const createRequire = (await import('node:module')).createRequire
    const req = createRequire(import.meta.resolve('sidequest'))
    const winston = req('winston') as {
      format: { errors: (o?: unknown) => unknown; timestamp: (o?: unknown) => unknown; colorize: () => unknown; label: (o?: unknown) => unknown; combine: (...f: unknown[]) => unknown; (fn: unknown): unknown }
    }
    // 真链：sidequest buildFormat 的顺序（timestamp→errors→colorize→label）。
    const chain = winston.format.combine(
      winston.format.timestamp({ format: 'x' }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.label({ label: 'Sidequest' }),
    )
    const transport = { silent: false, format: chain as unknown, __slDropFilter: false }
    const lines: string[] = []
    // 链的输出记一行（模拟 Console transport 写 stdout）：filter 放行的才到得了这里。
    const recordFilter = (winston.format as unknown as (fn: (info: Info) => Info) => { (): unknown })((info: Info) => {
      lines.push(String(info.message ?? 'undefined'))
      return info
    })
    ;(transport as unknown as { format: unknown }).format = winston.format.combine(recordFilter(), chain)
    silenceSidequestConsole({ format: winston.format as never, logger: () => ({ transports: [transport] as never }) })
    const fmt = (transport as unknown as { format: { transform: (i: Info) => unknown } }).format.transform
    return { toErrorData, lines, fmt, silentFlag: () => transport.silent }
  }
  type Info = Record<symbol | string, unknown>

  it('滤掉 toErrorData 普通对象（name+stack），保留真 Error（只有 stack）与字符串 error', async () => {
    const { toErrorData, lines, fmt, silentFlag } = await setup()
    // A：job 失败的第 2/3 遍——toErrorData 普通对象经 errors() 展开后 name+stack 都在 → 丢弃
    expect(fmt({ [Symbol.for('level')]: 'error', message: 'task failure', name: 'Error', stack: 'Error: task failure', timestamp: 'x', label: 'Sidequest' })).toBe(false)
    // B：引擎自己的真 Error（errors() 只抄 message/stack，无顶层 name）→ 放行
    const realErr = fmt({ [Symbol.for('level')]: 'error', message: 'engine genuine error', stack: 'Error: engine genuine error', timestamp: 'x' })
    expect(realErr).not.toBe(false)
    expect((realErr as Info).message).toBe('engine genuine error')
    // C：字符串 error（migrate / 队列配置类）→ 放行
    expect(fmt({ [Symbol.for('level')]: 'error', message: 'Backend migrate failed: connection refused', timestamp: 'x' })).not.toBe(false)
    // 非 error 级一律放行（即使形状撞上——info/warn 是引擎的正常日志）
    expect(fmt({ [Symbol.for('level')]: 'info', message: 'Running job #1', name: 'Error', stack: 'x', timestamp: 'x' })).not.toBe(false)
    expect(fmt({ [Symbol.for('level')]: 'warn', message: 'w', name: 'Error', stack: 'x', timestamp: 'x' })).not.toBe(false)
    expect(silentFlag()).toBe(false) // 不再整个静音
    void toErrorData; void lines
  })

  it('端到端：真 winston logger + sidequest format 链 + filter，输出按形态滤/留', async () => {
    const { toErrorData } = await import('sidequest')
    const createRequire = (await import('node:module')).createRequire
    const req = createRequire(import.meta.resolve('sidequest'))
    const winston = req('winston')
    const lines: string[] = []
    // 内存 transport：必须是 winston-transport 的实例（legacy 检查 .on 等），log(info, cb) 接住
    // filter 之后放行的 info（丢弃发生在 format 链上，到不了 log）。
    const WinstonTransport = req('winston-transport').default ?? req('winston-transport')
    class Mem extends WinstonTransport {
      log(info: Info, cb: () => void): void {
        lines.push(String(info.message))
        cb()
      }
    }
    const mem = new Mem()
    // winston-transport 的 _write 读 this.format.transform——logger 的 format 链在 logger 上，
    // transport 自身不需要 format，但该属性必须是带 transform 的形状（winston 3.x 约定）。
    ;(mem as unknown as { format: unknown }).format = winston.format.combine()
    const lg = winston.createLogger({
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'x' }),
        winston.format.errors({ stack: true }),
        winston.format.label({ label: 'Sidequest' }),
      ),
      transports: [mem as never],
    })
    silenceSidequestConsole({ format: winston.format as never, logger: () => ({ transports: [mem] as never }) })
    lg.error(toErrorData(new Error('task failure')))               // 序列化对象 → 滤
    lg.error(new Error('engine genuine error'))                    // 真 Error → 留
    lg.error('Backend migrate failed: connection refused')         // 字符串 → 留
    await new Promise((r) => setTimeout(r, 20))
    expect(lines).toEqual(['engine genuine error', 'Backend migrate failed: connection refused'])
  })

  it('幂等：同一 transport 套两遍不叠加', async () => {
    const req0 = (await import('node:module')).createRequire(import.meta.resolve('sidequest'))
    const winston = req0('winston')
    const transport = { silent: false, format: winston.format.combine() as unknown, __slDropFilter: false }
    const sq = { format: winston.format as never, logger: () => ({ transports: [transport] as never }) }
    silenceSidequestConsole(sq)
    const first = transport.format
    silenceSidequestConsole(sq)
    silenceSidequestConsole(sq)
    expect(transport.format).toBe(first)
  })
})
