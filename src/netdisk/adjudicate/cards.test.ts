import { describe, it, expect } from 'vitest'
import {
  cardsFromPending, cardsFromFollowCandidates, cardsHash, selectCards,
  type Card,
} from './cards.ts'
import type { AuthorityEntry } from '../reconcile/plan.ts'
import type { PendingLike } from '../../mcp/reconcile-surface.ts'

const AUTH: AuthorityEntry[] = [
  { leftKey: 'tmdb:9:S01E01', title: '第1期', durationS: 3600 },
  { leftKey: 'tmdb:9:S01E02', title: '第2期', durationS: 3700, pinnedRight: '/lib/S01/S01E02 - 第2期.mkv' },
  { leftKey: 'tmdb:9:S02E01', title: '第1期', durationS: 3800 },
]

describe('cardsFromPending', () => {
  it('evidence-conflict：candidates 来自 conflictsWith,按序对齐,缺失的 leftKey 被丢弃', () => {
    const pending: PendingLike[] = [{
      src: { path: '/src/a.mkv', size: 100 },
      pendingKind: 'evidence-conflict',
      conflictsWith: ['tmdb:9:S01E01', 'tmdb:9:不存在', 'tmdb:9:S02E01'],
      reason: '证据指向好几集',
    }]
    const [card] = cardsFromPending(pending, AUTH)
    expect(card.kind).toBe('evidence-conflict')
    expect(card.file).toEqual({ path: '/src/a.mkv', name: 'a.mkv', sizeBytes: 100 })
    expect(card.candidates.map((c) => c.leftKey)).toEqual(['tmdb:9:S01E01', 'tmdb:9:S02E01'])
    expect(card.reason).toBe('证据指向好几集')
  })

  it('duration-collision：candidates 只含 collidesWith 那一集，existing 从 pinnedRight 带出', () => {
    const pending: PendingLike[] = [{
      src: { path: '/src/b.mkv', size: 200, durationS: 3701 },
      pendingKind: 'duration-collision',
      collidesWith: 'tmdb:9:S01E02',
      reason: '时长撞上',
    }]
    const [card] = cardsFromPending(pending, AUTH)
    expect(card.candidates).toHaveLength(1)
    expect(card.candidates[0]).toMatchObject({
      leftKey: 'tmdb:9:S01E02', title: '第2期', authorityDurationS: 3700,
      existing: { path: '/lib/S01/S01E02 - 第2期.mkv' },
      season: 1,
    })
  })

  it('no-duration：文件名带「第N期」→ 只留标题期号相同的候选（可跨季，季一致性交给 gate.ts 二次把关）；dirSeason 仍从 seasonOfDir 取', () => {
    const pending: PendingLike[] = [{
      src: { path: '/src/S01/第1期.mkv', size: 300 },
      pendingKind: 'no-duration',
      reason: '时长没探到',
    }]
    const seasonOfDir = new Map<string, number | null>([['/src/S01', 1]])
    const [card] = cardsFromPending(pending, AUTH, seasonOfDir)
    expect(card.candidates.map((c) => c.leftKey).sort()).toEqual(['tmdb:9:S01E01', 'tmdb:9:S02E01'])
    expect(card.dirSeason).toBe(1)
  })

  it('no-duration：文件名没有「第N期」→ 这张卡不造（v1 不问，不是造一张模型答不出的空卡）', () => {
    const pending: PendingLike[] = [{ src: { path: '/src/x.mkv', size: 1 }, pendingKind: 'no-duration', reason: 'r' }]
    expect(cardsFromPending(pending, AUTH)).toEqual([])
  })

  it('no-duration：文件名的期号在清单标题里找不到匹配 → 收窄后为空 → 这张卡不造', () => {
    const pending: PendingLike[] = [{ src: { path: '/src/第99期.mkv', size: 1 }, pendingKind: 'no-duration', reason: 'r' }]
    expect(cardsFromPending(pending, AUTH)).toEqual([])
  })

  it('suspect-dir 熔断的、以及不在三档白名单内的 pendingKind，一概不出卡', () => {
    const pending: PendingLike[] = [
      { src: { path: '/a', size: 1 }, pendingKind: 'evidence-conflict', suspect: { dir: '/x', bad: 1, total: 2, priorVerdict: 'p' } },
      { src: { path: '/b', size: 1 }, pendingKind: 'swap-hold' },
      { src: { path: '/c', size: 1 }, pendingKind: 'replace' },
      { src: { path: '/d', size: 1 }, pendingKind: 'season-unresolved' },
      { src: { path: '/e', size: 1 } }, // 没有 pendingKind
    ]
    expect(cardsFromPending(pending, AUTH)).toEqual([])
  })
})

describe('cardsFromFollowCandidates', () => {
  it('kind 恒为 follow-candidate，candidates 按 candidateLeftKeys 取', () => {
    const [card] = cardsFromFollowCandidates(
      [{ file: { path: '分享/第10期.mp3', name: '第10期.mp3' }, candidateLeftKeys: ['tmdb:9:S01E01', 'nope'] }],
      AUTH,
    )
    expect(card.kind).toBe('follow-candidate')
    expect(card.candidates.map((c) => c.leftKey)).toEqual(['tmdb:9:S01E01'])
  })
})

describe('cardsHash', () => {
  it('内容相同则指纹相同，与 id 无关', () => {
    const a: Card = { id: '1', kind: 'no-duration', file: { path: '/x', name: 'x' }, candidates: [{ leftKey: 'L1', title: 't' }], reason: 'r' }
    const b: Card = { ...a, id: '99' }
    expect(cardsHash([a])).toBe(cardsHash([b]))
  })
  it('内容变了（多一个候选）指纹跟着变', () => {
    const a: Card = { id: '1', kind: 'no-duration', file: { path: '/x', name: 'x' }, candidates: [{ leftKey: 'L1', title: 't' }], reason: 'r' }
    const b: Card = { ...a, candidates: [...a.candidates, { leftKey: 'L2', title: 't2' }] }
    expect(cardsHash([a])).not.toBe(cardsHash([b]))
  })
  it('16 位十六进制', () => {
    const h = cardsHash([])
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('selectCards', () => {
  const mk = (kind: Card['kind'], path: string): Card => ({ id: '', kind, file: { path, name: path }, candidates: [], reason: '' })

  it('按 evidence-conflict > duration-collision > no-duration > follow-candidate 优先级排序，同类按路径', () => {
    const cards = [mk('no-duration', '/b'), mk('evidence-conflict', '/z'), mk('follow-candidate', '/a'), mk('duration-collision', '/c'), mk('evidence-conflict', '/a')]
    const out = selectCards(cards, 10)
    expect(out.map((c) => c.kind)).toEqual(['evidence-conflict', 'evidence-conflict', 'duration-collision', 'no-duration', 'follow-candidate'])
    expect(out[0].file.path).toBe('/a') // 同类按路径升序
    expect(out[1].file.path).toBe('/z')
  })

  it('超过 max 按同一优先级截断，并从 1 开始编号', () => {
    const cards = [mk('no-duration', '/1'), mk('no-duration', '/2'), mk('no-duration', '/3')]
    const out = selectCards(cards, 2)
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.id)).toEqual(['1', '2'])
    expect(out.map((c) => c.file.path)).toEqual(['/1', '/2'])
  })
})
