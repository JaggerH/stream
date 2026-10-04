import { describe, it, expect } from 'vitest'
import { neteaseNormalizer, neteaseSongId } from './normalizer.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const manifest = { id: 'rsshub:163/music/playlist/:id' } as unknown as SourceManifest

describe('neteaseSongId', () => {
  it('extracts the song id from a song link or guid', () => {
    expect(neteaseSongId({ link: 'https://music.163.com/song?id=123456' })).toBe('123456')
    expect(neteaseSongId({ link: 'https://music.163.com/#/song?id=789' })).toBe('789')
    expect(neteaseSongId({ link: 'x', guid: 'https://music.163.com/song?id=42' })).toBe('42')
  })
  it('returns undefined for a non-song link (e.g. a playlist listing)', () => {
    expect(neteaseSongId({ link: 'https://music.163.com/user/home?id=60168357' })).toBeUndefined()
  })
})

describe('neteaseNormalizer', () => {
  it('tags a song with a (platform, track_id) REFERENCE — no resolve route baked into storage', () => {
    const c = neteaseNormalizer({ title: '歌名 - 歌手', link: 'https://music.163.com/song?id=123' }, manifest)
    expect(c.archetype).toBe('audio')
    const audio = c.media?.find((m) => m.kind === 'audio')
    expect(audio && 'platform' in audio && audio.platform).toBe('netease')
    expect(audio && 'track_id' in audio && audio.track_id).toBe('123')
    // the resolve route is NOT persisted — the reader builds it from the reference at play time
    expect((audio as { url?: string } | undefined)?.url).toBeUndefined()
  })
  it('falls back to a link for a non-song item', () => {
    const c = neteaseNormalizer({ title: '某人的歌单', link: 'https://music.163.com/user/home?id=1' }, manifest)
    expect(c.archetype).toBe('link')
    expect(c.media?.[0]?.kind).toBe('link')
  })
  it('renders a VIP song (category VIP) as a non-playable link (not audio)', () => {
    const c = neteaseNormalizer(
      { title: 'x - y', link: 'https://music.163.com/song?id=1', category: ['VIP'], picUrl: 'http://p/1.jpg' },
      manifest
    )
    expect(c.archetype).toBe('link')
    const link = c.media?.[0]
    expect(link?.kind).toBe('link')
    expect(link && 'title' in link && link.title).toContain('VIP')
  })
  it('renders a native free song as playable audio with its album cover poster', () => {
    const c = neteaseNormalizer(
      { title: 'x - y', link: 'https://music.163.com/song?id=1', fee: 0, picUrl: 'http://p/1.jpg' },
      manifest
    )
    expect(c.archetype).toBe('audio')
    const audio = c.media?.find((m) => m.kind === 'audio')
    expect(audio && 'platform' in audio && audio.platform).toBe('netease')
    expect(audio && 'track_id' in audio && audio.track_id).toBe('1')
    expect(audio && 'poster' in audio && audio.poster).toBe('http://p/1.jpg')
  })
})
