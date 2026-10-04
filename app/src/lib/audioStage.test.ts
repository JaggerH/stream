import { describe, it, expect } from 'vitest'
import { nextTrack, type AudioTrack } from './audioStage.ts'

const t = (id: string): AudioTrack => ({ id, url: `u/${id}`, kind: 'music' })
const queue = [t('a'), t('b'), t('c')]

describe('nextTrack (queue auto-advance rule)', () => {
  it('advances to the next track in the queue', () => {
    expect(nextTrack(queue, 'a')?.id).toBe('b')
    expect(nextTrack(queue, 'b')?.id).toBe('c')
  })

  it('stops at the end of the queue (no loop)', () => {
    expect(nextTrack(queue, 'c')).toBeUndefined()
  })

  it('returns undefined for a one-off track (empty queue) or unknown current', () => {
    expect(nextTrack([], 'a')).toBeUndefined()
    expect(nextTrack(queue, undefined)).toBeUndefined()
    expect(nextTrack(queue, 'zzz')).toBeUndefined()
  })
})
