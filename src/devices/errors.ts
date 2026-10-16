/**
 * 设备执行的失败分类。分两档的判据只有一句：**有没有可能已经有动作发出去了。**
 * 没发出（设备离线、排队超时）→ 可以按任务的 `maxAttempts` 重试；可能发出了（中途断连、
 * 设备回报网络错）或者是配置错误（能力不足、主机不允许）→ 不重试。一个下了一半单的动作
 * 被自动重跑就是重复下单。权威设计：openspec/changes/device-execution/design.md D9。
 */
import type { DeclaresEnvironmentUnavailable } from '../../shared/failure/environment.ts'
export abstract class DeviceError extends Error {
  abstract readonly code: string
  abstract readonly retryable: boolean
  constructor(readonly deviceId: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export class DeviceOffline extends DeviceError implements DeclaresEnvironmentUnavailable {
  readonly code = 'device-offline'
  readonly retryable = true
  /** 采集侧：什么都没发出，本轮跳过而不是判源故障（shared/failure/environment.ts）。 */
  readonly environmentUnavailable = true
  constructor(deviceId: string) {
    super(deviceId, `设备 ${deviceId} 不在线——这次执行没有发出任何请求，也不会改在主实例上执行`)
  }
}

export class DeviceFetchQueueTimeout extends DeviceError implements DeclaresEnvironmentUnavailable {
  readonly code = 'device-fetch-queue-timeout'
  readonly retryable = true
  readonly environmentUnavailable = true
  constructor(deviceId: string) {
    super(deviceId, `设备 ${deviceId} 的请求排队超时（在途已满）——请求没有发出`)
  }
}

export class DeviceIncapable extends DeviceError {
  readonly code = 'device-incapable'
  readonly retryable = false
  constructor(deviceId: string, readonly need: string) {
    super(deviceId, `设备 ${deviceId} 没有 ${need} 能力——检查绑定，或在这台设备上启用它`)
  }
}

export class HostNotAllowed extends DeviceError {
  readonly code = 'host-not-allowed'
  readonly retryable = false
  constructor(deviceId: string, readonly host: string) {
    super(deviceId, `不允许经设备 ${deviceId} 访问 ${host}——它不在本次执行所属包声明的主机里（stream.network.hosts）`)
  }
}

export class DeviceLost extends DeviceError {
  readonly code = 'device-lost'
  readonly retryable = false
  constructor(deviceId: string, cause?: unknown) {
    super(deviceId, `执行途中与设备 ${deviceId} 失联——动作可能已部分发出，状态未知，需要人工核对；不会自动重试`, { cause })
  }
}

/** agent 拒绝或执行失败时回报的错误（`private-target` / `too-large` / `network` / `timeout` / `host-not-allowed`）。 */
export class DeviceRefused extends DeviceError {
  readonly retryable = false
  constructor(deviceId: string, readonly code: string, detail: string) {
    super(deviceId, `设备 ${deviceId} 拒绝或未能完成请求（${code}）：${detail}`)
  }
}

/**
 * 任务失败后要不要按 `maxAttempts` 再来。`HostAbortedByUser` 是用户的明确意图，同样不重试。
 * 顺着 `cause` 链找第一个认得的设备错误：包常把底层错误包进自己的 `Error(…, { cause })`，
 * 只看最外层就会把一个 device-lost 当普通失败重跑——重复下单。
 */
export function failureDisposition(e: unknown): 'retry' | 'final' {
  const seen = new Set<unknown>()
  for (let cur: unknown = e; cur instanceof Error && !seen.has(cur); cur = cur.cause) {
    seen.add(cur)
    if (cur instanceof DeviceError) return cur.retryable ? 'retry' : 'final'
    if (cur.name === 'HostAbortedByUser') return 'final'
  }
  return 'retry'
}
