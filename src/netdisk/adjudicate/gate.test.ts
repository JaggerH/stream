import { describe, it, expect } from 'vitest'
import { admitDecision } from './gate.ts'
import type { Card } from './cards.ts'
import type { Decision } from './prompt.ts'

const baseCard = (): Card => ({
  id: '1',
  kind: 'duration-collision',
  file: { path: '/src/S01/第2期.mkv', name: '第2期.mkv', durationS: 3700 },
  candidates: [{ leftKey: 'L1', title: '第2期', authorityDurationS: 3700, season: 1 }],
  reason: '时长撞上',
  dirSeason: 1,
})

const isEpisode = (over: Partial<Decision> = {}): Decision =>
  ({ id: '1', verdict: 'is-episode', leftKey: 'L1', confidence: 'high', reason: 'r', ...over })

describe('admitDecision — is-episode 五条闸（spec §5）', () => {
  it('五条全过 → 放行', () => {
    expect(admitDecision(baseCard(), isEpisode())).toEqual({ ok: true })
  })

  it('条1：confidence 不是 high → 拒收', () => {
    const r = admitDecision(baseCard(), isEpisode({ confidence: 'low' }))
    expect(r.ok).toBe(false)
  })

  it('unsure 一律不收（不管 confidence 是什么）', () => {
    const r = admitDecision(baseCard(), isEpisode({ verdict: 'unsure', confidence: 'high' }))
    expect(r.ok).toBe(false)
  })

  it('条2：leftKey 不在 candidates 里 → 拒收', () => {
    const r = admitDecision(baseCard(), isEpisode({ leftKey: '不在卡上的集' }))
    expect(r.ok).toBe(false)
  })

  it('条2：没给 leftKey → 拒收', () => {
    const r = admitDecision(baseCard(), isEpisode({ leftKey: undefined }))
    expect(r.ok).toBe(false)
  })

  it('条3：期号闸——文件名第2期、候选写第3期 → 拒收', () => {
    const card = baseCard()
    card.candidates[0]!.title = '第3期'
    const r = admitDecision(card, isEpisode())
    expect(r.ok).toBe(false)
  })

  it('条4：季不一致——目录是 S1、候选是 S2 → 拒收', () => {
    const card = baseCard()
    card.candidates[0]!.season = 2
    const r = admitDecision(card, isEpisode())
    expect(r.ok).toBe(false)
  })

  it('条4：两侧任一没有季概念（播客）→ 视为通过', () => {
    const card = baseCard()
    card.dirSeason = undefined
    card.candidates[0]!.season = undefined
    expect(admitDecision(card, isEpisode())).toEqual({ ok: true })
  })

  it('条5：反向——文件时长与节目单差 20 分钟，模型说 is-episode 也被拒收（spec §9 验收）', () => {
    const card = baseCard()
    card.file.durationS = 3700 + 20 * 60 // 差 1200 秒，远超 1 秒容差
    const r = admitDecision(card, isEpisode())
    expect(r.ok).toBe(false)
  })

  it('条5：时长在容差内（差 1 秒）→ 放行', () => {
    const card = baseCard()
    card.file.durationS = 3701
    expect(admitDecision(card, isEpisode())).toEqual({ ok: true })
  })

  it('条5：与货架上已有那份（existing）时长差太多 → 拒收，即便与节目单没冲突', () => {
    const card = baseCard()
    card.candidates[0]!.authorityDurationS = undefined // 节目单没给时长，只剩 existing 可比
    card.candidates[0]!.existing = { path: '/lib/x.mkv', durationS: 1000 }
    const r = admitDecision(card, isEpisode())
    expect(r.ok).toBe(false)
  })

  it('条5：离谱时长（>12h）视为缺席，不参与比较，不因此拒收', () => {
    const card = baseCard()
    card.file.durationS = 13 * 3600 // 探测失败留下的离谱值
    expect(admitDecision(card, isEpisode())).toEqual({ ok: true })
  })

  it('时长两侧都缺席（candidate 没时长、文件也没时长）→ 无从比较，不拒收', () => {
    const card = baseCard()
    card.candidates[0]!.authorityDurationS = undefined
    card.file.durationS = undefined
    expect(admitDecision(card, isEpisode())).toEqual({ ok: true })
  })
})

describe('admitDecision — not-episode 只过前两条（spec §5）', () => {
  const notEpisode = (over: Partial<Decision> = {}): Decision =>
    ({ id: '1', verdict: 'not-episode', leftKey: 'L1', confidence: 'high', reason: 'r', ...over })

  it('confidence high + leftKey 在场 → 放行，即便期号/季/时长全对不上', () => {
    const card = baseCard()
    card.file.durationS = 100 // 时长离谱地不对
    card.candidates[0]!.season = 99 // 季也不对
    expect(admitDecision(card, notEpisode())).toEqual({ ok: true })
  })

  it('confidence 不是 high → 拒收', () => {
    expect(admitDecision(baseCard(), notEpisode({ confidence: 'low' })).ok).toBe(false)
  })

  it('leftKey 不在 candidates → 拒收', () => {
    expect(admitDecision(baseCard(), notEpisode({ leftKey: '不在卡上' })).ok).toBe(false)
  })

  it('不带 leftKey = 「都不是」→ 放行（卡上有候选）；卡上没候选 → 拒收', () => {
    expect(admitDecision(baseCard(), notEpisode({ leftKey: undefined }))).toEqual({ ok: true })
    const empty = baseCard()
    empty.candidates = []
    expect(admitDecision(empty, notEpisode({ leftKey: undefined })).ok).toBe(false)
  })
})
