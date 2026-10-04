import { describe, it, expect, vi } from 'vitest'
import { compileUserTask, compileEnabled } from './user-tasks.ts'
import type { UserTaskRow } from './task-store.ts'
import type { PackageAction } from './package-actions.ts'

const row: UserTaskRow = {
  id: 'dl-freshness', label: '数据新鲜度巡检', schedule: '0 0 * * * *',
  timezone: 'Asia/Shanghai',
  command: '/bin/python', args: ['-m', 'data_pipeline.monitors.data_sources'],
  cwd: '/work', env: { PYTHONPATH: '.' }, timeoutMs: 60_000,
  serial: true, maxAttempts: 1, enabled: true,
  createdAt: 1, updatedAt: 1,
}

describe('compileUserTask', () => {
  it('行里的排期/并发/重试原样落到 ScheduledTask 上', () => {
    const t = compileUserTask(row)
    expect(t.id).toBe('dl-freshness')
    expect(t.label).toBe('数据新鲜度巡检')
    expect(t.schedule).toBe('0 0 * * * *')
    expect(t.timezone).toBe('Asia/Shanghai')
    expect(t.serial).toBe(true)
    expect(t.maxAttempts).toBe(1)
  })

  // 这两格决定这条任务进哪个队列、轮不上时跑不跑。透传漏了的表现是**一条设了互斥的任务
  // 安静地跟别人并发**——不报错，界面上也看不出来，只有账本里的时间戳会重叠。
  it('互斥组和迟到语义透传到 ScheduledTask；没填就不带这两格', () => {
    const t = compileUserTask({ ...row, exclusiveOn: 'jq-bridge', whenBusy: 'skip' })
    expect(t.exclusiveOn).toBe('jq-bridge')
    expect(t.whenBusy).toBe('skip')
    const bare = compileUserTask(row)
    expect('exclusiveOn' in bare).toBe(false)
    expect('whenBusy' in bare).toBe(false)
  })

  it('run 把命令原样交给执行器，并按 id 给出日志路径', async () => {
    const exec = vi.fn().mockResolvedValue({ summary: 'ok' })
    const t = compileUserTask(row, { logDir: '/logs', exec })
    const out = await t.run({ log: () => {} })
    expect(out).toEqual({ summary: 'ok' })
    expect(exec).toHaveBeenCalledWith({
      command: '/bin/python',
      args: ['-m', 'data_pipeline.monitors.data_sources'],
      cwd: '/work',
      env: { PYTHONPATH: '.' },
      timeoutMs: 60_000,
      logFile: '/logs/dl-freshness.log',
    })
  })

  it('compileEnabled 跳过 enabled=false 的行', () => {
    const ids = compileEnabled([row, { ...row, id: 'off', enabled: false }]).map((t) => t.id)
    expect(ids).toEqual(['dl-freshness'])
  })

  it('可选字段缺省时整个键都不出现——传 undefined 过去 toHaveBeenCalledWith 是看不出来的', async () => {
    const rowMinimal: UserTaskRow = {
      id: 'minimal-task',
      label: '最小化任务',
      schedule: '0 0 * * * *',
      command: '/bin/true',
      args: [],
      serial: false,
      maxAttempts: 1,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      // timezone, cwd, env, timeoutMs all absent
    }

    const exec = vi.fn().mockResolvedValue({ summary: 'ok' })
    const t = compileUserTask(rowMinimal, { exec })

    // Verify ScheduledTask structure has no optional keys
    // notBefore 恒在（取 createdAt）——它是丢班自愈的下界，缺了新建任务会被当场倒补一次
    expect(Object.keys(t).sort()).toEqual(['id', 'label', 'maxAttempts', 'notBefore', 'run', 'schedule', 'serial'])
    expect(t.notBefore).toBe(rowMinimal.createdAt)

    // Verify exec call has no optional keys
    await t.run({ log: () => {} })
    const arg = exec.mock.calls[0][0]
    expect(Object.keys(arg).sort()).toEqual(['args', 'command'])
  })
})

/**
 * 执行体之二：一条用户任务指向包提供的动作。东方财富那三条走的就是这条路——它们不是特例，
 * 排期、启停、账号全在任务行和它绑的配置 row 里。
 */
describe('compileUserTask —— 动作型的行', () => {
  const actionRow: UserTaskRow = {
    id: 'em-repo', label: '东财 撤单+逆回购', schedule: '0 55 14 * * 1-5',
    action: 'eastmoney:repo', args: [], serial: true, maxAttempts: 1,
    configRef: 'eastmoney', enabled: true, createdAt: 1, updatedAt: 1,
  }

  it('调那个动作，参数来自它绑的配置 row', async () => {
    const run = vi.fn<PackageAction>(async () => ({ summary: 'ok' }))
    const t = compileUserTask(actionRow, {
      actions: (n) => (n === 'eastmoney:repo' ? run : undefined),
      paramsFor: (ref) => (ref === 'eastmoney' ? { zjzh: '123', trading: true } : {}),
    })
    expect(await t.run({ log: () => {} })).toEqual({ summary: 'ok' })
    expect(run).toHaveBeenCalledWith({ zjzh: '123', trading: true })
  })

  // 存快照的表现是"改了没反应"，而且不报错——用户在界面上把「真下单」勾上，下一轮还是空跑。
  it('参数每次跑现取，不在编译期冻住', async () => {
    const run = vi.fn<PackageAction>(async () => ({ summary: 'ok' }))
    let trading = false
    const t = compileUserTask(actionRow, {
      actions: () => run,
      paramsFor: () => ({ trading }),
    })
    await t.run({ log: () => {} })
    trading = true
    await t.run({ log: () => {} })
    expect(run.mock.calls.map((c) => c[0])).toEqual([{ trading: false }, { trading: true }])
  })

  // 一条任务安安静静什么都不做，和"它跑了、没事可做"长得一模一样。包被关掉、装载失败、
  // 名字打错——三种都该在这条任务的历次执行里红一次。
  it('动作不在名录里 ⇒ 抛，不是静默跳过', async () => {
    const t = compileUserTask(actionRow, { actions: () => undefined })
    await expect(t.run({ log: () => {} })).rejects.toThrow(/没有这个动作：eastmoney:repo/)
  })

  it('没绑配置格 ⇒ 空参数袋（缺什么由动作自己说，它比调度器清楚）', async () => {
    const run = vi.fn<PackageAction>(async () => ({ summary: 'ok' }))
    const { configRef: _drop, ...noRef } = actionRow
    const t = compileUserTask(noRef, { actions: () => run, paramsFor: () => ({ zjzh: '不该拿到' }) })
    await t.run({ log: () => {} })
    expect(run).toHaveBeenCalledWith({})
  })

  it('动作型的行不碰 exec', async () => {
    const exec = vi.fn()
    const t = compileUserTask(actionRow, { exec, actions: () => async () => ({ summary: 'ok' }) })
    await t.run({ log: () => {} })
    expect(exec).not.toHaveBeenCalled()
  })
})
