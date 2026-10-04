import type { Feature, StateDef, StateId } from './state-graph.ts'

/**
 * 一次识别的结果。
 *
 * **`ambiguous` 是独立的一档，不许从多个命中里挑一个返回。** 挑一个意味着引擎带着一个错误的
 * 信念继续走，而它**不会崩溃**——它会把后面每一步都做在错的前提上，一路做到有副作用的那一格。
 * 这一档直接进 AI 介入闸（问「拿什么区分这几个」），也正是区分度闸在运行时的对应物。
 */
export type IdentifyResult =
  | { states: StateId[]; matched: Feature[] }
  | { states: null; reason: 'no-match'; candidates: [] }
  | { states: null; reason: 'ambiguous'; candidates: StateId[] }

export interface Perception {
  identify(known: StateDef[]): Promise<IdentifyResult>
}

/**
 * 单条特征此刻成不成立。
 *
 * **不认识的 kind 必须抛错，不许返回 false**：桌面图里混进一条 `dom` 特征是作者的错，
 * 而静默当成"不匹配"会让它表现成"这个状态就是没认出来"，排查的人回不到现场。
 */
export type FeatureTest = (f: Feature) => Promise<boolean>

/**
 * 两个路线共用的判定：逐个状态 AND 所有特征。
 *
 * **多命中不等于歧义。** 状态是**部分描述**不是快照——它只声明自己在意的那几条，别的东西
 * 怎么变都不影响它。所以一个屏上同时成立好几个状态是正常的（活体实测：QQ 上「中间列开着
 * 搜索面板」和「右侧是和某人的对话」同时为真，两条都对）。
 *
 * 真正的歧义只发生在**同一组之内**——`group` 就是人写的那句「这几个不可能同时为真」。
 * 同组撞车才回 `ambiguous`，而且**绝不从里面挑一个返回**：挑一个意味着引擎带着错误的信念
 * 继续走，而它不会崩溃，会一路把每一步都做在错的前提上。
 */
export async function identifyWith(known: StateDef[], test: FeatureTest): Promise<IdentifyResult> {
  const hits: StateDef[] = []
  for (const s of known) {
    let all = true
    for (const f of s.features) {
      if (!(await test(f))) {
        all = false
        break // 一条为假就短路——后面的问了也不改变结论，而每一问都可能是一次真实开销
      }
    }
    if (all) hits.push(s)
  }
  if (hits.length === 0) return { states: null, reason: 'no-match', candidates: [] }
  const byGroup = new Map<string, StateId[]>()
  for (const s of hits) {
    const g = s.group ?? ''
    const list = byGroup.get(g)
    if (list) list.push(s.id)
    else byGroup.set(g, [s.id])
  }
  const clash = [...byGroup.values()].find((ids) => ids.length > 1)
  if (clash) return { states: null, reason: 'ambiguous', candidates: clash }
  return { states: hits.map((s) => s.id), matched: hits.flatMap((s) => s.features) }
}
