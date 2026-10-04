import { describe, it, expect, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTaskCenter, stopTaskCenter, addTask, removeTask, runTaskNow } from './center.ts'
import { taskRegistry } from './registry.ts'
import { WATCHDOG_ID } from './watchdog.ts'
import type { ScheduledTask } from './types.ts'

const dbPath = () => join(mkdtempSync(join(tmpdir(), 'center-dyn-')), 'sq.sqlite')

/** watchdog 装配需要能真的开起 sidequest 账本(readonly)——不建表就在 try/catch 里静默
 *  disabled,测不到真正的 listTasks/enqueue 闭包。照实测 schema 建一张空表即可(没有行 →
 *  MAX(inserted_at) 为 null,COUNT(*) 为 0,即"从未入队过、没有存活 job")。 */
function seedEmptyLedger(path: string): void {
  const db = new Database(path)
  db.exec(`CREATE TABLE sidequest_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL DEFAULT 'default',
    class TEXT NOT NULL DEFAULT 'StreamTaskJob', script TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL, constructor_args TEXT NOT NULL DEFAULT '[]',
    result TEXT, errors TEXT, state TEXT NOT NULL,
    available_at INTEGER, inserted_at INTEGER NOT NULL, attempted_at INTEGER,
    completed_at INTEGER, failed_at INTEGER, canceled_at INTEGER, claimed_at INTEGER,
    claimed_by TEXT, attempt INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1)`)
  db.close()
}

function fakeSidequest() {
  const destroy = vi.fn()
  const scheduled: Array<{ cron: string; id: string }> = []
  const enqueued: string[] = []
  const facade = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    build: () => ({
      queue: vi.fn(), maxAttempts: vi.fn(), retryDelay: vi.fn(),
      unique: vi.fn(), scheduleOptions: vi.fn(),
      schedule: async (cron: string, id: string) => { scheduled.push({ cron, id }); return { destroy } },
      enqueue: async (id: string) => { enqueued.push(id); return {} },
    }),
  }
  return { facade, destroy, scheduled, enqueued }
}

const task = (id: string, schedule = '0 * * * * *'): ScheduledTask => ({
  id, label: id, schedule, serial: false, maxAttempts: 1,
  run: async () => ({ summary: 'ok' }),
})

const T = (s: string) => new Date(s).getTime()

afterEach(async () => { await stopTaskCenter(); vi.useRealTimers() })

