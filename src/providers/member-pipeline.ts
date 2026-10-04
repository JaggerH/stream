import type { Outcome as HealthOutcome } from '../source-health-store.ts'
import type { BlockedReason } from '../blocked.ts'
import { blockedOf } from '../blocked.ts'
import { isRetryable } from '../retryable.ts'
import { isUnavailable } from './unavailable.ts'
import type { InvokeMiss, InvokeTiming } from './invoke-types.ts'

/** 单成员执行管道——所有策略碰成员的唯一口子（spec §4）。固定五步里的 2–5：
 *  打点 → 套超时 → 执行并分类 → 记健康账。第 1 步（熔断裁决）在策略层做——
 *  裁决是否跳过属于编排决定（并发面第一期不接熔断），执行与记账才是横切。 */
export interface MemberOutcome {
  member: string
  sourceId: string
  kind: 'win' | 'miss' | 'error' | 'timeout'
  value?: unknown
  reason?: string
  stack?: string
  ms: number
  retryable?: boolean
  blocked?: BlockedReason
  /** 内容本身没有（成员抛的错自述 unavailable，见 `./unavailable.ts`）；同 retryable/blocked 不记健康账。 */
  unavailable?: true
}

export interface PipelineMember {
  name: string
  sourceId: string
  /** 'provider'（组合子行）跳过记账——子行自己的叶子成员各自记，provider id 不进源健康账本。 */
  kind: 'source' | 'provider'
  attempt: () => Promise<unknown | null>
}

export interface MemberPipelineDeps {
  stats: { record: (providerId: string, member: string) => void }
  /** manifest.member_timeout_ms（源自报的墙钟；拟人路径天然慢于纯 HTTP，按源申报只让它自己的
   *  那一格慢）。**它是「一个源封顶多久」的唯一真相源**——流式搜索路（`search-fanout.ts` 的
   *  `searchOneGroup`）读的也是这一格。要给某个源放宽就改它的 manifest/recipe，别在消费端旁边
   *  再立一张表：那样同一个源在两条路上会拿到两个上限，而两边单看都对。 */
  declaredTimeoutMs: (sourceId: string) => number | undefined
  /** 全局缺省墙钟。0 / 省略 = 不设限。opts.timeoutMs > declared > default。 */
  defaultTimeoutMs?: number
  health?: { record: (sourceId: string, o: HealthOutcome) => unknown }
  /** 组合防护错误（环/超深）是配置错误：原样上抛，不进分类。 */
  isCompositionError: (e: unknown) => boolean
}

class MemberTimeoutError extends Error {
  constructor(msg: string) { super(msg); this.name = 'MemberTimeoutError' }
}

export type RunMember = (
  providerId: string, m: PipelineMember, accept: (r: unknown) => boolean,
  opts?: { timeoutMs?: number },
) => Promise<MemberOutcome>

export function makeMemberPipeline(deps: MemberPipelineDeps): RunMember {
  const noteHealth = (m: PipelineMember, o: HealthOutcome): void => {
    if (m.kind !== 'source') return
    try {
      deps.health?.record(m.sourceId, o)
    } catch {
      /* 记账失败绝不连累这次调用——账本是观测，不是链路的一环 */
    }
  }
  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<T>((_, rej) => {
      timer = setTimeout(() => rej(new MemberTimeoutError(`member "${label}" timed out after ${ms}ms`)), ms)
      timer.unref?.()
    })
    return Promise.race([p.finally(() => clearTimeout(timer)), timeout])
  }

  return async (providerId, m, accept, opts) => {
    deps.stats.record(providerId, m.name)
    const ms = opts?.timeoutMs ?? deps.declaredTimeoutMs(m.sourceId) ?? deps.defaultTimeoutMs
    const t0 = performance.now()
    const elapsed = (): number => Math.round(performance.now() - t0)
    try {
      const r = ms && ms > 0 ? await withTimeout(m.attempt(), ms, m.name) : await m.attempt()
      if (r != null && accept(r)) {
        // 批量成员（resolve 梯子那种返回 item 数组的）记真实条数——lifetimeItemCount 是
        // "这个源产出过没有"的判据，也是订阅漂移侦测的输入；把一批 20 条记成 1 会低估它。
        // 非数组（单值成员，如 invoke 的一个 URL）没有条数概念，按 1 记。
        noteHealth(m, { kind: 'ok', itemCount: Array.isArray(r) ? r.length : 1 })
        return { member: m.name, sourceId: m.sourceId, kind: 'win', value: r, ms: elapsed() }
      }
      noteHealth(m, { kind: 'empty' })
      return {
        member: m.name, sourceId: m.sourceId, kind: 'miss', ms: elapsed(),
        reason: r == null ? 'declined (no result)' : 'result did not meet the contract',
      }
    } catch (e) {
      if (deps.isCompositionError(e)) throw e
      const err = e as Error
      if (e instanceof MemberTimeoutError) {
        noteHealth(m, { kind: 'error', message: err.message, category: 'timeout' })
        return { member: m.name, sourceId: m.sourceId, kind: 'timeout', reason: err.message, stack: err.stack, ms: elapsed() }
      }
      const blocked = blockedOf(e)
      const retryable = isRetryable(e)
      const unavailable = isUnavailable(e)
      // 环境没就绪（扩展没连、容器还在唤醒）不是这个源的健康问题——记成失败，用户关一晚电脑
      // 第二天满屏红。判据与 scheduler 那条同源：可重试 / 缺前置条件 → 不记账。
      // 「内容本身没有」（作品被删 / 无权限）同理：那是内容的事，不是这个源坏了。
      if (!retryable && !blocked && !unavailable) noteHealth(m, { kind: 'error', message: err.message })
      return {
        member: m.name, sourceId: m.sourceId, kind: 'error', reason: err.message, stack: err.stack, ms: elapsed(),
        ...(retryable ? { retryable: true } : {}), ...(blocked ? { blocked } : {}),
        ...(unavailable ? { unavailable: true } : {}),
      }
    }
  }
}

/** MemberOutcome → 线上 InvokeMiss（对外形状不变；win 不该进来，防御性兜 reason）。 */
export function missOf(o: MemberOutcome): InvokeMiss {
  return {
    member: o.member, reason: o.reason ?? '', ...(o.stack ? { stack: o.stack } : {}),
    ...(o.retryable ? { retryable: true } : {}), ...(o.blocked ? { blocked: o.blocked } : {}),
    ...(o.unavailable ? { unavailable: true } : {}),
  }
}

/** MemberOutcome → 线上 InvokeTiming。timeout 映射成 'error'——线上联合保持三值不变。 */
export function timingOf(o: MemberOutcome): InvokeTiming {
  return {
    member: o.member, source: o.sourceId, ms: o.ms,
    outcome: o.kind === 'win' ? 'win' : o.kind === 'miss' ? 'miss' : 'error',
  }
}
