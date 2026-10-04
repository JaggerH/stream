import type { Registry } from '../registry/registry.ts'
import type { ProviderRecord, ProviderCategory } from '../store/types.ts'
import type { ProviderStatsStore } from './stats-store.ts'
import { isParked } from './parked.ts'
import type { ProviderDirectory } from './directory.ts'
import type { Outcome as HealthOutcome } from '../source-health-store.ts'
import {
  type InvokeResult, type CollectResult,
  type MemberResult, providerItems, fillHoles,
} from './invoke-types.ts'
import { makeMemberPipeline, type RunMember } from './member-pipeline.ts'
import { SourceBreaker } from './breaker.ts'
import { builtinStrategies } from './strategies/index.ts'
import type { ExecutionStrategy, StrategyContext } from './strategies/types.ts'
export { sourceOf, fillHoles } from './invoke-types.ts'
export type { InvokeMiss, InvokeTiming, InvokeResult, CollectResult, MemberResult } from './invoke-types.ts'
/** expand 的单钻超时 / 总预算住在策略里（`strategies/expand.ts`）；这里 re-export 只为保住既有
 *  import 路径——搬家不该逼调用方改 import。 */
export { EXPAND_DRILL_TIMEOUT_MS, EXPAND_TOTAL_BUDGET_MS } from './strategies/expand.ts'

/** Provider 模型的全部运行时（docs/superpowers/plans/2026-07-02-provider-management.md）：
 *  调用点 = category + 键提取 + invoke()；分发 = serves 声明匹配（'*' 兜底）；
 *  顺次 = 第一个合格结果赢（decline/合同拒/抛错三类 miss 落档）；并发 = 全成员合并；执行策略是
 *  可换件的注册表（`strategies/`），加新策略不改这个文件。降级不重排、只跳过：`SourceBreaker`
 *  按健康账本裁决"这个成员这一下试不试"，顺序仍是行里定的原序。计数打点/超时/分类/健康账全经
 *  `member-pipeline`（碰成员的唯一口子）——顺次 / 并发 / expand 三条策略共用同一份横切。 */

/** 展开后的具体成员：name 供计数/misses/via，attempt 是干活闭包，params 是成员绑定的
 *  参数（$input 未填）——resolve 路径经 providerRows 拿它自行填洞。 */
interface ConcreteMember {
  /** 寻址键 = 成员引用的 `name ?? source`（实例名机制）。去重 / exclude / reorder / 账本 byMember /
   *  via / misses 全按它。不带实例名时 = sourceId，与实例名引入前一致。 */
  name: string
  /** 真源 id（`{provider}` 成员则是子行 id）——fetch、manifest 查询、health 一律按它，
   *  绝不用寻址键：同一个源的两个实例共享同一份 manifest / 健康档。 */
  sourceId: string
  params?: Record<string, unknown>
  /** 'source' = leaf source; 'provider' = a composed child Provider (recursively invoked). The two
   *  consumption paths (streaming / batch) read this to tell a leaf read from a composition. */
  kind: 'source' | 'provider'
  attempt: (input: unknown) => Promise<unknown | null>
}

/** 结果合同：命名策略（行里存 {accept:'lossless'}，不存代码）。
 *  源成员产出数组（adapter 契约），合同作用在首个元素上。 */
const contractUnit = (r: unknown): unknown => (Array.isArray(r) ? r[0] : r)
const CONTRACTS: Record<string, (r: unknown) => boolean> = {
  // 无损判据：无损容器格式，或位深 ≥16（下载调用点按需传 accept:'lossless' 启用）
  lossless: (raw) => {
    const v = contractUnit(raw) as { format?: string; bitDepth?: number }
    return ['flac', 'ape', 'wav', 'alac'].includes((v?.format ?? '').toLowerCase()) || (v?.bitDepth ?? 0) >= 16
  },
}

