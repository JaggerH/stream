import type { ScheduledTask } from './types.ts'

export const taskRegistry = new Map<string, ScheduledTask>()

export function registerTasks(tasks: ScheduledTask[]): void {
  for (const t of tasks) {
    if (taskRegistry.has(t.id)) throw new Error(`duplicate task id: ${t.id}`)
    taskRegistry.set(t.id, t)
  }
}