describe('调度中心动态增删改', () => {
  it('addTask 之后任务在注册表里，且注册了 cron', async () => {
    const f = fakeSidequest()
    await startTaskCenter([], { dbPath: dbPath(), log: () => {}, sidequest: f.facade as never, jobClass: class {}, watchdog: false })
    await addTask(task('t1', '0 0 3 * * *'))
    expect(taskRegistry.get('t1')?.label).toBe('t1')
    expect(f.scheduled).toContainEqual({ cron: '0 0 3 * * *', id: 't1' })
  })

  it('同 id 再 addTask = 改排期：旧 cron 被 destroy，新 cron 注册上', async () => {
    const f = fakeSidequest()
    await startTaskCenter([], { dbPath: dbPath(), log: () => {}, sidequest: f.facade as never, jobClass: class {}, watchdog: false })
    await addTask(task('t1', '0 0 3 * * *'))
    await addTask(task('t1', '0 30 9 * * *'))
    expect(f.destroy).toHaveBeenCalledTimes(1)
    expect(f.scheduled.at(-1)).toEqual({ cron: '0 30 9 * * *', id: 't1' })
    expect(taskRegistry.get('t1')?.schedule).toBe('0 30 9 * * *')
  })

  it('removeTask 停掉 cron 并出注册表；删不存在的返回 false', async () => {
    const f = fakeSidequest()
    await startTaskCenter([], { dbPath: dbPath(), log: () => {}, sidequest: f.facade as never, jobClass: class {}, watchdog: false })
    await addTask(task('t1'))
    expect(await removeTask('t1')).toBe(true)
    expect(f.destroy).toHaveBeenCalledTimes(1)
    expect(taskRegistry.has('t1')).toBe(false)
    expect(await removeTask('t1')).toBe(false)
  })

  it('runTaskNow 立即入队一次', async () => {
    const f = fakeSidequest()
    await startTaskCenter([task('t1')], { dbPath: dbPath(), log: () => {}, sidequest: f.facade as never, jobClass: class {}, watchdog: false })
    expect(await runTaskNow('t1')).toBe(true)
    expect(f.enqueued).toEqual(['t1'])
    expect(await runTaskNow('nope')).toBe(false)
  })

  it('中心没起来时 addTask 不抛——降级同 startTaskCenter 的守卫', async () => {
    await stopTaskCenter()
    await expect(addTask(task('t1'))).resolves.toBeUndefined()
  })

  it('同 id 并发两次 addTask 序列化——恰好一条活的 cron 存活，输家被 destroy', async () => {
    const destroyA = vi.fn()
    const destroyB = vi.fn()
    let scheduleCalls = 0
    let resolveA!: () => void
    const deferredA = new Promise<void>((r) => { resolveA = r })
    const facade = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      build: () => ({
        queue: vi.fn(), maxAttempts: vi.fn(), retryDelay: vi.fn(), unique: vi.fn(), scheduleOptions: vi.fn(),
        // 第一次 schedule() 调用（A 那次）卡在 deferredA 上不提前完成——不用真定时器，靠
        // 谁先调用 schedule() 来分辨"谁是 A"：没有序列化的话 B 会在 A 卡住期间抢先调用
        // schedule() 并把 cronHandles 先落成 B，A 醒来后再把它覆盖回 A——谁活谁死全看
        // 谁的 schedule() 后决议，不是谁先发起调用。
        schedule: async (_cron: string, _id: string) => {
          scheduleCalls += 1
          if (scheduleCalls === 1) { await deferredA; return { destroy: destroyA } }
          return { destroy: destroyB }
        },
        enqueue: vi.fn(),
      }),
    }
    await startTaskCenter([], { dbPath: dbPath(), log: () => {}, sidequest: facade as never, jobClass: class {}, watchdog: false })

    const pA = addTask(task('t1', '0 0 3 * * *'))
    const pB = addTask(task('t1', '0 0 9 * * *'))
    resolveA()
    await Promise.all([pA, pB])

    // 序列化：B 严格等 A 的整条链（含 destroy 旧句柄、schedule 新句柄）做完才起步，所以
    // schedule() 只会按 A→B 的顺序各调用一次——不会有第三次因竞态触发的重复调用。
    expect(scheduleCalls).toBe(2)
    expect(destroyA).toHaveBeenCalledTimes(1) // A 的句柄被 B 的 removeTaskLocked 收掉
    expect(destroyB).not.toHaveBeenCalled() // B 活着，没被谁再顶掉
    expect(taskRegistry.get('t1')?.schedule).toBe('0 0 9 * * *')
  })
})

