import { describe, expect, it } from 'vitest'
import { videoRouteFrom } from './MovieChannel.tsx'

describe('video route', () => {
  it('does not regress existing segments', () => {
    expect(videoRouteFrom('/video/item/abc')).toEqual({ kind: 'item', id: 'abc' })
    expect(videoRouteFrom('/video/work/abc')).toEqual({ kind: 'item', id: 'abc' })   // 老书签
    expect(videoRouteFrom('/video/tmdb/movie/123')).toEqual({ kind: 'tmdb', media: 'movie', id: '123' })
    expect(videoRouteFrom('/video')).toEqual({ kind: 'home' })
  })
})
