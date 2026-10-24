/**
 * 实例的后台工作（openspec `embeddable-engine`，design D1 附注）。
 *
 * 判据是「不挂路由的嵌入方是否也需要它」：订阅要按时采集、任务要按点跑——这些装配块
 * （调度中心、`scheduler.start()`、standby、research watchers、`markInterruptedAtBoot`）
 * 都归实例，`createStream()` 解析时就已经在跑，**不需要调用方再挂路由或调任何 start**。
 * 这里钉的是不调 `routes()` 的那份实例：
 * - 内置任务已登记、调度器已启动、依赖已接；
 * - 一条秒级任务按点触发并跑成；
 * - 全程没有任何端口被监听（spec「调用方自己决定怎么暴露」）；
 * - `config.deployment.scheduler === false` 照旧整体关掉（查询档）。
 *
 * 同进程双实例互不冲突的整体兜底在 `two-instances.test.ts`。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStream, type Stream } from './index.ts'
import { readConfig } from '../bootstrap.ts'
import { BUILTIN_TASK_IDS } from '../tasks/builtin.ts'
import { RunLedger } from '../tasks/run-history.ts'

const roots: string[] = []
const open: Stream[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {})
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** 干净的数据目录 + 空的内置包目录；scheduler 开关显式给（缺省是开的，测试按用例要）。 */
function tempRoot(tag: string, scheduler: boolean): ReturnType<typeof readConfig> {
  const root = mkdtempSync(join(tmpdir(), `stream-bg-${tag}-`))
  roots.push(root)
  const packages = join(root, 'packages')
  mkdirSync(packages)
  const base = readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root })
  return { ...base, packages_dir: packages, rsshub_catalog: '', deployment: { ...base.deployment, scheduler } }
}

const make = async (config: ReturnType<typeof readConfig>) => {
  const s = await createStream({ dataDir: join(config.packages_dir, '..'), config, log: () => {} })
  open.push(s)
  return s
}

const secondLevelTask = (id: string) => ({
  id, label: id,
  schedule: '* * * * * *', // 6 段含秒：每秒一班
  serial: false, whenBusy: 'skip' as const, maxAttempts: 1, enabled: true,
  run: async () => ({ summary: 'tick' }),
})

describe('createStream 的后台工作（不调 routes()）', () => {
  it('内置任务已登记、调度器在跑、任务依赖已接', async () => {
    const s = await make(tempRoot('boot', true))
    expect(s.tasks.depsBound()).toBe(true)
    // 内置任务按本机依赖条件装配（standby-reaper 要 Docker，这台机器没有 → 不在）；
    // 钉两条无条件装配的。watchdog 是 start 自己补注册的丢班自愈任务（id 不在静态名单）。
    const registered = new Set(s.tasks.registry.keys())
    expect(registered, 'cookie-refresh').toContain('cookie-refresh')
    expect(registered, 'jobs-sweep').toContain('jobs-sweep')
    expect(registered, 'watchdog').toContain('schedule-watchdog')
    // 调度器私有状态（测试只读不碰）：start() 把 started 翻真——它就是采集节拍的总闸。
    expect((s.kernel.scheduling.scheduler as unknown as { started: boolean }).started).toBe(true)
  })

  it('一条秒级任务按点触发并跑成（账本记 completed）', async () => {
    const s = await make(tempRoot('tick', true))
    await s.tasks.addTask(secondLevelTask('bg.tick'))
    const ledger = new RunLedger(join(s.stateDir, 'sidequest.sqlite'))
    await new Promise((r) => setTimeout(r, 2500))
    const runs = ledger.runs('bg.tick')
    expect(runs.length).toBeGreaterThan(0)
    // 依赖已接（实例装配），任务不再记 failed——「跑成」而不只是「被调度到」。
    expect(runs.some((r) => r.state === 'completed')).toBe(true)
  })

  it('createStream 不监听任何端口（spec：调用方自己决定怎么暴露）', async () => {
    const s = await make(tempRoot('port', true))
    await s.tasks.addTask(secondLevelTask('bg.port'))
    await new Promise((r) => setTimeout(r, 1200))
    // 实例自身起的资源里不该有 TCP server：watcher 是 fs 的、任务中心是 cron + sqlite、
    // RSSHub worker 是懒起的子进程。TCPServerWrap 只会出现在有人 listen 的那一刻。
    expect(process.getActiveResourcesInfo()).not.toContain('TCPServerWrap')
  })

  it('scheduler=false（查询档）：调度器不起、调度中心不起、依赖不接', async () => {
    const s = await make(tempRoot('off', false))
    expect(s.tasks.depsBound()).toBe(false)
    expect(s.tasks.registry.size).toBe(0)
    expect((s.kernel.scheduling.scheduler as unknown as { started: boolean }).started).toBe(false)
    // 调度中心没起 = 账本根本没建（sidequest.sqlite 缺席是「没起」的落盘证据）。
    expect(existsSync(join(s.stateDir, 'sidequest.sqlite'))).toBe(false)
  })
})
