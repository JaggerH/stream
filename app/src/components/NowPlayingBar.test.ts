import { describe, expect, it } from 'vitest'
import { lyricsKeys, toStageTrack } from './NowPlayingBar.tsx'
import type { AudioTrack } from '../lib/audioStage.ts'

const track = (over: Partial<AudioTrack> = {}): AudioTrack => ({ id: 't1', url: 'u', kind: 'music', ...over })

describe('lyricsKeys', () => {
  it('有 platform + trackId → 精确 key 在前，不判具体平台', () => {
    expect(lyricsKeys({ platform: 'a-platform', trackId: '1' } as never)).toEqual(['a-platform:1'])
    expect(lyricsKeys({ platform: 'another', trackId: '9' } as never)).toEqual(['another:9'])
  })
  // 一个平台可以有 trackUrl（于是曲目带着 platform:id）却没有任何歌词源——那时精确 key 会被
  // 每一条源 decline，而歌名+歌手明明查得到。只发第一个 key 的表现是"这首歌没有歌词"。
  it('精确 + 模糊都有 → 两个都给，精确在前', () => {
    expect(lyricsKeys({ platform: 'p', trackId: '1', title: 'T', author: 'A' } as never)).toEqual(['p:1', 'T::A'])
  })
  it('缺 platform 或 trackId → 只有模糊那一个', () => {
    expect(lyricsKeys({ trackId: '1', title: 'T', author: 'A' } as never)).toEqual(['T::A'])
    expect(lyricsKeys({ platform: 'x', title: 'T', author: 'A' } as never)).toEqual(['T::A'])
  })
  it('两样都没有 → 一个都不发', () => {
    expect(lyricsKeys({ title: 'T' } as never)).toEqual([])
  })
})

describe('toStageTrack', () => {
  it('maps an AudioTrack to the acrylic stage shape, omitting lyrics when absent', () => {
    expect(toStageTrack(track({ title: 'T', author: 'A', poster: 'P' }))).toEqual({ title: 'T', artist: 'A', cover: 'P' })
  })
  it('falls back to a placeholder title when the track has none', () => {
    expect(toStageTrack(track({ title: undefined }))).toEqual({ title: '播放中', artist: undefined, cover: undefined })
  })
  it('includes lyrics only when the array is non-empty', () => {
    const lyrics = [{ time: 0, text: 'hi' }]
    expect(toStageTrack(track({ title: 'T' }), lyrics)).toEqual({ title: 'T', artist: undefined, cover: undefined, lyrics })
    expect(toStageTrack(track({ title: 'T' }), [])).toEqual({ title: 'T', artist: undefined, cover: undefined })
  })
})
