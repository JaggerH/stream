import { describe, expect, it } from 'vitest'
import { musicToPath, musicRouteFrom } from './MusicChannel.tsx'

describe('music collection route', () => {
  it('round-trips a collection id (incl. special chars)', () => {
    expect(musicToPath({ kind: 'collection', id: 'col_ab12' })).toBe('/music/collection/col_ab12')
    expect(musicRouteFrom('/music/collection/col_ab12')).toEqual({ kind: 'collection', id: 'col_ab12' })
    const weird = 'col a/b'
    expect(musicRouteFrom(musicToPath({ kind: 'collection', id: weird }))).toEqual({ kind: 'collection', id: weird })
  })
  it('leaves the liked path unchanged', () => {
    expect(musicToPath({ kind: 'liked' })).toBe('/music/liked')
    expect(musicRouteFrom('/music/liked')).toEqual({ kind: 'liked' })
  })
})