export interface ProviderExecutorDeps {
  /** 选行的唯一入口（category/key 匹配 + parked 过滤 + 兜底判定）。执行器自己不再判 serves，
   *  也不再直接读 store——行从这里来。 */
  directory: ProviderDirectory
  registry: Registry
  stats: ProviderStatsStore
  /** 成员执行路径（成员一律是 Source）：bootstrap 注入——builtin adapter 源直呼实现函数，
   *  其余走 ResolveEngine 的 adapter/credential 路径。 */
  fetchSource: (sourceId: string, input: unknown, params?: Record<string, unknown>) => Promise<MemberResult>
  /**
   * 并发扇出里单个成员的墙钟上限（毫秒）。0 / 省略 = 不设限（保持原行为）。
   *
   * 为什么必须有：并发扇出的总耗时 = **最慢那个成员**，所以没有这道闸时，任何一个源都能
   * 绑架整次搜索。活体 2026-07-29：内容搜索里 douyin-search 跑了 115s 和 139s，用户就等了
   * 两分钟——而 xhs 3s 的结果早就躺在那儿了。
   *
   * 超时的成员按**失败**落档（miss + timings 里 error），不是静默消失：用户要看到"这个源
   * 超时了"，而不是结果里悄悄少一个源。
   */
  perMemberTimeoutMs?: number
  /**
   * 健康度账本。**顺次梯子必须记它、也必须读它**——否则一条已经死掉的上游每次调用都会被
   * 从头试一遍。活体代价（2026-08-24）：某取歌行下的两个第三方解析源双双失效后，梯子照
   * 原序死试——单次 5.8s + 46.9s，重试 3 次 ≈ 每首歌 2.5 分钟。
   *
   * **读法是熔断，不是重排**：顺序是用户在行里定的，执行器无权动它（`SourceBreaker`）。
   * 账本只回答"这个成员这一下试不试"——只有错/超时进冷却，空永不触发（空是业务信号），
   * 冷却随连败递增且有封顶，所以死源最坏每个封顶周期被真实试探一次，绝不永久降级。
   * 记账在 `member-pipeline` 那一处，读账在熔断器那一处。权威设计见
   * `docs/superpowers/specs/2026-08-25-provider-execution-strategy-design.md`；`ResolveEngine.resolve`
   * 的顺次梯子走的就是这条管道、吃同一本健康账与同一个熔断器，见该 spec §7。
   *
   * 省略 = 不记不读（保持原行为）——测试与不关心失效的调用点不必接。
   */
  health?: {
    record: (sourceId: string, o: HealthOutcome) => unknown
    /** 熔断器真正消费的只有这三个字段（`SourceBreaker.admit`）——类型收窄到它，别把整份
     *  `HealthState` 抬进签名：多余字段只会诱人在别处从这个口子读健康账，账本读法只准走这里。 */
    get: (sourceId: string) => { lastOutcome: 'ok' | 'empty' | 'error'; consecutiveError: number; lastAt: string } | undefined
  }
  /** 熔断器的时钟（测试注入）。省略 = Date.now。 */
  now?: () => number
  /** 策略注册表。省略 = builtinStrategies()。 */
  strategies?: Map<string, ExecutionStrategy>
}

/** 组合防护错误(威胁模型的一部分):自引用/环 → ProviderCycleError;超深 → ProviderDepthError。
 *  这两类是**配置错误**、不是成员 miss——run* 的 try/catch 遇到它们必须重新抛出、不得吞成 miss,
 *  否则深层组合的防护会被父级的 Promise.all/try-catch 静悄悄咽掉(见 isCompositionError 用处)。 */
export class ProviderCycleError extends Error { constructor(msg: string) { super(msg); this.name = 'ProviderCycleError' } }
export class ProviderDepthError extends Error { constructor(msg: string) { super(msg); this.name = 'ProviderDepthError' } }
export const MAX_COMPOSITION_DEPTH = 8
const isCompositionError = (e: unknown): boolean => e instanceof ProviderCycleError || e instanceof ProviderDepthError

export class ProviderExecutor {
  private readonly strategies: Map<string, ExecutionStrategy>
  private readonly breaker: SourceBreaker
  /** 碰成员的唯一口子：打点 → 超时 → 分类 → 记健康账，四件事只在这一处。 */
  private readonly runMember: RunMember

  // 三件都在构造体里建，**不能写成字段初始化式**：类字段先于构造参数属性求值（esbuild /
  // useDefineForClassFields 的语义），那时 `this.deps` 还是 undefined，整个执行器建不出来。
  constructor(private readonly deps: ProviderExecutorDeps) {
    this.strategies = deps.strategies ?? builtinStrategies()
    this.breaker = new SourceBreaker(deps.health, deps.now)
    this.runMember = makeMemberPipeline({
      stats: deps.stats,
      declaredTimeoutMs: (sourceId) => deps.registry.get(sourceId)?.member_timeout_ms,
      defaultTimeoutMs: deps.perMemberTimeoutMs,
      health: deps.health,
      isCompositionError,
    })
  }

