import { describe, it, expect, vi } from 'vitest'
import { builtinTasks, BUILTIN_TASK_IDS } from './builtin.ts'
import type { TaskDeps } from './types.ts'

/** 「全都接上了」的一份 deps——只为数任务，不为跑任务。
 *
 *  类型定死为 Required<Omit<TaskDeps, 'events'>>：TaskDeps 每加一个可选字段，这份夹具
 *  就必须跟着补上，否则 tsc 直接报错——不然漏配的字段既不会让这份夹具变红，也不会让下面
 *  「恰好 9 个」和「BUILTIN_TASK_IDS 一致」两条断言变红（新任务分支没被点亮，两边数出来的
 *  还是同一份旧结果），新增的内置任务就能在没有夹具/名单覆盖的情况下悄悄溜过去。
 *  `events` 是 TaskDeps 里唯一不给任何内置任务当门控的字段（见 types.ts:14 的注释：它只在
 *  别处被读，builtin.ts 没有任何 `if (wired.events)` 分支），所以显式排除，而不是把它也
 *  塞进夹具制造一个「有它但没用」的假信号。 */
const allWired: Required<Omit<TaskDeps, 'events'>> = {
  log: () => {},
  cookieProvider: { refresh: async () => {} },
  capabilityJobs: { sweep: () => {} },
  standbyManager: { tick: async () => {} },
  netdisk: {} as never,
  netdiskStore: { list: () => [] },
  reconcile: { runScheduled: async () => ({ summary: '' }) },
  browserLanes: { reapIdle: async () => [] },
  authReconcile: async () => {},
  intents: { scanDue: async () => [] },
  follow: { scanDue: async () => [] },
  ledger: { prune: () => 0 },
  agentRuns: { prune: () => ({ removed: 0, stripped: 0, files: 0, vacuumed: false }) },
  sessionExports: async () => [],
  recipePackageOps: { updates: async () => [] },
}

