import type { BlockedReason } from '../blocked.ts'

export interface InvokeMiss {
  member: string
  /** core one-line message (shown to the user) */
  reason: string
  /** full error stack, for the copy-to-clipboard diagnostic (undefined for non-error misses) */
  stack?: string
  /** 这个成员的失败是**暂时性**的(抛出的错自述 retryable,如 standby 容器还在装权重的唤醒超时),
   *  重排整条阶梯届时可能成功。由 catch 处一次性经 isRetryable 判定并结构化带出——下游据此决定
   *  重排而非判死,**不做字符串匹配**。非错误 miss / 不可重试的错误恒 undefined。 */
  retryable?: boolean
  /** 这个成员不是"坏了",是**前置条件没满足**——facility 掉了登录态、扩展没连。缺什么、能怎么补,
   *  结构化带出(同 `retryable` 的做法,由 catch 处一次性经 `blockedOf` 判定,**不做字符串匹配**)。
   *  前端据此渲染成可点的按钮而不是一行红字:一条讲登录的普通报错若被误判,给出的按钮按下去后面
   *  根本没有可跑的流程。普通失败恒 undefined。 */
  blocked?: BlockedReason
  /** 这个成员要的**内容本身没有**——站方明确答"已删除 / 无权限 / 不存在"，不是解析器坏了。
   *  由 catch 处一次性经 `isUnavailable`（`./unavailable.ts`）判定并结构化带出，**不做字符串匹配**。
   *  调用点据此回 404 + 站方原话而不是 502；健康账不记。普通失败恒 undefined（缺席 = 不适用）。 */
  unavailable?: true
}

/** Per-member wall-clock of one attempt — the ladder trace: which rung ran, how long, outcome.
 *  Emitted for every attempted member (win + misses), so the resolve-diagnostics box can show
 *  where the time actually went. member name is unique (expandMembers dedupes by addressing key —
 *  the member's instance name, or its source id when it has none). */
export interface InvokeTiming {
  member: string
  /** 真源 id。**寻址键单独不够用**：带实例名的成员，键是用户自己起的名字（`zhipu`），
   *  光看它答不出"到底是哪个 source 干的"——同一个源的两个实例键完全不同，不同源的实例名
   *  又可能撞脸。要回答"谁处理了这次"就得两个都有。 */
  source: string
  ms: number
  outcome: 'win' | 'miss' | 'error'
}

/** 这次执行选中的行是**兜底行**（没有任何行具名声明这个键）。缺席 = 不适用：按 id 直调根本
 *  没有兜底这个概念，(category,key) 具名命中也不置位。
 *
 *  为什么在信封上而不是 `InvokeMiss` 里：miss 是 per-member 账本，「落到了兜底行」是**选行**
 *  层级的事件——它讲的是这一整次调用被路由去了哪儿，不是某个成员怎么了。 */
export interface FallbackMark {
  viaFallback?: true
}

export type InvokeResult =
  | ({ strategy: 'sequential'; provider: string; value: unknown; via: string; misses: InvokeMiss[]; timings: InvokeTiming[] } & FallbackMark)
  | ({ strategy: 'sequential'; provider: string; value: null; via: null; misses: InvokeMiss[]; timings: InvokeTiming[] } & FallbackMark)
  | ({ strategy: 'concurrent'; provider: string; items: unknown[]; sources: string[]; misses: InvokeMiss[]; timings: InvokeTiming[] } & FallbackMark)
  | ({ strategy: 'expand'; provider: string; items: unknown[]; sources: string[]; misses: InvokeMiss[]; timings: InvokeTiming[] } & FallbackMark)

/** All acceptable Source outputs from a Provider, in declared member order.
 *
 *  collect 不是第二种执行语义，是**全收（并发）语义下的另一种结果形状**：invoke 把合格结果
 *  合并成一个 items 数组，collect 保留「哪个成员给的哪份」的成对结构，供按来源合并字段的
 *  调用点用。因此只有并发行有 collect——首胜即停的顺次行调它是自相矛盾，执行器响亮拒绝。 */
export interface CollectResult extends FallbackMark {
  strategy: 'concurrent'
  provider: string
  results: Array<{ member: string; value: unknown }>
  misses: InvokeMiss[]
  timings: InvokeTiming[]
}

/** 成员结果两型（capability-normalization spec §3.2）：items 型 = 数组（[] = decline，
 *  今天的全部成员）；object 型 = 一个判决对象（null = decline，探针/解析器）——判决不再
 *  穿 item 的衣服。形状由 Source 的 manifest.output 声明，bootstrap 在缝上解包。 */
export type MemberResult = unknown[] | Record<string, unknown> | null

/** 并发合并结果的 per-item 溯源：把产出该 item 的源 id 挂成**不可枚举**字段——JSON 序列化、
 *  对象展开、结构相等（vitest toEqual）、以及只读特定字段的消费者（rsshubItemsToTracks）都看不见。
 *  调用点用 `sourceOf()` 取回，决定每条 item 的 per-scope 处理（content→按源 normalize，music→留给
 *  rsshubItemsToTracks）。只作用于对象（原始 adapter 条目均为对象；基元原样返回）。 */
export const PROVENANCE_KEY = '__providerSource'
export function sourceOf(item: unknown): string | undefined {
  return item && typeof item === 'object' ? ((item as Record<string, unknown>)[PROVENANCE_KEY] as string | undefined) : undefined
}
export function tagSource<T>(item: T, sourceId: string): T {
  if (item && typeof item === 'object') {
    Object.defineProperty(item, PROVENANCE_KEY, { value: sourceId, enumerable: false, configurable: true, writable: true })
  }
  return item
}

/** 组合归一：把子 Provider 的 InvokeResult 摊成 items 数组，供父行当一个成员结果并入。
 *  sequential 的单值(或数组)/null 归一为数组;concurrent/expand 直接取 items。 */
export function providerItems(r: InvokeResult): unknown[] {
  if (r.strategy === 'sequential') return r.value == null ? [] : (Array.isArray(r.value) ? r.value : [r.value])
  return r.items
}

/**
 * 非 builtin 成员（包 adapter / 目录路由）的调用形状：它们经 `ResolveEngine.fetchSource(id, key, extra)`，
 * `key` 是**一个字符串**。调用点给的输入却有两种形——搜索是一串关键词，播放解析是
 * `{ vid, format }`、贴链接抓媒体是 `{ url }` 这类**对象**。对象照 `String(input)` 传过去就是
 * `"[object Object]"`：adapter 拿到的 `params.vid` 是 undefined、返回 `[]`、梯子记一次 decline，
 * 而每一处都"正常"。所以对象输入**按字段进 params**，键留空串；成员自己行上绑的参数仍然覆盖
 * 输入字段（那是用户给这条行的显式配置，和 `$input` 洞填完之后叠 overrides 的次序一致）。
 * builtin 成员不经这里——它们的实现函数直接拿整个输入对象。
 */
export function memberCallArgs(
  input: unknown, params?: Record<string, unknown>,
): { key: string; params: Record<string, unknown> | undefined } {
  const isObject = typeof input === 'object' && input !== null && !Array.isArray(input)
  if (!isObject) return { key: String(input), params }
  return { key: '', params: { ...(input as Record<string, unknown>), ...(params ?? {}) } }
}

/** 参数洞填充：值为 '$input' 的键在调用时换成输入值（绑定在行定义里，输入在调用点给）。 */
export function fillHoles(params: Record<string, unknown> | undefined, input: unknown): Record<string, unknown> | undefined {
  if (!params) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) out[k] = v === '$input' ? input : v
  return out
}
