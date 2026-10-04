import type { Registry } from '../registry/registry.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceHealthStore } from '../source-health-store.ts'
import type { AuthSpec, SourceManifest } from '../manifest/types.ts'
import { makeMemberPipeline, type PipelineMember, type RunMember } from '../providers/member-pipeline.ts'
import { SourceBreaker } from '../providers/breaker.ts'

export type CredentialResolveFn = (auth: AuthSpec) => Promise<Record<string, string>>

export interface ResolveResult {
  source: string
  items: unknown[]
}

export interface ResolveEngineOpts {
  registry: Registry
  adapters: Map<string, Adapter>
  health: SourceHealthStore
  resolveCreds: CredentialResolveFn
  /** Source-owned runtime configuration, private to the adapter execution boundary. */
  runtimeConfigFor?: (manifest: SourceManifest) => Record<string, unknown>
  /** Force-repull a cookie/token, then re-resolve — used to recover from a stale credential:
   *  a cookie source that fails gets one retry with a freshly re-pulled credential. */
  refreshCreds?: CredentialResolveFn
  /** map a target key into the source's fetch params (e.g. 曲目 id → {id}) */
  buildParams: (m: SourceManifest, key: string) => Record<string, unknown>
  /** Provider 行对齐（可选）：order 返回该 target-type 命中行的现役成员（auto 段已展开、去重），
   *  null = 无行，沿用 provides 派生梯子。成员带 params（$input 未填）——行不再只是排序覆盖，
   *  而是梯子本身的来源：{mode:'auto', matches} 展开出的目录源即使不声明 provides 也进梯子，
   *  成员 params 在每次 fetch 时以 key 填洞（catalog 路由的 :id/:level? 由此得到值）。
   *  count 在每次真实 attempt 时打点（与 executor 写同一份 provider_calls）。 */
  providerRows?: {
    /** name = 成员寻址键（同源多实例时是实例名），sourceId = 真源 id（manifest 按它查；
     *  缺省时退化成 name，与实例名机制引入前一致）。 */
    order: (targetType: string) => Array<{ name: string; sourceId?: string; params?: Record<string, unknown> }> | null
    count: (targetType: string, member: string) => void
  }
  /** 熔断器的时钟（测试注入）。省略 = Date.now。 */
  now?: () => number
}

/** 梯子一档：源 manifest + 该成员在 Provider 行里绑定的参数（$input 未填）。
 *  member = 计数用的寻址键（行成员的实例名，缺省 = manifest id）——健康档仍按 manifest id 记，
 *  同一个源的两个实例共享它。 */
interface LadderRung {
  m: SourceManifest
  params?: Record<string, unknown>
  member?: string
}

/** 参数洞填充：值为 '$input' 的键在 resolve 时换成 key。 */
function fillHoles(params: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  if (!params) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) out[k] = v === '$input' ? key : v
  return out
}

/**
 * The one acquisition primitive: resolve a Target (target-type : key) by trying the Sources
 * that `provides` the type, in priority order, with failover — reusing the source-failover
 * health ledger. A hard error OR an empty result falls through to the next rung (one-shot
 * "this source couldn't answer this key" semantics); the first non-empty result wins.
 *
 * 调用方是**交互式**的那两处：`GET /api/resolve` 与 MCP `resolve_target`。周期订阅采集不走这里
 * （它走 `Scheduler.fetchSource`），别照"这条路上有采集"去推断超时/成本口径。
 *
 * 执行套件与 ProviderExecutor 共用（spec §7 二期并轨）：碰成员的唯一口子是单成员管道
 * （打点 → 超时 → 分类 → 记健康账），降级裁决由同一个 `SourceBreaker` 给出——**原序不重排**，
 * 只回答"这一档这一下试不试"。
 */
export class ResolveEngine {
  private readonly breaker: SourceBreaker
  /** 碰成员的唯一口子。字段在构造体里赋值：类字段初始化式先于构造参数属性求值，那时 opts 还没有。 */
  private readonly runMember: RunMember

  constructor(private readonly opts: ResolveEngineOpts) {
    this.breaker = new SourceBreaker(opts.health, opts.now)
    this.runMember = makeMemberPipeline({
      // 打点接到行的计数器上：providerId 位置传 targetType（resolve 的"行"就是 target-type 的梯子）。
      // 语义不变——每次真实 attempt 记一次，被熔断跳过的不记。
      stats: { record: (targetType, member) => this.opts.providerRows?.count(targetType, member) },
      declaredTimeoutMs: (sourceId) => opts.registry.get(sourceId)?.member_timeout_ms,
      // **defaultTimeoutMs 暂不注入**——不是因为这条路上有采集（周期采集走 Scheduler，不经这里），
      // 恰恰相反：调用方全是交互式的，确实可能被一个挂死的源拖住。之所以还不设全局闸，是因为
      // 墙钟上限眼下有两套并存的表（executor 那档 25s 与各处 manifest 自报），值该定在哪一层要
      // 随 docs/TODO.md「单源墙钟上限有两套并存的表」一起定，先设一个第三个数只会再多一套。
      // 短期靠 manifest 自报的 member_timeout_ms 兜——慢源自己申报。
      health: opts.health,
      isCompositionError: () => false, // resolve 没有组合子成员，无环/超深可言
    })
  }

