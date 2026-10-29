/**
 * 公网入口上的两件小事：**请求速率**与**按来源锁定**。
 *
 * 6 位配对码只有 10^6 种，5 分钟有效；没有限流时，公网上的一个脚本几分钟就能走一遍。
 * 码本身已经有「连错 5 次全部作废」的防线（`device-store.ts`），但那会连带把用户手里的
 * 真码作废——所以入口这层还要按来源计数：错太多次就冷掉这个来源，冷却期内连正确的码
 * 也换不到 token，且不会因为对方猜错而让别的来源受影响。
 *
 * 时钟可注入（测试不睡真实时间）。
 */

export interface TokenBucketOptions {
  /** 满桶能放行几次（突发） */
  capacity: number
  /** 每秒补几个 */
  refillPerSecond: number
  now?: () => number
  /** 桶数上限；超过时先丢已经补满的（它们再打一次就回来，丢了不改变行为） */
  maxKeys?: number
}

interface Bucket {
  tokens: number
  at: number
}

/** 简单的令牌桶，按 key 各一桶；key 缺省（拿不到来源）时共用一个桶。 */
export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly now: () => number
  private readonly maxKeys: number

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity
    this.refillPerSecond = opts.refillPerSecond
    this.now = opts.now ?? Date.now
    this.maxKeys = opts.maxKeys ?? 10_000
  }

  take(key: string | undefined): boolean {
    const k = key ?? ''
    const t = this.now()
    const b = this.buckets.get(k)
    const tokens = b ? Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSecond) : this.capacity
    const ok = tokens >= 1
    this.buckets.set(k, { tokens: ok ? tokens - 1 : tokens, at: t })
    if (this.buckets.size > this.maxKeys) this.prune(t)
    return ok
  }

  size(): number {
    return this.buckets.size
  }

  private prune(t: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 1000) * this.refillPerSecond >= this.capacity) this.buckets.delete(k)
      if (this.buckets.size <= this.maxKeys) return
    }
  }
}

export interface PairingGuardOptions {
  now?: () => number
  /** 同一来源在窗口内错几次就冷却（缺省 5，与码自身的作废阈值一致） */
  maxFailures?: number
  failureWindowMs?: number
  cooldownMs?: number
  /** 请求令牌桶：突发次数与每秒补充（缺省 10 / 0.2，即每分钟 12 次） */
  burst?: number
  refillPerSecond?: number
}

interface SourceState {
  failures: number
  firstFailureAt: number
  blockedUntil: number
}

/**
 * 配对口（设备码、扩展码）的守卫：先过请求令牌桶，再按来源累计失败；到阈值冷却这个来源。
 * 冷却期内的请求**不消耗**令牌桶、也不再看码——正确的码同样换不到 token。
 */
export class PairingGuard {
  private readonly sources = new Map<string, SourceState>()
  private readonly bucket: TokenBucket
  private readonly now: () => number
  private readonly maxFailures: number
  private readonly failureWindowMs: number
  private readonly cooldownMs: number

  constructor(opts: PairingGuardOptions = {}) {
    this.now = opts.now ?? Date.now
    this.maxFailures = opts.maxFailures ?? 5
    this.failureWindowMs = opts.failureWindowMs ?? 10 * 60_000
    this.cooldownMs = opts.cooldownMs ?? 10 * 60_000
    this.bucket = new TokenBucket({
      capacity: opts.burst ?? 10,
      refillPerSecond: opts.refillPerSecond ?? 0.2,
      now: this.now,
      maxKeys: 10_000,
    })
  }

  /** 这次请求准不准进。false → 调用方回 429。 */
  allow(source: string | undefined): boolean {
    const st = this.state(source)
    const t = this.now()
    if (st.blockedUntil > t) return false
    if (st.blockedUntil !== 0) {
      // 冷却结束：清掉，重新开始计数
      st.blockedUntil = 0
      st.failures = 0
    }
    return this.bucket.take(source)
  }

  /** 记一次失败（码不对 / 格式不对都算）。到阈值就让这个来源冷却。 */
  fail(source: string | undefined): void {
    const st = this.state(source)
    const t = this.now()
    if (st.failures === 0 || t - st.firstFailureAt > this.failureWindowMs) {
      st.failures = 1
      st.firstFailureAt = t
    } else {
      st.failures++
    }
    if (st.failures >= this.maxFailures) {
      st.blockedUntil = t + this.cooldownMs
      st.failures = 0
      st.firstFailureAt = 0
    }
  }

  /** 成功一次：这个来源的失败计数清零。 */
  succeed(source: string | undefined): void {
    const st = this.sources.get(source ?? '')
    if (!st) return
    st.failures = 0
    st.firstFailureAt = 0
  }

  /** 冷却还剩几秒（0 = 没被冷却）。 */
  retryAfterSeconds(source: string | undefined): number {
    const st = this.sources.get(source ?? '')
    if (!st) return 0
    const left = st.blockedUntil - this.now()
    return left > 0 ? Math.ceil(left / 1000) : 0
  }

  private state(source: string | undefined): SourceState {
    const k = source ?? ''
    let st = this.sources.get(k)
    if (!st) {
      st = { failures: 0, firstFailureAt: 0, blockedUntil: 0 }
      this.sources.set(k, st)
    }
    return st
  }
}

/** `/api/ext/verify` 的缺省令牌桶：每次扩展连接打一次，突发 30、每秒 1 个足够。 */
export const EXT_VERIFY_LIMIT: TokenBucketOptions = { capacity: 30, refillPerSecond: 1 }
