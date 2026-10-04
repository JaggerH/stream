import { describe, it, expect } from 'vitest'
import { NON_LIVE_VETO_TO_ASK, isNonLiveVeto, asksDespiteNoSupply } from './live-candidate.ts'
import type { AskReason, VetoReason } from './types.ts'

/**
 * **闸与删之间那道缝**——两处在回答同一个问题，一旦口径分家，文件会被静默处理掉。
 *
 * · 判定层的闸（`resolve.ts` 的 `note()`）：这一集源站自己放得出（`needsSupply === false`）
 *   → 不发问句。理由是"答案不改变动作"。
 * · 处置层的自动删（`reconcile/plan.ts` 的 `liveCandidateKeys`）：一份没被认领的文件，
 *   其**活候选**全都不需供货 → 直接删，不出卡。
 *
 * 不变量：**被处置层从活候选里剔掉的那些边，判定层就必须照发问句**——那条边走不到自动删，
 * 所以"答案不改变动作"在这一档是假的（是这一集 → 换正主；不是 → 挪去下架）。
 *
 * 活体事故（2026-08-02 怡楽）：`112.河南洛阳案.mp3` / `116.安特卫普金库案.mp3` 名字与节目单
 * 某一集一字不差、时长差 350 余秒，被静默搬去下架货架，一张卡都没有。
 *
 * 那次的修法是在闸上写死一句"`duration-contradiction` 放行"，两侧只靠注释互指。这个文件
 * 把那份对应关系变成**一处定义**，两侧都读它——加一种剔除理由时，改不全就在这里红。
 */

describe('活候选的剔除口径：一处定义，两侧共用', () => {
  it('剔除理由 → 必须照发的问句理由，是一张显式对照表', () => {
    expect(NON_LIVE_VETO_TO_ASK).toEqual({ 'duration-contradict': 'duration-contradiction' })
  })

  it('isNonLiveVeto 只对表里那些为真（处置层据此剔边）', () => {
    expect(isNonLiveVeto('duration-contradict')).toBe(true)
    for (const r of ['name-floor', 'below-threshold', 'no-margin', 'left-claimed', 'zero-competition-loser'] as VetoReason[]) {
      expect(isNonLiveVeto(r)).toBe(false)
    }
    expect(isNonLiveVeto(undefined)).toBe(false)
  })

  it('asksDespiteNoSupply 只对表里那些为真（判定层据此掀闸）', () => {
    expect(asksDespiteNoSupply('duration-contradiction')).toBe(true)
    for (const r of ['name-floor', 'below-threshold', 'no-margin', 'dual-episode-conflict'] as AskReason[]) {
      expect(asksDespiteNoSupply(r)).toBe(false)
    }
  })

  /**
   * 这条才是真正的护栏：**两侧读的是同一张表**。往表里加一行（处置层新剔一种理由），
   * 判定层的放行集自动跟着变，不会再出现"删那边剔了、问那边没跟上"的静默下架。
   */
  it('两侧的口径由同一张表推出，不许各写各的', () => {
    const vetoes = Object.keys(NON_LIVE_VETO_TO_ASK) as VetoReason[]
    const asks = Object.values(NON_LIVE_VETO_TO_ASK) as AskReason[]
    expect(vetoes.every((v) => isNonLiveVeto(v))).toBe(true)
    expect(asks.every((a) => asksDespiteNoSupply(a))).toBe(true)
    // 数量对齐：一个剔除理由对一个问句理由，没有落单的
    expect(new Set(asks).size).toBe(vetoes.length)
  })
})
