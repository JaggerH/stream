/** 模块级依赖注册点：Sidequest 的 Job 类经动态 import 加载，闭包不到 bootstrap 构造的
 *  依赖——这里是任务拿依赖的唯一入口（spec §3.2）。 */
import type { TaskDeps } from './types.ts'

let deps: TaskDeps | undefined

export function setTaskDeps(d: TaskDeps): void { deps = d }

export function getTaskDeps(): TaskDeps {
  if (!deps) throw new Error('task deps not initialized — setTaskDeps() must run before any task')
  return deps
}

export function resetTaskDeps(): void { deps = undefined }

/** 只读探测：现在接上了吗。给启动完成处的「hooks unbound」那一行用
 *  （`src/kernel/plugins/module-hooks.ts`）。查询档（STREAM_NO_SCHEDULER=1）不起调度中心，
 *  那一档由 serve.ts 显式申报成 degraded，不进那行告警。 */
export function isTaskDepsBound(): boolean { return deps !== undefined }
