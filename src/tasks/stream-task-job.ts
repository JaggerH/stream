// 唯一的 Sidequest Job 类：所有 ScheduledTask 共用，taskId 是唯一序列化参数。
// 失败路径：先发通知事件（带 dedupeKey 防刷屏），再 rethrow 让引擎记 failed + 按 maxAttempts 重试。
import { Job } from 'sidequest'
import { taskRegistry } from './registry.ts'
import { getTaskDeps } from './deps.ts'
import type { TaskOutcome } from './types.ts'

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
      throw e
    }
  }
}