  /** 策略与执行器之间的唯一接缝：策略只看得见成员视图 + run/admit 两个动词。取数不外露——
   *  策略要现算参数取一次数就递一份 `source` 描述（`StrategySourceCall`），构造 attempt 与包装
   *  空批的活在这里做，于是没有任何一条绕过 `runMember` 的路。 */
  private strategyContext(record: ProviderRecord, members: ConcreteMember[], input: unknown, accept: (r: unknown) => boolean): StrategyContext {
    const byName = new Map(members.map((m) => [m.name, m]))
    return {
      record, input, accept,
      members: members.map(({ name, sourceId, kind }) => ({ name, sourceId, kind })),
      run: (m, opts) => {
        let attempt: (() => Promise<unknown | null>)
        const src = opts?.source
        if (src) {
          // 声明式源调用：expand 的 A 壳 / B 钻——params 是策略从 $input / A-item 现算的,不在成员
          // 声明里,所以走这一支而不是标准成员。
          attempt = async (): Promise<unknown | null> => {
            const r = await this.deps.fetchSource(m.sourceId, src.input !== undefined ? src.input : input, src.params)
            // 'ok' = 空批也算 win（钻空是业务常态,不占熔断账）；'decline' = 空批归 null,
            // 与 sourceMember 的 items 型语义逐字一致。
            if (src.empty === 'ok') return Array.isArray(r) ? r : []
            if (r == null) return null
            return Array.isArray(r) ? (r.length ? r : null) : r
          }
        } else {
          // 没带 source 描述时,m 必须是本行展开出来的标准成员。查不到 = 策略自造了成员视图却没说
          // 要取哪个源——那不是"这个成员失败了",是策略写错了。所以在**进管道之前**同步抛：留着
          // `!` 会在闭包里炸成 TypeError,被管道 catch 分类成 error miss,伪装成上游挂了。
          const concrete = byName.get(m.name)
          if (!concrete) throw new Error(`[provider] strategy asked to run unknown member "${m.name}" (row ${record.id}) without a source call`)
          attempt = (): Promise<unknown | null> => concrete.attempt(input)
        }
        return this.runMember(record.id, { name: m.name, sourceId: m.sourceId, kind: m.kind, attempt }, accept,
          opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined)
      },
      admit: (m) => (m.kind === 'provider' ? { allow: true } : this.breaker.admit(m.sourceId)),
    }
  }

  /** 声明匹配：category 一致且服务该 key 的行；无具名命中 → 该 category 的兜底行。
   *
   *  判定本身住在 `ProviderDirectory`（唯一入口，parked 过滤也在那儿）；这里只把 `ProviderMatch`
   *  摊回行数组，好让既有调用方（bootstrap 的 providerRows、`/api/providers` 预览）签名不变。
   *  要知道「这次是不是靠兜底命中的」就直接问 directory，别从这个返回值里推。 */
  match(category: ProviderCategory, key: string): ProviderRecord[] {
    return this.deps.directory.match(category, key, { fallback: true }).map((m) => m.row)
  }

  /** 按 id 或 (category, key) 执行一次 Provider。未知 id / 无匹配 → null。
   *  opts.overrides：按 key 覆盖成员填洞后的参数（如播放传 {level:'exhigh'} 盖掉行默认 lossless）。
   *  opts.accept：按次覆盖行合同名（如下载传 'lossless' 跳过降级成员）。 */
  async invoke(
    ref: string | { category?: ProviderCategory; variant?: ProviderCategory; key: string },
    input: unknown,
    opts?: { overrides?: Record<string, unknown>; accept?: string; excludeMembers?: string[] },
  ): Promise<InvokeResult | null> {
    return this.invokeWithPath(ref, input, opts, [])
  }

  /** invoke() 的内部实现，携带组合访问路径：`{provider}` 成员递归解析时把 [...path, 当前行 id]
   *  传给子行,供环/自引用/超深防护(Task 3)。顶层 invoke 传空路径。 */
  private async invokeWithPath(
    ref: string | { category?: ProviderCategory; variant?: ProviderCategory; key: string },
    input: unknown,
    opts: { overrides?: Record<string, unknown>; accept?: string; excludeMembers?: string[] } | undefined,
    path: string[],
  ): Promise<InvokeResult | null> {
    const picked = this.pick(ref)
    if (!picked) return null
    const { record, viaFallback } = picked
    if (isParked(record)) return null // parked 行惰性：直调/组合子引用都不跑
    const mark = <T extends InvokeResult>(r: T): T => (viaFallback ? { ...r, viaFallback: true as const } : r)
    const strategy = this.strategies.get(record.strategy)
    if (!strategy) throw new Error(`[provider] unknown strategy "${record.strategy}" (row ${record.id})`)
    // expand 的两个成员不走标准展开（B 的 params 是从 A-item 算出来的，不在声明里）——策略自己
    // 从 record.members 读 A/B 并用 ctx.run 的 source 描述驱动。
    const members = record.strategy === 'expand' ? [] : this.expandMembers(record, opts?.overrides, path, opts?.excludeMembers)
    const accept = this.acceptOf(record, opts?.accept)
    return mark(await strategy.invoke(this.strategyContext(record, members, input, accept)))
  }

