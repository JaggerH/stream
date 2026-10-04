import { describe, it, expect } from 'vitest'
import { computeStates } from './state.ts'
import { candidateKey } from './memberKey.ts'
import type { Candidate, ChannelSummary } from './types.ts'

const candidates: Candidate[] = [
  { sourceId: 'rsshub:xiaohongshu/user', params: { id: '42' }, title: '小红书用户' },
  { sourceId: 'rsshub:weibo/user', params: { uid: '99' }, title: '微博用户' },
]

describe('computeStates', () => {
  it('marks a candidate subscribed iff its key is reachable from the current channel', () => {
    const channel: ChannelSummary = {
      id: 'ch1', label: 'A', variant: 'timeline', streamIds: ['s1'],
      members: [{ key: candidateKey('rsshub:xiaohongshu/user', { id: '42' }), streamId: 's1' }],
    }
    const subscribedKeys = new Set(channel.members.map((m) => m.key))
    const states = computeStates(candidates, subscribedKeys)
    expect(states.map((s) => s.subscribed)).toEqual([true, false])
  })

  it('recomputes locally when the current channel changes (no fetch)', () => {
    const states = computeStates(candidates, new Set<string>())
    expect(states.every((s) => !s.subscribed)).toBe(true)
  })
})
