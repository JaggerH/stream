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
  readonly deviceId: string
  // 显式赋值而不是参数属性：本文件在 StreamTaskJob 的可达图里，sidequest 的 inline runner 用
  // Node 原生 import 装载 jobs 文件——strip-only 模式过不了参数属性（要 transform 才行），
  // 留着它，每条任务都会在装载期记 failed。
  constructor(deviceId: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.deviceId = deviceId
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
  readonly need: string
  constructor(deviceId: string, need: string) {
    super(deviceId, `设备 ${deviceId} 没有 ${need} 能力——检查绑定，或在这台设备上启用它`)
    this.need = need
  }
}

export class HostNotAllowed extends DeviceError {
  readonly code = 'host-not-allowed'
  readonly retryable = false
  readonly host: string
  constructor(deviceId: string, host: string) {
    super(deviceId, `不允许经设备 ${deviceId} 访问 ${host}——它不在本次执行所属包声明的主机里（stream.network.hosts）`)
    this.host = host
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
  readonly code: string
  constructor(deviceId: string, code: string, detail: string) {
    super(deviceId, `设备 ${deviceId} 拒绝或未能完成请求（${code}）：${detail}`)
    this.code = code
  }
}

/**
 * 按身份 / 环境执行时的三种失败（browser-identity D11）。**都发生在派发任何动作之前**——选节点、唤起、核对
 * 这三步一个请求都不发。分档的判据与设备错误一样：没找到能用的节点（`identity-offline`）是环境没就绪，
 * 按 `maxAttempts` 重试；核对出换号 / 登出是确定的事实，重跑一遍还是同一个答案，不重试、交给人。
 *
 * 不继承 `DeviceError`：身份没找到时根本没有「哪台设备」可说，硬塞一个设备 id 进去，通知上就会冒出一句
 * 「设备 ? 不在线」。
 */
export abstract class IdentityError extends Error {
  abstract readonly code: string
  abstract readonly retryable: boolean
  readonly facility: string
  readonly target: string
  // 参数属性禁用，理由同 DeviceError。
  constructor(facility: string, target: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.facility = facility
    this.target = target
    this.name = new.target.name
  }
}

export class IdentityOffline extends IdentityError implements DeclaresEnvironmentUnavailable {
  readonly code = 'identity-offline'
  readonly retryable = true
  /** 采集侧：节点都不在、也唤不起——本轮跳过而不是判源故障，同 `DeviceOffline`。 */
  readonly environmentUnavailable = true
  constructor(facility: string, target: string, reason: string) {
    super(facility, target, `${target} 没有可用的浏览器节点（${reason}）——这次执行没有发出任何请求，也不会换成别的身份、设备或本机执行`)
  }
}

export class IdentityMismatch extends IdentityError {
  readonly code = 'identity-mismatch'
  readonly retryable = false
  readonly nodeId: string
  readonly found: string
  constructor(facility: string, target: string, nodeId: string, found: string, where: string) {
    super(facility, target, `${where}里的 ${facility} 现在登的是 ${found}，不是${target}——没有执行，也不会自动重试`)
    this.nodeId = nodeId
    this.found = found
  }
}

export class IdentitySignedOut extends IdentityError {
  readonly code = 'identity-signed-out'
  readonly retryable = false
  /** 采集侧落进「需要登录」（`classifyError` 认这个声明）：它就是一次登录失效，只是知道是哪个 profile。 */
  readonly failureCategory = 'auth' as const
  readonly nodeId: string
  constructor(facility: string, target: string, nodeId: string, where: string) {
    super(facility, target, `${where}里的 ${facility} 已登出（${target}）——没有执行，需要在那个 profile 里重新登录`)
    this.nodeId = nodeId
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
    if (cur instanceof DeviceError || cur instanceof IdentityError) return cur.retryable ? 'retry' : 'final'
    if (cur.name === 'HostAbortedByUser') return 'final'
  }
  return 'retry'
}
