import { describe, it, expect } from 'vitest'
import { prevMatch, assertSupportedCron } from './cron-prev.ts'
import { findMissedTasks, makeWatchdogTask } from './watchdog.ts'

const T = (s: string) => new Date(s).getTime()

describe('prevMatch（受支持子集：秒必须是常数,分/时支持 数字|*|*/n,日/月只支持 *,周支持 *|数字|a-b|列表）', () => {
  it('每分钟任务: 最近一个整分', () => {
    expect(prevMatch('0 * * * * *', T('2026-08-01T08:17:42+08:00'))).toBe(T('2026-08-01T08:17:00+08:00'))
  })
  it('每 10 分钟: 落在 */10 的槽上', () => {
    expect(prevMatch('0 */10 * * * *', T('2026-08-01T08:17:42+08:00'))).toBe(T('2026-08-01T08:10:00+08:00'))
  })
  it('每小时 :15: 上一个 :15,含跨小时', () => {
    expect(prevMatch('0 15 * * * *', T('2026-08-01T08:14:59+08:00'))).toBe(T('2026-08-01T07:15:00+08:00'))
    expect(prevMatch('0 15 * * * *', T('2026-08-01T08:15:00+08:00'))).toBe(T('2026-08-01T08:15:00+08:00'))
  })
  it('每 6 小时整点: 0/6/12/18 时', () => {
    expect(prevMatch('0 0 */6 * * *', T('2026-08-01T05:59:00+08:00'))).toBe(T('2026-08-01T00:00:00+08:00'))
    expect(prevMatch('0 0 */6 * * *', T('2026-08-01T18:00:30+08:00'))).toBe(T('2026-08-01T18:00:00+08:00'))
  })
  it('每天 03:30', () => {
    expect(prevMatch('0 30 3 * * *', T('2026-08-01T02:00:00+08:00'))).toBe(T('2026-07-31T03:30:00+08:00'))
  })
  it('工作日 09:45（A 股申购）: 周中回到当天,周一早上回到上周五', () => {
    // 2026-08-26 是周三
    expect(prevMatch('0 45 9 * * 1-5', T('2026-08-26T10:00:00+08:00'))).toBe(T('2026-08-26T09:45:00+08:00'))
    // 周三 09:00 往回 → 周二那一班
    expect(prevMatch('0 45 9 * * 1-5', T('2026-08-26T09:00:00+08:00'))).toBe(T('2026-08-25T09:45:00+08:00'))
  })
  it('周末不认工作日的班 —— 25 小时扫不到就是 null,不往更早补', () => {
    // 周六 09:41（正是这次迁移的现场）：往回 25h 只到周五 08:41,够得着周五 09:45
    expect(prevMatch('0 45 9 * * 1-5', T('2026-08-29T09:41:00+08:00'))).toBe(T('2026-08-28T09:45:00+08:00'))
    // 周日：25h 内只有周六,没有工作日槽 → null。周五那一班不会在周一被补跑
    expect(prevMatch('0 45 9 * * 1-5', T('2026-08-30T12:00:00+08:00'))).toBeNull()
    expect(prevMatch('0 55 14 * * 1-5', T('2026-08-31T08:00:00+08:00'))).toBeNull()
  })
  it('周段接受列表与 0/7 两种周日写法', () => {
    expect(prevMatch('0 0 8 * * 1,3', T('2026-08-26T09:00:00+08:00'))).toBe(T('2026-08-26T08:00:00+08:00'))
    // 2026-08-30 是周日
    expect(prevMatch('0 0 8 * * 0', T('2026-08-30T09:00:00+08:00'))).toBe(T('2026-08-30T08:00:00+08:00'))
    expect(prevMatch('0 0 8 * * 7', T('2026-08-30T09:00:00+08:00'))).toBe(T('2026-08-30T08:00:00+08:00'))
  })
  it('不支持的写法 fail-loud: 秒非常数 / 日月非 * / 周段猜不准的写法', () => {
    expect(() => assertSupportedCron('*/5 * * * * *')).toThrow()
    expect(() => assertSupportedCron('0 0 0 1 * *')).toThrow()
    // 跨周回绕的方言不一致,猜错就是重复补跑 —— 宁可跳过
    expect(() => assertSupportedCron('0 0 0 * * 5-1')).toThrow()
    expect(() => assertSupportedCron('0 0 0 * * MON')).toThrow()
    expect(() => assertSupportedCron('0 0 0 * * 1')).not.toThrow()
    expect(() => assertSupportedCron('0 45 9 * * 1-5')).not.toThrow()
    expect(() => assertSupportedCron('0 15 * * * *')).not.toThrow()
  })
})

