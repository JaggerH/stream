/** `scheduled_tasks` 的行 → 调度中心认识的 `ScheduledTask`。
 *  两类任务在这一步之后就没有区别了：同一个 Job 类、同一张账本、同一套历次执行查询。 */
import { join } from 'node:path'
import { runExternal } from './exec-runner.ts'
import type { PackageAction } from './package-actions.ts'
import type { UserTaskRow } from './task-store.ts'
import type { ScheduledTask } from './types.ts'

export interface CompileOptions {
  logDir?: string
  exec?: typeof runExternal
  /** 全局动作名 → 实现（`activate()` 交出来的那些，见 `package-actions.ts`）。 */
  actions?: (name: string) => PackageAction | undefined
  /**
   * 这条任务绑的那格配置 row 的**生效值**（分层合并后）。动作型任务的参数只从这里来。
   *
   * **必须是调用时才取**，不能在编译期取一次存下来：用户在界面上改完那格（比如把"真下单"
   * 勾上），下一轮就该按新的来。存快照的表现是"改了没反应"，而且不报错。
   */
  paramsFor?: (ref: string) => Record<string, unknown>
}

export function compileUserTask(row: UserTaskRow, opts: CompileOptions = {}): ScheduledTask {
  return {
    id: row.id,
    label: row.label,
    schedule: row.schedule,
    ...(row.timezone === undefined ? {} : { timezone: row.timezone }),
    ...(row.group === undefined ? {} : { group: row.group }),
    serial: row.serial,
    ...(row.exclusiveOn === undefined ? {} : { exclusiveOn: row.exclusiveOn }),
    ...(row.whenBusy === undefined ? {} : { whenBusy: row.whenBusy }),
    maxAttempts: row.maxAttempts,
    notBefore: row.createdAt,
    run: row.action !== undefined ? runAction(row, opts) : runCommand(row, opts),
  }
}

/**
 * 执行体之二：调一个包提供的动作。
 *
 * **动作不在名录里就抛**，不是跳过：一条任务安安静静地什么都不做，和"它跑了、没事可做"
 * 长得一模一样。包被关掉、包装载失败、动作名打错——三种都该在这条任务的历次执行里红一次。
 */
function runAction(row: UserTaskRow, opts: CompileOptions): ScheduledTask['run'] {
  const name = row.action!
  return async () => {
    const fn = opts.actions?.(name)
    if (!fn) {
      throw new Error(
        `没有这个动作：${name}——提供它的包可能被关掉了、装载失败了，或者这个名字打错了`,
      )
    }
    // 没绑配置格 = 空参数袋。动作自己决定这算不算错（缺账号该由动作说"没有登录态"，
    // 而不是由这里替它判——它比调度器清楚自己要什么）。
    const params = row.configRef !== undefined ? (opts.paramsFor?.(row.configRef) ?? {}) : {}
    return await fn(params)
  }
}

/** 执行体之一：跑一条外部命令（原样保留）。 */
function runCommand(row: UserTaskRow, opts: CompileOptions): ScheduledTask['run'] {
  const exec = opts.exec ?? runExternal
  const command = row.command
  return async () => {
    if (command === undefined || command === '') {
      throw new Error(`任务 ${row.id} 既没有 command 也没有 action，跑不起来`)
    }
    return await exec({
      command,
      args: row.args,
      ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
      ...(row.env === undefined ? {} : { env: row.env }),
      ...(row.timeoutMs === undefined ? {} : { timeoutMs: row.timeoutMs }),
      ...(opts.logDir ? { logFile: join(opts.logDir, `${row.id}.log`) } : {}),
    })
  }
}

export function compileEnabled(rows: UserTaskRow[], opts: CompileOptions = {}): ScheduledTask[] {
  return rows.filter((r) => r.enabled).map((r) => compileUserTask(r, opts))
}
