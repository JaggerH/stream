import type { ScheduledTask } from './types.ts'
import { prevMatch } from './cron-prev.ts'

/** 丢班自愈(watchdog)。
 *
 *  背景:节拍器(node-cron)对每个槽只有一次机会——用墙钟算好延迟后一个 setTimeout 睡到点,醒来
 *  发现迟到超容差(30s)就只告警不执行。本机(WSL2)的时钟毛病(单调钟偏快 7.6%、墙钟偶发跳变、
 *  VM 被宿主暂停)让这种迟到时有发生:分钟级任务丢一班 60s 后自然补上,小时级以上丢一班就是
 *  一整个周期,且完全静默(2026-08-01 活体实测 intent-digest-scan 连丢 08:15/09:15 两槽,
 *  netdisk-autosync 的 6h 槽历史同样大面积丢)。
 *
 *  对策:不信任何"一觉睡到点",每分钟对账一次——对每个任务算出最近一个应跑槽,查 sidequest
 *  账本(sqlite,跨进程重启存活)里有没有对应入队;没有且无存活 job 就补跑一次。补跑本身会落
 *  账本行,所以下一轮对账自然通过,无需额外去重状态。 */

export interface TaskLook {
  /** 该任务最近一次入队时刻(epoch ms);从未入队 → null */
  lastInsertedAt: number | null
  /** 是否还有存活 job(waiting/claimed/running)——在跑或已在补,别重复补 */
  alive: boolean
}

export interface WatchdogOptions {
  /** 槽点过后多久才判丢班——给正常路留落账时间(必须 > 节拍器容差 30s) */
  graceMs?: number
  /** 入队时刻允许比槽点早/晚多少仍算"这班跑了" */
  toleranceMs?: number
  onSkip?: (taskId: string, reason: string) => void
}

/** 纯判定:哪些任务的最近应跑槽没跑。cron 超出受支持子集的任务跳过并经 onSkip 上报。 */
export function findMissedTasks(
  tasks: Array<{ id: string; schedule: string; notBefore?: number }>,
  nowMs: number,
  look: (taskId: string) => TaskLook,
  opts: WatchdogOptions = {},
): string[] {
  const grace = opts.graceMs ?? 90_000
  const tolerance = opts.toleranceMs ?? 30_000
  const missed: string[] = []
  for (const t of tasks) {
    if (t.id === WATCHDOG_ID) continue // 不看自己:它每分钟跑,丢一班无损
    let slot: number | null
    try {
      slot = prevMatch(t.schedule, nowMs)
    } catch (e) {
      opts.onSkip?.(t.id, (e as Error).message)
      continue
    }
    if (slot === null) continue
    // 任务诞生之前的槽不是"丢了",是那时候还没有它。少了这一条,新建任务下一分钟就被倒补
    // 最近一班——对下单类任务等于建完就下单。
    if (t.notBefore !== undefined && slot < t.notBefore) continue
    if (nowMs - slot < grace) continue // 刚过点,正常路可能还没落账,下一轮再判
    const { lastInsertedAt, alive } = look(t.id)
    if (alive) continue
    if (lastInsertedAt !== null && lastInsertedAt >= slot - tolerance) continue
    missed.push(t.id)
  }
  return missed
}

export const WATCHDOG_ID = 'schedule-watchdog'

/**
 * 一次补跑的结果。**`already-queued` 不是失败**：watchdog 补跑的目的就是"让这一班有 job"，
 * 底下的账本告诉我们已经有了，那这一条的目的已经达成。它仍然要**说出来**（一行日志 + 进
 * detail），不能静静吞掉——它同时是"我和账本看到的不是同一瞬间"的证据。
 *
 * 为什么它真的会发生（修完 uniqueness 之后也会）：`look()` 走的是另一条只读连接、且是在
 * 循环开始前一次性算的，而节拍器可能正好在这中间为同一条任务落了账。
 *
 * `unknown-task`：从判丢班到真入队之间那条任务被 removeTask 摘了。同样不是失败。
 *
 * `skipped-busy`：这条任务标了 `whenBusy: 'skip'`，而它的互斥组此刻正忙。**这一班就是不该补**
 * ——它要的是"迟到就别做"，补跑只会做得更迟。同样不是失败，但同样要说出来（见 run 里的日志
 * 和 detail），否则一条任务连着几班没跑，界面上什么都看不出来。
 */
