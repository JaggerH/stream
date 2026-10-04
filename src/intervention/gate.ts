import { checkDiscriminative, type Feature, type Observation, type StateDef } from '../replay/state-graph.ts'

/**
 * `state` / `discriminator` 两类提议的入库闸（spec §4.2）。两道，顺序固定：
 * 1. **此刻成立**：候选的每条特征在当前现场上都为真。一条此刻都不成立的特征连「描述当前页」
 *    都做不到，拿它去撞历史观测，撞不撞都没有意义——所以先判它。
 * 2. **只匹配当前页**：`checkDiscriminative` 拿**整组**特征撞同组状态的历史观测。
 *
 * 过不了的标 rejection，**仍进 run 记录**（人要看到 AI 答了什么、为什么被拒），不进审核队列。
 *
 * `holdsNow` 由调用方（Broker）提供：这道闸不自己感知现场，因为「此刻成不成立」在浏览器侧
 * 和桌面侧是两套判法，闸只负责顺序与结论。浏览器侧的近似判法（`url` 真判、`dom` 判为
 * 成立但在 gateNote 里记「dom 未现验」）写在 Broker 那侧。
 *
 * 另一处需要 Broker 兜住的缺口：`AskAnswer`（state）不带 `group`，`checkDiscriminative` 拿到的
 * candidate 只能按 `group ?? ''` 去和「无组」的已知状态比。候选该归哪个组，是 Broker（Task 7）
 * 按上下文判出来、填进 `candidate.group` 的——不填的话，这道闸永远比不到有组的状态，会漏掉
 * 与它们的撞车。
 */
export function gateStateLike(
  candidate: StateDef,
  known: StateDef[],
  observations: Observation[],
  holdsNow: (f: Feature) => boolean,
): { ok: true } | { ok: false; rejection: 'not-observed' | 'not-discriminative'; note: string } {
  const failing = candidate.features.filter((f) => !holdsNow(f))
  if (failing.length) {
    return {
      ok: false,
      rejection: 'not-observed',
      note: `这几条特征此刻不成立：${failing.map((f) => JSON.stringify(f)).join('；')}`,
    }
  }
  const d = checkDiscriminative(candidate, known, observations)
  // 点名撞了谁：只说「不够区分」的话，人拿到提议也不知道该改哪一条。
  if (!d.ok) return { ok: false, rejection: 'not-discriminative', note: `和已知状态撞车：${d.collidesWith.join('、')}` }
  return { ok: true }
}
