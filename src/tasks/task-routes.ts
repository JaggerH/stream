/**
 * job → 实例的路由表（openspec `embeddable-engine` D5-B）。
 *
 * sidequest 按类名从 jobs 文件解析 job 类、按账本里的 `constructor_args` 构造它——job 运行时手里只有那一个
 * 实例键，够不到装配现场。每个 `TaskCenter` 起来时按自己的键登记一条路由（注册表 + deps），job 按键查。
 *
 * **这是有意的进程级状态**：它只是「键 → 实例」的索引，本身不装任何实例的数据；两个实例各登记各的键，
 * 互不可见。
 */
import type { ScheduledTask, TaskDeps, TaskSettledEvent } from './types.ts'

export interface TaskRoute {
  task: (id: string) => ScheduledTask | undefined
  /** 未接上就抛（防静默空跑）。 */
  deps: () => TaskDeps
  /** 一次运行结束（成功/失败）的事实交给实例。缺席 = 这个实例没人订阅运行结果。 */
  settled?: (e: TaskSettledEvent) => void
}

const routes = new Map<string, TaskRoute>()

/** 登记一条路由，回撤销函数。同一个键已被占着就抛：两个中心不许共用一个账本。 */
export function bindTaskRoute(key: string, route: TaskRoute): () => void {
  if (routes.has(key)) throw new Error(`调度账本已被本进程里的另一个调度中心占用（实例键 ${key}）`)
  routes.set(key, route)
  return () => { if (routes.get(key) === route) routes.delete(key) }
}

/**
 * 按键找实例。旧账本里没有键的行（`constructor_args = []`），或键对不上的（库被挪过、面板手动重跑了一条老行），
 * 在只有一个实例时就归它——单实例下与改造前等价；多个实例时认不出就抛，记 failed，不猜。
 */
export function taskRouteFor(key: string | undefined): TaskRoute {
  const hit = key ? routes.get(key) : undefined
  if (hit) return hit
  if (routes.size === 1) return routes.values().next().value!
  throw new Error(routes.size === 0
    ? 'task center not running — no route for this job'
    : `no task center for instance key ${JSON.stringify(key ?? '')}`)
}
