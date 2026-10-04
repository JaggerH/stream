import type { RuntimeConfigSpec } from '../manifest/types.ts'

/** Provider 成员的 key 存在哪一个逻辑名下（= TokenProvider.layer 的取值键）。
 *
 *  普通源：整个源共享一份 key，键就是 manifest 的 `runtime_config.ref`。
 *
 *  `perInstance` 源（一个源带不同 params 多次进梯子，每个实例各自一份 key）：key **不在** `ref`
 *  那一层，而在成员自己的 `params.tokenName`——写入 key 的那一侧（迁移 `migrateLlmConnectionsToMembers`
 *  与 Sheet 的实例写入）落的就是 tokenName，它本身已经是完整 ref（`llm:<实例名>`）。
 *  **别再用 `<ref>:<实例名>` 拼一个出来**：拼出来的键和写进去的键不是同一个，读到的永远是 missing
 *  （活体确认过的假读数——`llm-openai` 的 keyState 对每个实例恒 missing 就是这么来的）。
 *  tokenName 缺失 → null：这个成员根本没有可取的层。 */
export function keyRefOf(rc: RuntimeConfigSpec, memberParams: Record<string, unknown> | undefined): string | null {
  if (!rc.perInstance) return rc.ref
  const tokenName = memberParams?.tokenName
  return typeof tokenName === 'string' && tokenName ? tokenName : null
}

/** 成员 key 的配置状态：只报层（stored/env/missing），永不报值。
 *  null = 这个源的 manifest 根本没声明 secret 字段（视图里不该带 keyState 字段），**或者**
 *  perInstance 源的成员没有 `tokenName`——那是 legacy/占位形状，key 压根不归 TokenProvider 管
 *  （种子占位成员、手改库的旧 connectionId 成员都长这样），不该被判「缺 key」。
 *  一旦有 ref（不论普通源的 manifest ref，还是 perInstance 成员自己的 tokenName）却取不到层，
 *  才是真的 'missing'——这是徽章的本职，不能一起弄哑。 */
export function keyStateOf(
  rc: RuntimeConfigSpec | undefined,
  memberParams: Record<string, unknown> | undefined,
  layer: (ref: string) => 'stored' | 'env' | null,
): 'stored' | 'env' | 'missing' | null {
  if (!rc?.fields || !Object.values(rc.fields).some((f) => f.type === 'secret')) return null
  const ref = keyRefOf(rc, memberParams)
  if (!ref) return null
  return layer(ref) ?? 'missing'
}
