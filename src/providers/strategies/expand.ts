import type { ExecutionStrategy } from './types.ts'
import type { ExpandSpec, ProviderMemberRef } from '../../store/types.ts'
import type { SourceType } from '../../video/types.ts'
import { classifyLink } from '../../video/parse.ts'
import { missOf, timingOf } from '../member-pipeline.ts'
import { tagSource, fillHoles } from '../invoke-types.ts'
import type { InvokeMiss, InvokeTiming } from '../invoke-types.ts'

/** expand 组合子默认值 + 单钻超时 + 总时长预算。单钻超时(10s)与总预算(20s)一起把整个 expand 的
 *  最坏墙钟从源头 bound 住——批量路(videoSearch 的 concurrent invoke)没有 per-member 超时,靠这个
 *  预算防止一个慢站把整个 video_search 拖住;流式路另有 VIDEO_SOURCE_TIMEOUT_MS 外层兜底。 */
export const EXPAND_DRILL_TIMEOUT_MS = 10000
export const EXPAND_TOTAL_BUDGET_MS = 20000
const DEFAULT_HANDLE_CAP = 20
const DEFAULT_EXPAND_CONCURRENCY = 5

/** expand 组合子:invoke A → 每个 handle 按 $item 字段映射参数化 B → invoke B → 装配进该条 links[]。
 *  有界并发 + handle 封顶 + 单钻失败/超时跳过(记 miss、不拖垮整体);输出保 A 的顺序。
 *
 *  A 与每一钻都经 `ctx.run`(碰成员的唯一口子):打点/超时/健康账全在管道那一处 —— 这也是 expand
 *  第一次记健康账(A 源与 B 源都记),迁移前它自己手工 stats.record、健康账本完全没它的份。
 *
 *  **accept 吃的是数组不是单条**:A 的壳批(一次 fetch 出一整批 handle)与每一钻的 B 批都原样整批
 *  交给 `ctx.run` 的 accept 判据(`executor.ts` 的 `contractUnit` 只看数组第一个元素),不是逐条过。
 *  给 expand 行配 `contract.accept`前要想清楚这一点——它验的是"这一批的头一条合不合格",不是每条。
 *
 *  **无 collect**:expand 的产物是"A 条目挂着 links"的两跳结果,没有"逐成员成对"这种形状可给。
 *  调用方对 expand 行调 collect 会在执行器分发处拿到显式报错,而不是一个 undefined 崩。 */
