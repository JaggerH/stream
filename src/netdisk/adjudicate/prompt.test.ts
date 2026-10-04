import { describe, it, expect } from 'vitest'
import { buildMessages, parseDecisions, ADJUDICATE_SYSTEM_PROMPT } from './prompt.ts'
import type { Card } from './cards.ts'

const CARD: Card = {
  id: '1',
  kind: 'duration-collision',
  file: { path: '/src/a.mkv', name: 'a.mkv', sizeBytes: 100, durationS: 3700 },
  candidates: [{ leftKey: 'L1', title: '第2期', authorityDurationS: 3700, season: 1, existing: { path: '/lib/x.mkv' } }],
  reason: '时长撞上',
  dirSeason: 1,
}

describe('buildMessages', () => {
  it('第一条是 system 常量，第二条 user 是卡片 JSON', () => {
    const msgs = buildMessages([CARD])
    expect(msgs[0]).toEqual({ role: 'system', content: ADJUDICATE_SYSTEM_PROMPT })
    expect(msgs[1].role).toBe('user')
    const payload = JSON.parse(msgs[1].content)
    expect(payload.cards).toHaveLength(1)
    expect(payload.cards[0]).toMatchObject({
      id: '1', kind: 'duration-collision', reason: '时长撞上',
      file: { path: '/src/a.mkv', name: 'a.mkv', sizeBytes: 100, durationS: 3700 },
    })
  })

  it('内部字段（dirSeason / candidate.season）不进发给模型的 JSON', () => {
    const msgs = buildMessages([CARD])
    const payload = JSON.parse(msgs[1].content)
    expect(payload.cards[0]).not.toHaveProperty('dirSeason')
    expect(payload.cards[0].candidates[0]).not.toHaveProperty('season')
    expect(payload.cards[0].candidates[0]).toMatchObject({ leftKey: 'L1', title: '第2期', authorityDurationS: 3700, existing: { path: '/lib/x.mkv' } })
  })
})

describe('parseDecisions', () => {
  it('正常 JSON → 解析成 Decision[]', () => {
    const out = parseDecisions(JSON.stringify({
      decisions: [
        { id: '1', verdict: 'is-episode', leftKey: 'L1', confidence: 'high', reason: '时长精确相等' },
        { id: '2', verdict: 'unsure', confidence: 'low', reason: '拿不准' },
      ],
    }))
    expect(out).toEqual([
      { id: '1', verdict: 'is-episode', leftKey: 'L1', confidence: 'high', reason: '时长精确相等' },
      { id: '2', verdict: 'unsure', confidence: 'low', reason: '拿不准' },
    ])
  })

  it('不是 JSON → null', () => {
    expect(parseDecisions('不是 json 也不是别的什么')).toBeNull()
  })

  it('顶层不是对象 → null', () => {
    expect(parseDecisions('[1,2,3]')).toBeNull()
    expect(parseDecisions('"just a string"')).toBeNull()
  })

  it('decisions 不是数组 → null', () => {
    expect(parseDecisions(JSON.stringify({ decisions: 'nope' }))).toBeNull()
    expect(parseDecisions(JSON.stringify({}))).toBeNull()
  })

  it('verdict/confidence 不在闭集里 → 整批 null（不是丢那一条）', () => {
    expect(parseDecisions(JSON.stringify({
      decisions: [
        { id: '1', verdict: 'is-episode', leftKey: 'L1', confidence: 'high', reason: 'ok' },
        { id: '2', verdict: 'maybe', confidence: 'high', reason: 'bad' },
      ],
    }))).toBeNull()
    expect(parseDecisions(JSON.stringify({
      decisions: [{ id: '1', verdict: 'is-episode', leftKey: 'L1', confidence: 'medium', reason: 'bad' }],
    }))).toBeNull()
  })

  it('缺字段 / 字段类型错 → null', () => {
    expect(parseDecisions(JSON.stringify({ decisions: [{ verdict: 'is-episode', confidence: 'high', reason: 'x' }] }))).toBeNull()
    expect(parseDecisions(JSON.stringify({ decisions: [{ id: 1, verdict: 'is-episode', confidence: 'high', reason: 'x' }] }))).toBeNull()
    expect(parseDecisions(JSON.stringify({ decisions: [{ id: '1', verdict: 'is-episode', confidence: 'high', reason: 'x', leftKey: 5 }] }))).toBeNull()
  })

  it('空 decisions 数组 → 空结果（合法，不是失败）', () => {
    expect(parseDecisions(JSON.stringify({ decisions: [] }))).toEqual([])
  })
})
