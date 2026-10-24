import type { ScheduledTask } from './types.ts'

/** 往一个中心的注册表里批量登记；撞 id 抛（注册表本身归 `TaskCenter`，一个实例一张）。 */
export function registerTasks(registry: Map<string, ScheduledTask>, tasks: ScheduledTask[]): void {
  for (const t of tasks) {
    if (registry.has(t.id)) throw new Error(`duplicate task id: ${t.id}`)
    registry.set(t.id, t)
  }
}
