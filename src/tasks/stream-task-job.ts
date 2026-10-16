// 唯一的 Sidequest Job 类：所有 ScheduledTask 共用，taskId 是唯一序列化参数。
// 失败路径：先发通知事件（带 dedupeKey 防刷屏），再 rethrow 让引擎记 failed + 按 maxAttempts 重试；可能已发出动作的失败（failureDisposition=final）记 failed 不重试。
import { Job } from 'sidequest'
import { taskRegistry } from './registry.ts'
import { getTaskDeps } from './deps.ts'
import type { TaskOutcome } from './types.ts'
import { failureDisposition } from '../devices/errors.ts'

export class StreamTaskJob extends Job {
  async run(taskId: string): Promise<TaskOutcome> {
    const deps = getTaskDeps() // 未初始化 → 抛，记 failed（防静默空跑）
    const task = taskRegistry.get(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    try {
      return await task.run(deps)
    } catch (e) {
      const msg = (e as Error).message
      deps.log(`[tasks] ${task.id} failed: ${msg}`)
      try {
        deps.events?.append({
          type: 'task.failed', severity: 'error',
          title: `任务失败：${task.label}`, body: msg,
          dedupeKey: `task-failed:${task.id}`,
        })
      } catch { /* 通知失败不遮蔽原始错误 */ }
      // 可能已经有动作发出去了（设备中途失联、用户按了中止）——再跑一遍就是重复下单。
      // 记 failed 但不进重试，见 src/devices/errors.ts 头注。
      if (failureDisposition(e) === 'final') return this.fail(e as Error) as unknown as TaskOutcome
      throw e
    }
  }
}
