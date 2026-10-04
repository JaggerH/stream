import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AiTrackRecord } from './reconcile-ai-batch-bar.tsx'
import type { AgreementCounts, SuggestionSummary } from '../lib/types.ts'

afterEach(cleanup)

describe('历史一致率（自动采纳的门槛读数）', () => {
  const counts = (o: Partial<AgreementCounts> = {}): AgreementCounts =>
    ({ countable: 0, agreed: 0, disagreed: 0, inconclusive: 0, open: 0, ...o })
  const summary = (isEpisode: Partial<AgreementCounts>): SuggestionSummary => ({
    total: 0, ...counts(),
    byKind: { 'is-episode': counts(isEpisode), 'none-of-these': counts() },
  })

  it('一条答过的样本都没有 → 整条不出现（「0 / 0 一致」不是信息）', () => {
    render(<AiTrackRecord summary={summary({ open: 5 })} />)
    expect(screen.queryByTestId('ai-track-record')).toBeNull()
    cleanup()
    render(<AiTrackRecord summary={null} />)
    expect(screen.queryByTestId('ai-track-record')).toBeNull()
  })

  it('分母只算答过的：还没答的和没法比的不许并进去（并进去一致率会虚高）', () => {
    render(<AiTrackRecord summary={summary({ countable: 20, agreed: 9, disagreed: 1, inconclusive: 4, open: 6 })} />)
    const line = screen.getByTestId('ai-track-record').textContent ?? ''
    expect(line).toContain('10 次里')
    expect(line).toContain('认同 9 次')
  })

  it('分歧是 0 也照样显示——那一格才是决定放不放开的，藏起来就成了报喜', () => {
    render(<AiTrackRecord summary={summary({ countable: 12, agreed: 12 })} />)
    expect(screen.getByTestId('ai-track-record').textContent).toContain('改判 0 次')
  })
})
