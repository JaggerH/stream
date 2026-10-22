/** `scheduled_tasks` 的行 → 调度中心认识的 `ScheduledTask`。
 *  两类任务在这一步之后就没有区别了：同一个 Job 类、同一张账本、同一套历次执行查询。 */
import { join } from 'node:path'
import { runExternal } from './exec-runner.ts'
import type { PackageAction } from './package-actions.ts'
import type { UserTaskRow } from './task-store.ts'
import type { ScheduledTask } from './types.ts'
import { LOCAL_DEVICE, runOnDevice, type DispatchMarker, type RunPlacement } from '../devices/run-context.ts'
import { DeviceError, DeviceLost } from '../devices/errors.ts'

export interface CompileOptions {
  /** 这条任务在哪台设备上执行（任务覆盖 → facility 默认 → local）。缺席 = local。见 src/devices/placement.ts。 */
  placement?: (row: UserTaskRow) => RunPlacement
  /** 派发前检查设备就绪（在线、有 http.fetch）；不就绪就抛，动作一次都不调。 */
  ready?: (p: RunPlacement) => void
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
    const resolved = opts.placement?.(row) ?? { deviceId: LOCAL_DEVICE, allowHosts: [] }
    if (resolved.deviceId === LOCAL_DEVICE) {
      opts.ready?.(resolved)
      return await runOnDevice(resolved, () => fn(params))
    }
    // 每次执行一个新标记：同一条任务的上一轮发没发过，和这一轮无关。
    const marker: DispatchMarker = { dispatched: false }
    // browser 记号由这里建好再交给 runOnDevice：它没有时 runOnDevice 会另建一份，那份在这里读不到，
    // 运行记录就说不出这次用的是哪个 Chrome。
    const browser: NonNullable<RunPlacement['browser']> = {}
    const p: RunPlacement = { ...resolved, dispatch: marker, browser }
    // 派发前的就绪检查原样抛（只加设备前缀）：此刻什么都没发，DeviceOffline 按 maxAttempts 重试是安全的。
    try {
      opts.ready?.(p)
    } catch (e) {
      throw nameDevice(p.deviceId, e)
    }
    let out: Awaited<ReturnType<PackageAction>>
    try {
      out = await runOnDevice(p, () => fn(params))
    } catch (e) {
      throw nameDevice(p.deviceId, marker.dispatched ? afterDispatch(p.deviceId, e) : e, marker.dispatched)
    }
    // 运行记录要看得出在哪台设备上跑的；local 原样返回，存量任务的明细形状不变。
    return {
      ...(out ?? { summary: '' }),
      detail: { device: p.deviceId, ...(browser.bindingId ? { browser: browser.bindingId } : {}), detail: out?.detail },
    }
  }
}

/**
 * 已经有请求经设备发出之后的失败：不管包怎么包、错误本身是不是"可重试"类，都必须是 final。
 * 已经是不重试的设备错误 / 用户中止 → 原样；其余（普通 Error、DeviceOffline、排队超时）包成
 * DeviceLost(cause=原错误)——第二笔撞上离线时，第一笔可能已经到了券商。
 */
function afterDispatch(deviceId: string, e: unknown): unknown {
  if (e instanceof DeviceError && !e.retryable) return e
  if (e instanceof Error && e.name === 'HostAbortedByUser') return e
  const lost = new DeviceLost(deviceId, e)
  // DeviceLost 的固定文案里没有原因；失败通知只剩这条消息，把包自己说的那句接上，不然没法核对。
  if (e instanceof Error && e.message) lost.message += `（原错误：${e.message}）`
  return lost
}

const UNKNOWN_STATE = '状态未知，需要人工核对'

/**
 * 非 local 执行的失败要说出在哪台设备上：任务通知与运行记录只有这条消息。**能改就改同一个实例的
 * message**——类、`cause`、`retryable` 都不动，failureDisposition 的判断不受影响；改不动的
 * （DOMException）见 `withMessage`。
 * 发出过请求之后的失败再补一句「状态未知」（DeviceLost 自己已经说了）。
 */
function nameDevice(deviceId: string, e: unknown, dispatched = false): unknown {
  if (!(e instanceof Error)) return e
  const prefix = `[设备 ${deviceId}] `
  let message = e.message
  if (dispatched && !message.includes(UNKNOWN_STATE)) message += `——已有请求经设备发出，${UNKNOWN_STATE}`
  if (!message.startsWith(prefix)) message = prefix + message
  return message === e.message ? e : withMessage(e, message)
}

/**
 * 改写错误消息，**改不动就包一层**。中止 / 超时信号给的 `reason` 是 DOMException，它的
 * `message` 只有 getter——严格模式下直接赋值抛 TypeError，原错误和设备名一起丢掉。包一层
 * 时原错误挂在 `cause` 上：`failureDisposition` 顺着 cause 判，重试与否不变。
 */
function withMessage(e: Error, message: string): Error {
  try { e.message = message } catch { /* 只读的 message（DOMException 等），走下面包一层 */ }
  return e.message === message ? e : new Error(message, { cause: e })
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
