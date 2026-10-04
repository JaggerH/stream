import { describe, expect, it } from 'vitest'
import { isSliceable } from './sliceable.ts'

describe('isSliceable', () => {
  it('只认裸帧流', () => {
    expect(isSliceable('/a/b.mp3')).toBe(true)
    expect(isSliceable('/a/b.AAC')).toBe(true)
  })

  it('容器格式一律不切——切出来是解不开的字节，转写会空得像"没人说话"', () => {
    for (const p of ['/a/b.mp4', '/a/b.mkv', '/a/b.m4a', '/a/b.wav', '/a/b']) {
      expect(isSliceable(p)).toBe(false)
    }
  })
})

// 「切得动**且**知道时长」这另一半门在 `sample-audio.ts`（时长是探出来的，不是调用方给的），
// 由 sample-audio.test.ts 钉着。