describe('watchdog 读活的 taskRegistry，不是启动快照', () => {
  it('改排期按新排期判丢班；删除后不再被纠缠；真丢班的任务照样补', async () => {
    const f = fakeSidequest()
    const path = dbPath()
    seedEmptyLedger(path)
    vi.useFakeTimers()
    vi.setSystemTime(T('2026-08-01T09:01:00+08:00'))
    // t1 以旧排期(每天 03:00)随启动快照登记——这正是 bug 里 watchdog 会一直记着的那份。
    // t2 以每天 08:00 登记且从未入过队：此刻 09:01，槽点(08:00)已过 61 分钟，早出 90s grace，
    // 是这条测试里唯一"真丢班"的任务——用来证明 watchdog 不是一个空转的摆设。
    await startTaskCenter([task('t1', '0 0 3 * * *'), task('t2', '0 0 8 * * *')], {
      dbPath: path, log: () => {}, sidequest: f.facade as never, jobClass: class {},
    })
    const watchdogTask = taskRegistry.get(WATCHDOG_ID)!

    // 运行期改排期为每天 09:00：此刻 09:01，新排期的槽 1 分钟前才过，还在 90s 自愈 grace 窗内，
    // 不该被判丢班。若 watchdog 仍按启动快照里的旧排期(03:00，6 小时前，早出 grace)判，
    // 会误判丢班并把它塞进补跑队列。
    await addTask(task('t1', '0 0 9 * * *'))
    await watchdogTask.run({ log: () => {} })
    expect(f.enqueued).not.toContain('t1')
    // t2 从未改排期、从未入队，08:00 的槽早出 grace——watchdog 该把它判丢班并补跑。
    // 这条断言不成立的话，上面 t1 的"没被误判"就可能只是因为 watchdog 压根没在管任何任务。
    expect(f.enqueued).toContain('t2')

    // 删除任务：旧排期(03:00)的槽早就出 grace。若 watchdog 仍读启动快照(从未被 removeTask
    // 改过)，会把一条已经不存在的任务判成丢班、反复补跑成"unknown task"告警。
    f.enqueued.length = 0
    await removeTask('t1')
    await removeTask('t2')
    await watchdogTask.run({ log: () => {} })
    expect(f.enqueued).not.toContain('t1')
    expect(f.enqueued).not.toContain('t2')
  })

  /**
   * 全新库首启那一幕的端到端版（2026-09-04 活体，复现率 100%）：watchdog 一轮里补跑好几条
   * 丢班任务，其中一条撞上 sidequest 的去重（`Job #undefined - StreamTaskJob is duplicated`）。
   *
   * 这条走的是 center 里真正的 enqueue 闭包（不是 watchdog 的假 deps），所以它同时钉住两件事：
   * center 把 DuplicatedJobError 翻译成 `already-queued`，watchdog 拿到它不当失败。
   */
  it('补跑撞上 sidequest 去重时：这一轮不失败，后面的任务照补', async () => {
    class DuplicatedJobError extends Error {
      constructor() { super('Job #undefined - StreamTaskJob is duplicated') }
    }
    const f = fakeSidequest()
    const path = dbPath()
    seedEmptyLedger(path)
    vi.useFakeTimers()
    vi.setSystemTime(T('2026-08-01T09:01:00+08:00'))
    const enqueued: string[] = []
    const facade = {
      ...f.facade,
      build: () => ({
        queue: vi.fn(), maxAttempts: vi.fn(), retryDelay: vi.fn(),
        unique: vi.fn(), scheduleOptions: vi.fn(),
        schedule: async (cron: string, id: string) => { f.scheduled.push({ cron, id }); return { destroy: f.destroy } },
        enqueue: async (id: string) => {
          if (id === 't2') throw new DuplicatedJobError()
          enqueued.push(id)
          return {}
        },
      }),
    }
    // 三条每天 08:00 的任务，此刻 09:01——全都早出 90s grace，都判丢班。
    await startTaskCenter([task('t1', '0 0 8 * * *'), task('t2', '0 0 8 * * *'), task('t3', '0 0 8 * * *')], {
      dbPath: path, log: () => {}, sidequest: facade as never, jobClass: class {},
    })
    const out = await taskRegistry.get(WATCHDOG_ID)!.run({ log: () => {} })
    // 修之前：t2 那一下把整轮 throw 掉，t3 这一分钟根本轮不上。
    expect(enqueued).toEqual(['t1', 't3'])
    expect(out.detail).toMatchObject({ requeued: ['t1', 't3'], alreadyQueued: ['t2'] })
  })
})

/**
 * 关停必须把 cron **摘掉**，不能只丢引用。只 clear map 的话那条 node-cron 计划照样按点触发，
 * 而且再没有任何东西持有它——进程内 stop→start（这份文件的 afterEach 每条用例之间就在这么干）
 * 会让孤儿 cron 和新 cron 并存，同一个槽点触发两次。调度中心今天挂着真下单的任务，
 * `serial: true` 的 uniqueness "大概率"挡得住第二次——那是赌，不是安全垫。
 */
describe('关停/启动失败回滚：cron 必须被 destroy，不是丢引用', () => {
  it('stopTaskCenter 逐条 destroy 全部 cron，并清空注册表', async () => {
    const f = fakeSidequest()
    await startTaskCenter([task('t1'), task('t2')], {
      dbPath: dbPath(), log: () => {}, sidequest: f.facade as never, jobClass: class {}, watchdog: false,
    })
    expect(f.scheduled).toHaveLength(2)
    expect(f.destroy).not.toHaveBeenCalled()

    await stopTaskCenter()

    // 两条都摘了——只 clear map 的实现会停在 0。
    expect(f.destroy).toHaveBeenCalledTimes(2)
    // 停了的中心还从 listTasks() 报任务是假的；watchdog 正好读它。
    expect(taskRegistry.size).toBe(0)
  })

  it('一条 destroy 抛错不该让其余的留成孤儿', async () => {
    const f = fakeSidequest()
    f.destroy.mockImplementationOnce(() => { throw new Error('boom') })
    await startTaskCenter([task('t1'), task('t2'), task('t3')], {
      dbPath: dbPath(), log: () => {}, sidequest: f.facade as never, jobClass: class {}, watchdog: false,
    })
    await expect(stopTaskCenter()).resolves.toBeUndefined()
    expect(f.destroy).toHaveBeenCalledTimes(3)
  })

  // 这条路**生产会走**：start 走到一半才失败时，前面 scheduleOne 成功的那几条已经在 map 里。
  // 不 destroy 就地变孤儿，而日志只说了句 "task center disabled"，读起来像干净地放弃了。
  it('start 中途失败：已注册的 cron 一并 destroy，不留孤儿', async () => {
    const f = fakeSidequest()
    let n = 0
    const facade = {
      ...f.facade,
      build: () => ({
        queue: vi.fn(), maxAttempts: vi.fn(), retryDelay: vi.fn(),
        unique: vi.fn(), scheduleOptions: vi.fn(),
        schedule: async (cron: string, id: string) => {
          // 第三条炸——前两条的句柄此刻已经在 cronHandles 里了。
          if (++n === 3) throw new Error('schedule boom')
          f.scheduled.push({ cron, id })
          return { destroy: f.destroy }
        },
        enqueue: async () => ({}),
      }),
    }
    const r = await startTaskCenter([task('a'), task('b'), task('c')], {
      dbPath: dbPath(), log: () => {}, sidequest: facade as never, jobClass: class {}, watchdog: false,
    })
    expect(r.ok).toBe(false)
    expect(f.destroy).toHaveBeenCalledTimes(2)
    expect(taskRegistry.size).toBe(0)
  })
})

