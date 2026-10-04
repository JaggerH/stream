import { describe, it, expect } from 'vitest'
import { musicLayer } from './MusicChannel.tsx'

const PLAYLIST = 'rsshub-163-music-playlist-60168357'
const LIKED = '__liked_songs__'

describe('musicLayer — deep-linked playlist survives a cold refresh (no empty-state flash)', () => {
  it('THE BUG: playlist selected in URL, channels not yet loaded → spinner, NOT the grid/empty-state', () => {
    // cold refresh of /music/playlist/<id>: sel is seeded from the URL, but `channels` is still
    // in flight so selStream can't resolve. Must hold a spinner, not commit to the grid.
    expect(musicLayer({ sel: PLAYLIST, selStream: false, isLikedPlaylist: false, channelsLoaded: false })).toBe('loading')
  })

  it('once channels load and the playlist resolves → the track list opens', () => {
    expect(musicLayer({ sel: PLAYLIST, selStream: true, isLikedPlaylist: false, channelsLoaded: true })).toBe('track-list')
  })

  it('channels loaded but the id is unknown (bad/stale link) → grid, not a perpetual spinner', () => {
    expect(musicLayer({ sel: PLAYLIST, selStream: false, isLikedPlaylist: false, channelsLoaded: true })).toBe('grid')
  })

  it('liked songs need no channels → track list immediately, even mid-load', () => {
    expect(musicLayer({ sel: LIKED, selStream: false, isLikedPlaylist: true, channelsLoaded: false })).toBe('track-list')
  })

  it('home (no selection) while channels load → spinner, not the "还没有歌单" empty-state', () => {
    expect(musicLayer({ sel: null, selStream: false, isLikedPlaylist: false, channelsLoaded: false })).toBe('loading')
  })

  it('home once channels loaded → grid', () => {
    expect(musicLayer({ sel: null, selStream: false, isLikedPlaylist: false, channelsLoaded: true })).toBe('grid')
  })
})

describe('musicLayer — collection route (播单详情) is not a stream, must not wait on channels', () => {
  it('THE BUG shape: deep-linked/cold-refreshed collection route, channels not yet loaded → still track-list, not the loading spinner', () => {
    // A collection isn't a subscribed stream — it must short-circuit before the channelsLoaded gate,
    // same reasoning as isLikedPlaylist above. Regression coverage for the isCollection branch itself.
    expect(musicLayer({ sel: null, selStream: false, isLikedPlaylist: false, channelsLoaded: false, isCollection: true })).toBe('track-list')
  })

  it('collection route with channels already loaded → still track-list', () => {
    expect(musicLayer({ sel: null, selStream: false, isLikedPlaylist: false, channelsLoaded: true, isCollection: true })).toBe('track-list')
  })
})