  /** 一次成员调用包成管道成员：空批（`[]`）折成 null = decline miss，对齐 resolve 原本
   *  "这一档答不了这个 key，落下一档"的语义（空永不触发熔断）。 */
  private rungMember(rung: LadderRung, key: string, extra?: Record<string, unknown>): PipelineMember {
    const { m, params, member } = rung
    return {
      name: member ?? m.id,
      sourceId: m.id,
      kind: 'source',
      attempt: async () => {
        const items = await this.fetchOne(m, key, params, extra)
        return items.length ? items : null
      },
    }
  }

  async resolve(targetType: string, key: string, extra?: Record<string, unknown>): Promise<ResolveResult | null> {
    const ladder = this.ladderOf(targetType)
    if (!ladder.length) return null

    // 裁决整表预计算（含"全员冷却时强行探剩余最短那一档"的兜底不变量）——与顺次策略共用
    // 同一份 `SourceBreaker.plan`，这条不变量只有一个家。
    const plan = this.breaker.plan(ladder.map((rung) => rung.m.id))
    for (const [i, rung] of ladder.entries()) {
      if (!plan[i].allow) continue // 熔断冷却中——跳过，不打点、不记账
      const o = await this.runMember(targetType, this.rungMember(rung, key, extra), () => true)
      if (o.kind === 'win') return { source: rung.m.id, items: o.value as unknown[] }
      // miss（空）/ error / timeout 一律落下一档；记账已在管道里做完
    }
    return null
  }

  /** Public: the resolve ladder as manifests, in the order resolve() would try them — the Provider
   *  row's expanded members if a resolve row matches (so {mode:'auto', matches} catalog sources
   *  appear even without a `provides` tag), else the provides-derived ladder. Candidate lists +
   *  doctor views read this so they reflect the same ladder resolution uses. */
  resolveLadder(targetType: string): SourceManifest[] {
    return this.ladderOf(targetType).map((rung) => rung.m)
  }

  /** 梯子来源：命中 Provider 行 → 行的现役成员（auto 段已展开、去重，带 params）映射成 manifest；
   *  无行 → provides 派生梯子。行成员是梯子的权威来源——{mode:'auto', matches} 展开出的目录源
   *  即使不声明 provides 也进梯子，这正是退役 curated 条目后取歌 Provider 行仍能解析的原因。 */
  private ladderOf(targetType: string): LadderRung[] {
    const rowOrder = this.opts.providerRows?.order(targetType)
    if (!rowOrder) return this.opts.registry.providersOf(targetType).map((m) => ({ m }))
    const out: LadderRung[] = []
    for (const ref of rowOrder) {
      const m = this.opts.registry.get(ref.sourceId ?? ref.name)
      if (m) out.push({ m, params: ref.params, member: ref.name })
    }
    return out
  }

  /** 单源直取（ProviderExecutor 的 source 型成员走这里）：按 sourceId 取 manifest 并 fetch。
   *  与 resolve() 同一条 adapter/credential/sidecar 路径，不带梯子语义。 */
  async fetchSource(sourceId: string, key: string, extra?: Record<string, unknown>): Promise<unknown[]> {
    const m = this.opts.registry.get(sourceId)
    if (!m) throw new Error(`[resolve] unknown source ${sourceId}`)
    return this.fetchOne(m, key, undefined, extra)
  }

  private async fetchOne(
    m: SourceManifest, key: string, memberParams: Record<string, unknown> | undefined, extra?: Record<string, unknown>,
  ): Promise<unknown[]> {
    const adapter = this.opts.adapters.get(m.adapter)
    if (!adapter) throw new Error(`[resolve] no adapter "${m.adapter}" for source ${m.id}`)
    // member params (row-bound, $input filled from the key) sit between the built key params and
    // the call-time extra — so a catalog route's :id/:level? get their values while the caller's
    // own params (subscription params) still win.
    const params = { ...this.opts.buildParams(m, key), ...fillHoles(memberParams, key), ...extra }
    const attempt = async (env: Record<string, string>): Promise<unknown[]> => {
      await adapter.init(env)
      if (adapter.sidecar) {
        await adapter.sidecar.start(env)
        if (!(await adapter.sidecar.health())) throw new Error(`[resolve] sidecar for "${m.adapter}" unhealthy`)
      }
      const got = await adapter.fetch(params, m, { runtimeConfig: this.opts.runtimeConfigFor?.(m) ?? {} })
      return Array.isArray(got) ? got : got.items
    }
    try {
      return await attempt(await this.opts.resolveCreds(m.auth))
    } catch (e) {
      // A cookie-backed source can fail because the cookie went stale. We can't tell that apart
      // from other errors (RSSHub swallows the upstream's -101/-412 into a generic throw), so we
      // don't try: on ANY failure of a cookie source, re-pull the credential once (the user may
      // have re-logged in → the snapshot has a fresh one) and retry. Still failing → propagate.
      if (m.auth.type !== 'cookie' || !this.opts.refreshCreds) throw e
      return await attempt(await this.opts.refreshCreds(m.auth))
    }
  }
}
