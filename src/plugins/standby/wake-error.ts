import type { RetryableError } from '../../retryable.ts'

/** Thrown by wake() when a standby container's health probe never went green within
 *  startTimeoutSeconds. It is **retryable, not terminal**: the container almost certainly did
 *  NOT die — it is still loading (e.g. 声纹引擎装模型权重进显存,耗时随磁盘/显存状态
 *  波动,没有一个"够大"的常数),and the very next wake typically goes green in seconds. The cell
 *  is left `asleep` by wake()'s catch, so a later wake replays normally.
 *
 *  message 与旧的 plain-Error 抛法一字不差(`standby wake timeout for <svc> after <n>s`),
 *  这样日志/诊断文案零变化;新增的只有 `retryable` 自述标记,供上层(executor → 转写任务层)
 *  经 isRetryable() 识别为"该等一会儿重排"而非判死。 */
export class StandbyWakeTimeoutError extends Error implements RetryableError {
  readonly retryable = true as const
  constructor(service: string, seconds: number) {
    super(`standby wake timeout for ${service} after ${seconds}s`)
    this.name = 'StandbyWakeTimeoutError'
  }
}