/**
 * `addTask` 从"中心还活着吗"问到真正写下 taskRegistry/cronHandles 之间隔着好几个 await，
 * stopTaskCenter 可以整个落在中间。这两条用例把 stop **真的**塞进那两个窗口里各跑一次
 * （不是"stop 之后再 addTask 会不会被拒"——那是另一回事，也不是这个 bug）。
 */
describe('stop 落在 addTask 中间：这一次登记必须整体作废', () => {
  const tick = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() }

  it('卡在「摘旧 cron」里时 stop 跑完——不留下"有注册表行、没有 cron"的任务', async () => {
    let releaseDestroy!: () => void
    const destroyGate = new Promise<void>((r) => { releaseDestroy = r })
    const scheduled: string[] = []
    let destroyCalls = 0
    const facade = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      build: () => ({
        queue: vi.fn(), maxAttempts: vi.fn(), retryDelay: vi.fn(), unique: vi.fn(), scheduleOptions: vi.fn(),
        schedule: async (_cron: string, id: string) => {
          scheduled.push(id)
          // 摘这条旧 cron 时卡住——addTask 就停在 removeTaskLocked 的那个 await 上。
          return { destroy: async () => { destroyCalls += 1; await destroyGate } }
        },
        enqueue: vi.fn(),
      }),
    }
    await startTaskCenter([task('t1', '0 0 3 * * *')], {
      dbPath: dbPath(), log: () => {}, sidequest: facade as never, jobClass: class {}, watchdog: false,
    })

    const adding = addTask(task('t1', '0 30 9 * * *')) // 改排期
    await tick()
    expect(destroyCalls).toBe(1) // 确认它真的停在那个 await 上，而不是早就跑完了

    await stopTaskCenter() // 中心整个拆掉：cron 摘净、注册表清空
    expect(taskRegistry.size).toBe(0)

    releaseDestroy()
    await adding

    // 没有原子闸时这里是 1：一条谁也不会触发、却被 watchdog 当成"丢班"反复补跑的幽灵任务。
    expect(taskRegistry.size).toBe(0)
    expect(scheduled).toEqual(['t1']) // 停机之后不该再建新 cron
  })

  it('卡在「建新 cron」里时 stop 跑完——新建的 cron 不能留成摘不掉的孤儿', async () => {
    let releaseSchedule!: () => void
    const scheduleGate = new Promise<void>((r) => { releaseSchedule = r })
    const lateDestroy = vi.fn()
    const facade = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      build: () => ({
        queue: vi.fn(), maxAttempts: vi.fn(), retryDelay: vi.fn(), unique: vi.fn(), scheduleOptions: vi.fn(),
        schedule: async () => { await scheduleGate; return { destroy: lateDestroy } },
        enqueue: vi.fn(),
      }),
    }
    await startTaskCenter([], {
      dbPath: dbPath(), log: () => {}, sidequest: facade as never, jobClass: class {}, watchdog: false,
    })

    const adding = addTask(task('t1'))
    await tick()
    await stopTaskCenter() // destroyAllCrons 此刻还看不见这条——它还没被 schedule 出来

    releaseSchedule()
    await adding

    // 没有原子闸时这条句柄会在 stop 之后被塞进 cronHandles：cron 活着按点触发，而再没有
    // 任何东西持有它（只能重启进程收）。
    expect(lateDestroy).toHaveBeenCalledTimes(1)
    expect(taskRegistry.size).toBe(0)
  })
})