describe('findMissedTasks', () => {
  const now = T('2026-08-01T09:20:00+08:00')
  const hourly = { id: 'h', schedule: '0 15 * * * *' } // 最近应跑槽 09:15(在 grace 外需 ≥90s,故用 09:17 之前的槽)
  const tenMin = { id: 't', schedule: '0 */10 * * * *' }

  it('槽已正常跑过(账本里 inserted ≥ 槽-容差) → 不补', () => {
    const missed = findMissedTasks([hourly], now, () => ({ lastInsertedAt: T('2026-08-01T09:15:13+08:00'), alive: false }))
    expect(missed).toEqual([])
  })
  it('槽没跑(最后一次入队还是上个槽) → 补', () => {
    const missed = findMissedTasks([hourly], now, () => ({ lastInsertedAt: T('2026-08-01T08:15:13+08:00'), alive: false }))
    expect(missed).toEqual(['h'])
  })
  it('从未入队过(null) → 补', () => {
    expect(findMissedTasks([hourly], now, () => ({ lastInsertedAt: null, alive: false }))).toEqual(['h'])
  })
  it('还有存活 job(waiting/claimed/running) → 不补(在跑或已在补)', () => {
    const missed = findMissedTasks([hourly], now, () => ({ lastInsertedAt: T('2026-08-01T08:15:13+08:00'), alive: true }))
    expect(missed).toEqual([])
  })
  it('槽还在 grace 窗内(刚过点,正常路可能还没落) → 本轮不补', () => {
    // now=09:15:30,槽 09:15:00 距今 30s < grace 90s → 等下一轮再说
    const missed = findMissedTasks([hourly], T('2026-08-01T09:15:30+08:00'), () => ({ lastInsertedAt: null, alive: false }))
    expect(missed).toEqual([])
  })
  it('改过排期的任务按新排期判丢班（center 必须喂活的 schedule,不是启动快照）', () => {
    // 旧排期每天 03:00,昨天 09:00 最后入队过一次(早就跟当前槽没关系了);现在按新排期判：
    // 03:02 距最近应跑槽 03:00 只 2 分钟,在 grace(90s 外要真丢),仍处于自愈可疑窗——用一个更晚的
    // now 把它推出 grace,确认落在"该跑没跑"上。
    const now = T('2026-08-01T03:02:00+08:00')
    const missed = findMissedTasks(
      [{ id: 'h', schedule: '0 0 3 * * *' }], now,
      () => ({ lastInsertedAt: T('2026-07-31T09:00:00+08:00'), alive: false }),
    )
    expect(missed).toEqual(['h'])
  })

  it('任务诞生之前的槽不算丢班 —— 新建任务不该被当场倒补一次', () => {
    // 周六 10:00 建的任务，最近一个应跑槽是周五 09:45（在 25h 内）。
    // 没有 notBefore 的话它下一分钟就会被补跑——对下单类任务等于建完就下单。
    const born = T('2026-08-29T10:00:00+08:00')
    const task = { id: 'dfcf', schedule: '0 45 9 * * 1-5', notBefore: born }
    const look = () => ({ lastInsertedAt: null, alive: false })
    expect(findMissedTasks([task], T('2026-08-29T10:05:00+08:00'), look)).toEqual([])
    // 诞生之后的槽照常兜住：下周一 09:45 过了 grace 还没入队 → 补
    expect(findMissedTasks([task], T('2026-08-31T10:00:00+08:00'), look)).toEqual(['dfcf'])
  })

  it('没有 notBefore 的任务（builtin）行为不变 —— 倒补正是它们要的自愈', () => {
    const task = { id: 'b', schedule: '0 30 3 * * *' }
    expect(findMissedTasks([task], T('2026-08-29T10:00:00+08:00'), () => ({ lastInsertedAt: null, alive: false })))
      .toEqual(['b'])
  })

  it('不支持的 cron → 跳过并报 skipped,不炸整轮', () => {
    // 周段的英文缩写方言：认不出就跳过，绝不猜（数字形式的 `1` / `1-5` 现在是支持的）
    const bad = { id: 'b', schedule: '0 0 0 * * MON' }
    const out: string[] = []
    // 09:23:00——tenMin 的最近槽 09:20 已出 grace 窗,可判
    const missed = findMissedTasks([bad, tenMin], T('2026-08-01T09:23:00+08:00'), () => ({ lastInsertedAt: null, alive: false }), { onSkip: (id) => out.push(id) })
    expect(missed).toEqual(['t'])
    expect(out).toEqual(['b'])
  })
})