describe('builtinTasks', () => {
  it('装配只看 deps 实例在不在——没有平行的布尔表', () => {
    expect(builtinTasks({ log: () => {} })).toEqual([])
    // 数字钉死：deps 全接上时**恰好** 13 个任务。以后往 TaskDeps 加一个字段却忘了给它
    // 配任务（或反过来），这一条当场变红。
    expect(builtinTasks(allWired).map((t) => t.id)).toEqual([
      'cookie-refresh',
      'jobs-sweep',
      'standby-reaper',
      'browser-lane-reaper',
      'auth-reconcile',
      'netdisk-autosync',
      'intent-digest-scan',
      'netdisk-reconcile',
      'netdisk-follow',
      'ledger-prune',
      'agent-runs-prune',
      'session-export',
      'recipe-update-check',
    ])
  })

  it('BUILTIN_TASK_IDS（路由守卫用的静态名单）与全接上时的装配结果一致——两边不许漂', () => {
    expect([...BUILTIN_TASK_IDS].sort()).toEqual(builtinTasks(allWired).map((t) => t.id).sort())
  })

  it('缺某一项 deps ⇒ 对应任务不注册，其余不受影响', () => {
    const { standbyManager: _s, intents: _i, ...rest } = allWired
    const ids = builtinTasks(rest).map((t) => t.id)
    expect(ids).not.toContain('standby-reaper')
    expect(ids).not.toContain('intent-digest-scan')
    expect(ids).toContain('cookie-refresh')
    expect(ids).toHaveLength(11)
  })

  it('recipe-update-check：每天一次、只报不装；有更新就 log 那一行并报数，没有就说"都是最新的"', async () => {
    const t = builtinTasks({ log: () => {}, recipePackageOps: { updates: async () => [] } }).find((x) => x.id === 'recipe-update-check')!
    expect(t.schedule).toBe('0 40 4 * * *')
    expect(t.serial).toBe(true)
    const logged: string[] = []
    const out = await t.run({
      log: (m) => logged.push(m),
      recipePackageOps: { updates: async () => [{ name: '@streamapp/wechat', builtin: '1.0.1', latest: '1.0.2' }] },
    })
    expect(out.summary).toBe('1 个包有更新')
    expect(logged.join('\n')).toMatch(/@streamapp\/wechat 1\.0\.1 → 1\.0\.2/)
    expect(logged.join('\n')).toMatch(/stream update/)
    const none = await t.run({ log: (m) => logged.push(m), recipePackageOps: { updates: async () => [] } })
    expect(none.summary).toBe('都是最新的')
    expect(logged).toHaveLength(1) // 没有候选时一个字都不多打
  })

  it('recipe-update-check：查 registry 失败不 throw（它是一句提醒，不是后端功能），但 summary 说清"没查成"', async () => {
    const t = builtinTasks({ log: () => {}, recipePackageOps: { updates: async () => [] } }).find((x) => x.id === 'recipe-update-check')!
    const out = await t.run({ log: () => {}, recipePackageOps: { updates: async () => { throw new Error('ENOTFOUND registry.npmjs.org') } } })
    expect(out.summary).toMatch(/没查成：ENOTFOUND/)
    // 缺依赖仍然抛——那是接线错，不是网络抖动
    await expect(t.run({ log: () => {} })).rejects.toThrow(/recipePackageOps/)
  })

  it('session-export：任一份导出失败 → throw（消费者是定点跑的真钱任务，不许静默吞）', async () => {
    const [task] = builtinTasks({ log: () => {}, sessionExports: async () => [] })
    await expect(task.run({
      log: () => {},
      sessionExports: async () => [
        { name: 'ok1', ok: true, cookieCount: 3, extras: ['validatekey'], path: '/tmp/x.json' },
        { name: 'bad1', ok: false, cookieCount: 0, extras: [], reason: '一条 cookie 都没有' },
      ],
    })).rejects.toThrow(/bad1: 一条 cookie 都没有/)
  })

  it('session-export 的回执只带名字/条数/字段名——任务历史是能在界面上翻的', async () => {
    const [task] = builtinTasks({ log: () => {}, sessionExports: async () => [] })
    const out = await task.run({
      log: () => {},
      sessionExports: async () => [
        { name: 'dfcf', ok: true, cookieCount: 5, extras: ['validatekey'], path: '/tmp/cookies_dfcf.json' },
      ],
    })
    expect(JSON.stringify(out)).not.toContain('/tmp/')
    expect(out.detail).toEqual({ exports: [{ name: 'dfcf', cookies: 5, extras: ['validatekey'] }] })
  })

  it('netdisk-autosync 失败不再静默：任一 set 失败 → throw', async () => {
    const [task] = builtinTasks({ log: () => {}, netdisk: {} as never })
    const deps: TaskDeps = {
      log: () => {},
      netdisk: { sync: vi.fn().mockRejectedValue(new Error('alist down')) } as never,
      netdiskStore: { list: () => [{ id: 's1', autoSync: true } as never] },
    }
    await expect(task.run(deps)).rejects.toThrow(/1 failed/)
  })

  it('cookie-refresh 走 cookieProvider.refresh', async () => {
    const refresh = vi.fn(async () => {})
    const [task] = builtinTasks({ log: () => {}, cookieProvider: { refresh: async () => {} } })
    const out = await task.run({ log: () => {}, cookieProvider: { refresh } })
    expect(refresh).toHaveBeenCalled()
    expect(out.summary).toContain('refreshed')
  })

  it('缺依赖时任务抛错(不静默跳过)', async () => {
    const [task] = builtinTasks({ log: () => {}, cookieProvider: { refresh: async () => {} } })
    await expect(task.run({ log: () => {} })).rejects.toThrow(/cookieProvider/)
  })

  it('netdisk-reconcile 委派 reconcile.runScheduled', async () => {
    const tasks = builtinTasks({ log: () => {}, reconcile: { runScheduled: async () => ({ summary: '' }) } })
    const task = tasks.find((t) => t.id === 'netdisk-reconcile')!
    expect(task.label).toBe('网盘内容对账')
    expect(task.schedule).toBe('0 30 3 * * *')
    expect(task.serial).toBe(true)
    expect(task.maxAttempts).toBe(1)

    const runScheduledOutcome = { summary: 'reconciled 10 items' }
    const runScheduled = vi.fn().mockResolvedValue(runScheduledOutcome)
    const outcome = await task.run({ log: () => {}, reconcile: { runScheduled } })
    expect(runScheduled).toHaveBeenCalled()
    expect(outcome).toEqual(runScheduledOutcome)
  })

  it('intent-digest-scan: 有 intents 时跑 scanDue 并报数;缺依赖时 throw', async () => {
    const tasks = builtinTasks({ log: () => {}, intents: { scanDue: async () => [] } })
    const t = tasks.find((x) => x.id === 'intent-digest-scan')!
    expect(t.serial).toBe(true)
    const out = await t.run({ log: () => {}, intents: { scanDue: async () => ['a', 'b'] } })
    expect(out.summary).toContain('2')
    await expect(t.run({ log: () => {} })).rejects.toThrow()
  })

  it('netdisk-follow: 每小时扫一次，跑 scanDue 并报数；缺依赖时 throw', async () => {
    const t = builtinTasks({ log: () => {}, follow: { scanDue: async () => [] } }).find((x) => x.id === 'netdisk-follow')!
    expect(t.schedule).toBe('0 5 * * * *')
    expect(t.serial).toBe(true)
    const out = await t.run({ log: () => {}, follow: { scanDue: async () => ['map_1', 'map_2'] } })
    expect(out.summary).toContain('2')
    expect(out.detail).toEqual({ ran: ['map_1', 'map_2'] })
    expect((await t.run({ log: () => {}, follow: { scanDue: async () => [] } })).summary).toContain('没有到期')
    await expect(t.run({ log: () => {} })).rejects.toThrow(/follow/)
  })

  it('ledger-prune 把删掉的行数报进 summary——静默清理等于没清理', async () => {
    const prune = vi.fn().mockReturnValue(1234)
    const t = builtinTasks({ ...allWired, ledger: { prune } }).find((x) => x.id === 'ledger-prune')!
    const out = await t.run({ log: () => {}, ledger: { prune } })
    expect(prune).toHaveBeenCalledWith({ keepPerTask: 200, keepMs: 30 * 24 * 60 * 60_000 })
    expect(out.summary).toContain('1234')
  })
})
