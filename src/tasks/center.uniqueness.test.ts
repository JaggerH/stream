import { describe, it, expect } from 'vitest'
import { JobBuilder } from 'sidequest' // 它把 @sidequest/engine 整个再导出
import { configure } from './center.ts'
import { StreamTaskJob } from './stream-task-job.ts'
import type { ScheduledTask } from './types.ts'

/**
 * `serial: true` 的去重键必须**认得出是哪条任务**。
 *
 * 这不是在断言"我们给 unique() 传了什么形状的参数"——那种断言换个写法就假绿。这里把
 * `configure` 交给 **sidequest 自己的 JobBuilder**，让它按自己的规则算出 `unique_digest`
 * （数据库上的唯一索引就是拿这一列去重的），再看两条不同的任务算出来一不一样。
 *
 * 改回 `b.unique(true)` 会当场变红：`AliveJobUniqueness` 在 `withArgs: false` 下只吃 job
 * 类名，而所有 ScheduledTask 共用同一个类 `StreamTaskJob`——两条任务算出同一个 digest，
 * 一条活着就把另一条顶掉（`Job #undefined - StreamTaskJob is duplicated`）。
 */
const serialTask = (id: string): ScheduledTask => ({
  id, label: id, schedule: '0 0 4 * * *', serial: true, maxAttempts: 1,
  run: async () => ({ summary: 'ok' }),
})

async function digestFor(id: string): Promise<string | null | undefined> {
  const captured: Array<Record<string, unknown>> = []
  const backend = { createNewJob: async (d: Record<string, unknown>) => { captured.push(d); return d } }
  // manualJobResolution: true —— 和 startTaskCenter 传给 Sidequest.start 的那一档一致，
  // 省掉 builder 去盘上找 job 源文件那一步。
  const b = new JobBuilder<typeof StreamTaskJob>(backend as never, StreamTaskJob, undefined, true)
  configure(b as never, serialTask(id))
  await b.enqueue(id)
  return captured[0]?.unique_digest as string | null | undefined
}

describe('serial 任务的去重键', () => {
  it('两条不同的 serial 任务算出不同的 unique_digest', async () => {
    const a = await digestFor('intent-digest-scan')
    const b = await digestFor('ledger-prune')
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('同一条任务两次入队算出同一个 digest——"上轮没完就跳过本次"仍然成立', async () => {
    expect(await digestFor('ledger-prune')).toBe(await digestFor('ledger-prune'))
  })
})