export const expandStrategy: ExecutionStrategy = {
  name: 'expand',

  async invoke(ctx) {
    const record = ctx.record
    const spec = record.expand
    if (!spec) throw new Error(`[provider] expand strategy row "${record.id}" missing expand spec`)
    const [aRaw, bRaw] = record.members
    // 写入面（app.ts）已经拦过这个形状；这里再守一道是防直接改库/内存造出一条不合形状的行——
    // 口径对齐执行器"unknown strategy"那一处的响亮报错，不留一个 `!` 断言让它炸成不知所云的 TypeError。
    if (!isSourceMember(aRaw) || !isSourceMember(bRaw)) {
      throw new Error(`[provider] expand strategy row "${record.id}" requires exactly two { source } members [A, B]`)
    }
    const aRef = aRaw
    const bRef = bRaw
    // 账本/miss/timing 一律按寻址键（实例名优先），fetch 一律按真源 id——与 expandMembers 同一条规矩。
    const aKey = aRef.name ?? aRef.source
    const bKey = bRef.name ?? bRef.source
    const misses: InvokeMiss[] = []
    const timings: InvokeTiming[] = []

    // A 的壳搜索：params 在成员声明里（$input 填洞），但 expand 的 members 恒空（不走标准展开），
    // 所以递一份 source 描述给管道，而不是自己取数。
    const aView = { name: aKey, sourceId: aRef.source, kind: 'source' as const }
    const aOut = await ctx.run(aView, { source: { params: fillHoles(aRef.params, ctx.input), empty: 'decline' } })
    timings.push(timingOf(aOut))
    if (aOut.kind !== 'win') misses.push(missOf(aOut))
    // A 壳搜索必须回 items 型（数组）。回 object 型判决（单条裁决）时管道照样记 win，若只按
    // `Array.isArray` 取空数组，结果就是"空 items + 零 miss + 健康账记成功"——一个静默的空答案。
    // 所以在策略侧把它视同 miss：摆出解释再回空信封（与 A miss 那条路同形），别让它悄悄过去。
    if (aOut.kind === 'win' && !Array.isArray(aOut.value)) {
      misses.push({ member: aKey, reason: 'A member returned an object-shaped verdict; expand shell search requires an items-shaped (array) result' })
      return { strategy: 'expand', provider: record.id, items: [], sources: [aKey, bKey], misses, timings }
    }
    const handles = (aOut.kind === 'win' && Array.isArray(aOut.value) ? aOut.value : []).slice(0, spec.handleCap ?? DEFAULT_HANDLE_CAP)

    const drill = async (h: unknown): Promise<Record<string, unknown> | null> => {
      // 钻取 params 是从 A-item 算出来的（不在成员声明里）→ 同样递 source 描述；单钻墙钟由
      // timeoutMs 覆盖交给管道，策略自己不再手搓 race。
      // 已知不对称（不改行为，留证据）：B 用 empty:'ok'（钻空了也回 `[]`），管道因此记 'ok'——
      // 不像上面 A 的 empty:'decline' 把空判成 null 记 miss。B 钻空是"这条 handle 没有链接"的常态，
      // 不是源故障，所以不该占熔断账；代价是空钻永远算健康，与 A 的"空即 miss"读法不一致。
      // 附带效应：这也会把 B 源的 lifetimeItemCount 抬过 0，使它在别处够格吃"连续空 K 次
      // 降级"规则——纯 doctor 观感（该规则读的是计数不是内容），无实际行为影响。
      const bOut = await ctx.run({ name: bKey, sourceId: bRef.source, kind: 'source' }, {
        timeoutMs: EXPAND_DRILL_TIMEOUT_MS,
        source: { params: applyItemMap(spec.map, h), empty: 'ok' },
      })
      timings.push(timingOf(bOut))
      if (bOut.kind !== 'win') { misses.push(missOf(bOut)); return null }
      const links = (bOut.value as unknown[]).map((bi) => assembleLink(spec.assemble, bi))
      return { ...(h as Record<string, unknown>), links }
    }

    // 有界并发池,结果按 handle 下标回填以保 A 的顺序。
    const results: Array<Record<string, unknown> | null> = new Array(handles.length).fill(null)
    let next = 0
    const deadline = performance.now() + EXPAND_TOTAL_BUDGET_MS
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++
        if (i >= handles.length) return
        // 总预算到点后不再发起新钻(在飞的 ≤lanes 个各自受 per-drill 超时约束)——bound 最坏墙钟。
        if (performance.now() > deadline) {
          misses.push({ member: bKey, reason: 'expand total budget exceeded; remaining handles skipped' })
          return
        }
        results[i] = await drill(handles[i])
      }
    }
    const lanes = Math.min(Math.max(1, spec.concurrency ?? DEFAULT_EXPAND_CONCURRENCY), handles.length)
    await Promise.all(Array.from({ length: lanes }, () => worker()))
    const out = results.filter((r): r is Record<string, unknown> => r !== null)
    return { strategy: 'expand', provider: record.id, items: out.map((it) => tagSource(it, record.id)), sources: [aKey, bKey], misses, timings }
  },
}

/** {source} 成员的运行时判据（写入面已拦，这里只防直接改库/内存造出的畸形行）。 */
function isSourceMember(m: ProviderMemberRef): m is { source: string; name?: string; params?: Record<string, unknown> } {
  return 'source' in m && typeof m.source === 'string'
}

/** expand 映射取值:只支持 `$item.<field>` 字段抽取——纯数据、无任意求值(守红线:数据拿不到 ambient capability)。 */
function pickField(expr: string, item: unknown): unknown {
  if (typeof expr !== 'string' || !expr.startsWith('$item.')) return undefined
  const key = expr.slice('$item.'.length)
  return item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined
}
/** A-item → B 的 params:每个键从 A-item 的声明字段取值。 */
function applyItemMap(map: Record<string, string>, item: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, expr] of Object.entries(map)) out[k] = pickField(expr, item)
  return out
}
const VALID_SOURCE_TYPES = new Set<SourceType>(['magnet', 'ed2k', 'quark', 'baidu', 'aliyun', 'unknown'])
/** B-item → 一条 link。type=`pathClassify` 时按链接路径判(magnet/quark/…),否则从 $item 字段取值并
 *  校验落在 SourceType 联合内(越界 → 'unknown',不放行任意字符串当类型)。 */
function assembleLink(a: ExpandSpec['assemble'], bItem: unknown): { url: string; type: SourceType; desc: string } {
  const url = String(pickField(a.url, bItem) ?? '')
  let type: SourceType
  if (a.type === 'pathClassify') type = classifyLink(url)
  else { const t = String(pickField(a.type, bItem) ?? ''); type = VALID_SOURCE_TYPES.has(t as SourceType) ? (t as SourceType) : 'unknown' }
  return { url, type, desc: String(pickField(a.desc, bItem) ?? '') }
}