  /** 选行：按 id 直调 → 该行（没有兜底概念）；按 (category,key) → directory 判定，兜底与否带出来。
   *  两条路都可能返回 parked 行，parked 惰性由调用处统一判（与 `directory.get` 的语义一致）。 */
  private pick(
    ref: string | { category?: ProviderCategory; variant?: ProviderCategory; key: string },
  ): { record: ProviderRecord; viaFallback: boolean } | null {
    if (typeof ref === 'string') {
      const record = this.deps.directory.get(ref)
      return record ? { record, viaFallback: false } : null
    }
    const match = this.deps.directory.match(ref.category ?? ref.variant!, ref.key, { fallback: true })[0]
    return match ? { record: match.row, viaFallback: match.viaFallback } : null
  }

  /** Collect every acceptable member result for an aggregation Provider. Provider
   *  member declaration remains the merge priority even when strategy is concurrent. */
  async collect(
    ref: string | { category?: ProviderCategory; variant?: ProviderCategory; key: string },
    input: unknown,
    opts?: { overrides?: Record<string, unknown>; accept?: string; excludeMembers?: string[] },
  ): Promise<CollectResult | null> {
    const picked = this.pick(ref)
    if (!picked) return null
    const { record, viaFallback } = picked
    if (isParked(record)) return null // parked 行惰性
    const strategy = this.strategies.get(record.strategy)
    if (!strategy) throw new Error(`[provider] unknown strategy "${record.strategy}" (row ${record.id})`)
    // expand 没有 collect：它的产物是"A 条目挂着 links"的两跳结果，没有逐成员成对这种形状。
    // 说清楚，别留 `collect!` 让它炸成一个不知所云的 TypeError。
    if (!strategy.collect) throw new Error(`[provider] strategy "${record.strategy}" does not support collect (row ${record.id})`)
    const members = this.expandMembers(record, opts?.overrides, [], opts?.excludeMembers)
    const accept = this.acceptOf(record, opts?.accept)
    // collect 路径的记账与超时不是策略自己实现的——每个成员的执行都过 this.runMember，
    // 与 invoke 路径共用同一份打点/超时/健康账逻辑（横切住在 member-pipeline，不住在策略里）。
    const res = await strategy.collect(this.strategyContext(record, members, input, accept))
    return viaFallback ? { ...res, viaFallback: true } : res
  }

  /** 视图用 + resolve 路径用：展开后的现役成员（auto 段展开、去重、exclude 应用后），
   *  带成员参数（$input 未填）。name = 寻址键（实例名或源 id），sourceId = 真源 id
   *  ——视图/梯子层按 sourceId 查 manifest 与 health，按 name 寻址。 */
  resolvedMembers(record: ProviderRecord): Array<{ name: string; sourceId: string; params?: Record<string, unknown>; kind: 'source' | 'provider' }> {
    return this.expandMembers(record).map((m) => ({ name: m.name, sourceId: m.sourceId, params: m.params, kind: m.kind }))
  }

  /** 按行 id 取这一行此刻的现役成员（同 `resolvedMembers`）；行不存在 → null。给「只调其中一个
   *  成员」的调用点用：先确认那个成员还在行里（不在就是包被关了 / 卸了，调用方要响亮报错），再把
   *  其余成员名交给 `excludeMembers`。 */
  resolvedMembersOf(ref: string): Array<{ name: string; sourceId: string; params?: Record<string, unknown>; kind: 'source' | 'provider' }> | null {
    const picked = this.pick(ref)
    return picked ? this.resolvedMembers(picked.record) : null
  }