export type EnqueueOutcome = 'enqueued' | 'already-queued' | 'unknown-task' | 'skipped-busy'

export interface WatchdogDeps {
  listTasks: () => Array<{ id: string; schedule: string }>
  look: (taskId: string) => TaskLook
  /** 立即入队一次该任务(等价于节拍器到点做的事) */
  enqueue: (taskId: string) => Promise<EnqueueOutcome>
  now?: () => number
}

/** 组装 watchdog 自己的 ScheduledTask。它由 center 注册,与普通任务走同一条 StreamTaskJob 管道。 */
export function makeWatchdogTask(deps: WatchdogDeps): ScheduledTask {
  return {
    id: WATCHDOG_ID,
    label: '调度丢班自愈',
    schedule: '0 * * * * *', // 分钟级实测不丢;丢了下一分钟自然重来
    serial: false,
    maxAttempts: 1,
    run: async (taskDeps) => {
      const nowMs = (deps.now ?? Date.now)()
      const skipped: string[] = []
      const missed = findMissedTasks(deps.listTasks(), nowMs, deps.look, {
        onSkip: (id, reason) => {
          skipped.push(id)
          taskDeps.log(`[watchdog] 跳过 ${id}: ${reason}`)
        },
      })
      // 一条补跑失败不该带走整轮:剩下的丢班任务本来是能补的,而这一轮整个 throw 掉之后
      // 它们要等到下一分钟才有第二次机会(且下一轮多半撞同一堵墙)。所以逐条记账,循环跑完
      // 再决定这一轮的成败。
      const requeued: string[] = []
      const alreadyQueued: string[] = []
      const skippedBusy: string[] = []
      const failed: string[] = []
      for (const id of missed) {
        let outcome: EnqueueOutcome
        try {
          outcome = await deps.enqueue(id)
        } catch (e) {
          // 真失败——不是"已经排着了"(那一档由 enqueue 翻译成 already-queued)。原样上报,
          // 让这一轮 watchdog 记 failed、发通知。
          failed.push(`${id}: ${(e as Error).message}`)
          taskDeps.log(`[watchdog] 补跑 ${id} 失败: ${(e as Error).message}`)
          continue
        }
        if (outcome === 'enqueued') {
          requeued.push(id)
          taskDeps.log(`[watchdog] 补跑丢班任务: ${id}`)
        } else if (outcome === 'already-queued') {
          alreadyQueued.push(id)
          taskDeps.log(`[watchdog] ${id} 已经排着队了,不重复补——这一班已经有人管`)
        } else if (outcome === 'skipped-busy') {
          skippedBusy.push(id)
          taskDeps.log(`[watchdog] ${id} 的互斥组正忙,这一班不补——它要的是迟到就别做`)
        } else {
          taskDeps.log(`[watchdog] ${id} 判丢班之后被摘掉了,不补`)
        }
      }
      if (failed.length > 0) throw new Error(`补跑失败 ${failed.length} 条 — ${failed.join('; ')}`)
      const parts: string[] = []
      if (requeued.length > 0) parts.push(`补跑 ${requeued.length} 个丢班任务`)
      if (alreadyQueued.length > 0) parts.push(`${alreadyQueued.length} 个已在队列`)
      if (skippedBusy.length > 0) parts.push(`${skippedBusy.length} 个互斥组正忙没补`)
      return {
        summary: parts.length > 0 ? parts.join('，') : '无丢班',
        detail: {
          missed,
          ...(requeued.length > 0 ? { requeued } : {}),
          ...(alreadyQueued.length > 0 ? { alreadyQueued } : {}),
          ...(skippedBusy.length > 0 ? { skippedBusy } : {}),
          ...(skipped.length > 0 ? { skipped } : {}),
        },
      }
    },
  }
}
