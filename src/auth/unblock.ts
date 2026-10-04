import type { SourceManifest } from '../manifest/types.ts'
import type { LadderTrace } from '../providers/ladder-trace.ts'
import { selfProvisionRecipesFor, type SelfProvisionOption } from './self-provision.ts'

export interface UnblockOption extends SelfProvisionOption {
  /** 是哪个梯子成员因为缺它而弃权的 */
  member: string
}

/**
 * 一次没成的梯子 → 「用户可以自己补上哪几件东西」。
 *
 * **只看 `outcome:'miss'`。** `miss`（没配，去配置）和 `error`（试了但失败，去查故障）
 * 方向相反——这个区分是 `ResolveRung` 自己写在注释里的。把 error 也当成缺配置，会让
 * agent 在上游挂掉的时候去劝用户重新申请一把 key，那是比"没有建议"更坏的建议。
 * `rejected`（答过但被 validate 否决）同理不算：那说明这个成员其实是配好了的。
 *
 * **有人赢了就什么都不提。** 梯子的意义就是有人弃权也照样出结果；这时候提"你还缺 groq key"
 * 是噪音——用户什么都没损失。
 */
export function unblockOptionsFor(
  trace: LadderTrace,
  manifests: readonly SourceManifest[],
): UnblockOption[] {
  if (trace.via) return []
  const byId = new Map(manifests.map((m) => [m.id, m]))
  const out: UnblockOption[] = []
  const seen = new Set<string>()
  for (const rung of trace.rungs) {
    if (rung.outcome !== 'miss') continue
    const ref = byId.get(rung.source)?.runtime_config?.ref
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    for (const opt of selfProvisionRecipesFor(manifests, ref)) {
      // 产出 key 的那条 recipe 自己也会带 runtime_config.ref，别把它算成"缺它的人"——
      // "跑它自己去补它自己"是一句废话。
      if (opt.sourceId === rung.source) continue
      out.push({ ...opt, member: rung.member })
    }
  }
  return out
}