  /** auto 段展开：provides → registry.providersOf（failover 序）；matches → registry.matching
   *  （radar 匹配，段的 params 骑到每个展开成员上）；category → registry.inCategory（`categories`
   *  含该标签**且**声明了 `key_param` 的源，订阅键灌进各自的 `key_param`）。exclude 按成员名过滤。
   *  全展开按**寻址键**去重——先到者赢（前置显式 pin 压制后续 auto 段的同 id）。寻址键默认是
   *  source id；显式 `{source, name}` 成员用实例名当键，于是同一个源可以带不同 params 多次进梯子
   *  （auto 段展开出来的成员没有实例名，键仍是 source id，去重语义不变）。 */
  private expandMembers(record: ProviderRecord, overrides?: Record<string, unknown>, path: string[] = [], extraExclude?: string[]): ConcreteMember[] {
    const exclude = new Set([
      ...(Array.isArray(record.options?.exclude) ? (record.options.exclude as string[]) : []),
      ...(extraExclude ?? []),
    ])
    const out: ConcreteMember[] = []
    const seen = new Set<string>()
    const push = (sourceId: string, params?: Record<string, unknown>, name?: string) => {
      const key = name ?? sourceId
      if (exclude.has(key) || seen.has(key)) return
      seen.add(key)
      out.push(this.sourceMember(key, sourceId, params, overrides))
    }
    // Composition: a {provider} member is resolved by recursively invoking the child Provider (black
    // box — the child's own strategy/gate/dedup stay internal). The child's items-type result is
    // merged into the parent as this member's contribution; an empty result is a decline. The child
    // runs under [...path, this row's id] so Task 3 can reject self-reference / cycles / over-depth.
    const pushProvider = (providerId: string, params?: Record<string, unknown>) => {
      if (exclude.has(providerId) || seen.has(providerId)) return
      seen.add(providerId)
      out.push({
        name: providerId,
        sourceId: providerId, // 组合成员不带实例名：寻址键 = 子行 id
        params,
        kind: 'provider',
        attempt: async (input) => {
          const child = await this.invokeWithPath(providerId, fillHoles(params, input) ?? input, {}, [...path, record.id])
          if (!child) return null
          const items = providerItems(child)
          return items.length ? items : null // 空 = decline，语义对齐 items 型成员
        },
      })
    }
    for (const ref of record.members) {
      if ('source' in ref) {
        push(ref.source, ref.params, ref.name)
      } else if ('matches' in ref) {
        for (const m of this.deps.registry.matching(ref.matches)) push(m.id, ref.params)
      } else if ('category' in ref) {
        for (const m of this.deps.registry.inCategory(ref.category)) push(m.id, { [m.key_param!]: '$input', ...(ref.params ?? {}) })
      } else if ('provider' in ref) {
        // 同步防护(在进入 Promise.all 前):超深 / 自引用 / 环。抛出的错误由 run* 的 catch 重新抛
        // (isCompositionError),一路冒泡到顶层 invoke,不被吞成 miss。
        if (path.length + 1 > MAX_COMPOSITION_DEPTH) throw new ProviderDepthError(`composition depth > ${MAX_COMPOSITION_DEPTH} (at ${record.id} → ${ref.provider})`)
        const visited = new Set([...path, record.id]) // 当前行也算已访问 → 抓自引用;path=祖先链 → 抓环
        if (visited.has(ref.provider)) throw new ProviderCycleError(`provider composition cycle at ${ref.provider}`)
        pushProvider(ref.provider, ref.params)
      } else {
        for (const m of this.deps.registry.providersOf(ref.provides)) push(m.id, ref.params)
        // 申报了同一标签的 Provider 行（站的包出的组合体）当组合成员收进来。拿**原始输入**：
        // 段参数是给源成员的（`{keyword:'$input'}`），行自己的成员各自决定怎么填 `$input`。
        // 本行与祖先链上的行跳过——那不是配置错误（一条行既申报标签又聚合这个标签很正常），
        // 抛环错误会把整个聚合打掉。
        const ancestry = new Set([...path, record.id])
        for (const row of this.deps.directory.providing(ref.provides)) {
          if (!ancestry.has(row.id)) pushProvider(row.id)
        }
      }
    }
    return out
  }

  /** name = 寻址键（实例名或源 id），sourceId = 真源 id：attempt 一律用后者 fetch。 */
  private sourceMember(name: string, sourceId: string, params?: Record<string, unknown>, overrides?: Record<string, unknown>): ConcreteMember {
    return {
      name,
      sourceId,
      params,
      kind: 'source',
      attempt: async (input) => {
        // 洞填充后叠加调用方 overrides（按 key 覆盖，如 {level:'exhigh'}）；无 overrides 时与原路径一致
        const base = fillHoles(params, input)
        const merged = overrides ? { ...(base ?? {}), ...overrides } : base
        const r = await this.deps.fetchSource(sourceId, input, merged)
        if (r == null) return null
        if (Array.isArray(r)) return r.length ? r : null // items 型：空批 = decline，语义对齐 ResolveEngine
        return r // object 型：判决本身
      },
    }
  }

  private acceptOf(record: ProviderRecord, override?: string): (r: unknown) => boolean {
    const name = override ?? (record.contract && typeof record.contract.accept === 'string' ? record.contract.accept : null)
    return (name && CONTRACTS[name]) || (() => true)
  }

}