describe('makeWatchdogTask', () => {
  it('run: 对每个丢班任务 enqueue 一次并报 summary;无丢班报安静', async () => {
    const enqueued: string[] = []
    const task = makeWatchdogTask({
      listTasks: () => [{ id: 'h', schedule: '0 15 * * * *' }],
      look: () => ({ lastInsertedAt: null, alive: false }),
      enqueue: async (id) => { enqueued.push(id); return 'enqueued' },
      now: () => T('2026-08-01T09:20:00+08:00'),
    })
    expect(task.id).toBe('schedule-watchdog')
    expect(task.schedule).toBe('0 * * * * *')
    const out = await task.run({ log: () => {} })
    expect(enqueued).toEqual(['h'])
    expect(out.summary).toContain('补跑 1')
    const quiet = await makeWatchdogTask({
      listTasks: () => [{ id: 'h', schedule: '0 15 * * * *' }],
      look: () => ({ lastInsertedAt: T('2026-08-01T09:15:10+08:00'), alive: false }),
      enqueue: async () => { throw new Error('不该补') },
      now: () => T('2026-08-01T09:20:00+08:00'),
    }).run({ log: () => {} })
    expect(quiet.summary).toContain('无丢班')
  })

  // 全新库首启 100% 复现的那一幕：一轮里补跑多条丢班任务，其中一条底下已经有存活 job。
  // 那不是失败——watchdog 要的就是"这一班有 job"，已经有了就是达成。整轮 throw 掉的代价是
  // 剩下那些本来补得上的任务这一分钟一条都补不成。
  it('一条已在队列不让这一轮失败，其余的照补，且说清楚是"已经排着了"', async () => {
    const seen: string[] = []
    const logs: string[] = []
    const task = makeWatchdogTask({
      listTasks: () => [
        { id: 'a', schedule: '0 15 * * * *' },
        { id: 'b', schedule: '0 15 * * * *' },
        { id: 'c', schedule: '0 15 * * * *' },
      ],
      look: () => ({ lastInsertedAt: null, alive: false }),
      enqueue: async (id) => {
        seen.push(id)
        return id === 'b' ? 'already-queued' : 'enqueued'
      },
      now: () => T('2026-08-01T09:20:00+08:00'),
    })
    const out = await task.run({ log: (m) => logs.push(m) })
    expect(seen).toEqual(['a', 'b', 'c']) // b 之后没有停下来
    expect(out.detail).toMatchObject({ requeued: ['a', 'c'], alreadyQueued: ['b'] })
    expect(out.summary).toContain('1 个已在队列')
    // 不许静静吞掉：日志里要看得出 b 发生了什么，而且不能伪装成"补跑了"。
    expect(logs.some((l) => l.includes('b') && l.includes('已经排着队了'))).toBe(true)
    expect(logs).not.toContain('[watchdog] 补跑丢班任务: b')
  })

  // 一条 `whenBusy: 'skip'` 的任务丢了班，而它的互斥组还忙着：**这一班就是不该补**。
  // 补跑只会让一件"迟到就别做"的事做得更迟。不是失败，但也不能静静消失——连着几班没跑，
  // 界面上得看得出是被互斥挡的，而不是任务坏了。
  it('互斥组正忙的 skip 任务不补，其余照补，且说清楚是被互斥挡的', async () => {
    const logs: string[] = []
    const task = makeWatchdogTask({
      listTasks: () => [{ id: 'ipo', schedule: '0 15 * * * *' }, { id: 'a', schedule: '0 15 * * * *' }],
      look: () => ({ lastInsertedAt: null, alive: false }),
      enqueue: async (id) => (id === 'ipo' ? 'skipped-busy' : 'enqueued'),
      now: () => T('2026-08-01T09:20:00+08:00'),
    })
    const out = await task.run({ log: (m) => logs.push(m) })
    expect(out.detail).toMatchObject({ requeued: ['a'], skippedBusy: ['ipo'] })
    expect(out.summary).toContain('1 个互斥组正忙没补')
    expect(logs.some((l) => l.includes('ipo') && l.includes('互斥组正忙'))).toBe(true)
    expect(logs).not.toContain('[watchdog] 补跑丢班任务: ipo')
  })

  it('真失败仍然带走这一轮——不是把 catch 铺开当消音器', async () => {
    const task = makeWatchdogTask({
      listTasks: () => [{ id: 'a', schedule: '0 15 * * * *' }, { id: 'b', schedule: '0 15 * * * *' }],
      look: () => ({ lastInsertedAt: null, alive: false }),
      enqueue: async (id) => {
        if (id === 'a') throw new Error('账本挂了')
        return 'enqueued'
      },
      now: () => T('2026-08-01T09:20:00+08:00'),
    })
    // b 照样补上（一条坏的不该带走其余），但这一轮整体记 failed。
    await expect(task.run({ log: () => {} })).rejects.toThrow('账本挂了')
  })

  it('watchdog 不看自己', async () => {
    const task = makeWatchdogTask({
      listTasks: () => [{ id: 'schedule-watchdog', schedule: '0 * * * * *' }],
      look: () => ({ lastInsertedAt: null, alive: false }),
      enqueue: async () => { throw new Error('不该补自己') },
      now: () => T('2026-08-01T09:20:00+08:00'),
    })
    const out = await task.run({ log: () => {} })
    expect(out.summary).toContain('无丢班')
  })
})
