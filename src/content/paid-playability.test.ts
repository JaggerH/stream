import { describe, it, expect } from 'vitest'
import { gateResolveOnlyMedia } from './paid-playability.ts'
import type { StoredItem } from '../item-store.ts'
import type { Media } from './types.ts'

function item(media: Media[]): StoredItem {
  return {
    id: 'i', stream_id: 's', source_type: 'rsshub-bridge', source_route: '/r', fetched_at: '', timestamp: '',
    title: 't', raw: {}, type: 'post', content: { archetype: 'audio', title: 't', media },
  } as unknown as StoredItem
}
/** run the gate over a single item and return its (possibly downgraded) media */
function gatedMedia(media: Media[], lookup?: (k: string) => unknown): Media[] {
  return gateResolveOnlyMedia([item(media)], lookup)[0]!.content!.media!
}
const paidAudio: Media = { kind: 'audio', url: '/api/media/tracks/resolve?platform=lizhi&id=42', platform: 'lizhi', track_id: '42', poster: 'cover.jpg', resolveOnly: true }

describe('gateResolveOnlyMedia', () => {
  it('downgrades an unmatched resolveOnly episode to cover-only (disabled row)', () => {
    expect(gatedMedia([paidAudio], () => undefined)).toEqual([{ kind: 'image', url: 'cover.jpg' }])
  })

  it('keeps a matched resolveOnly episode playable', () => {
    expect(gatedMedia([paidAudio], (k) => (k === 'lizhi:42' ? { ok: true } : undefined))).toEqual([paidAudio])
  })

  it('downgrades when no netdisk lookup is available at all', () => {
    expect(gatedMedia([paidAudio], undefined)[0]?.kind).toBe('image')
  })

  it('with no poster, drops the audio media entirely', () => {
    expect(gatedMedia([{ ...paidAudio, poster: undefined }], () => undefined)).toEqual([])
  })

  it('leaves non-resolveOnly audio (free podcast / netease) untouched', () => {
    const free: Media = { kind: 'audio', url: '/api/media/tracks/resolve?platform=lizhi&id=7&fallback=http://cdn/x.mp3', platform: 'lizhi', track_id: '7' }
    expect(gatedMedia([free], () => undefined)).toEqual([free])
  })

  it('passes through items with no audio media', () => {
    const img: Media = { kind: 'image', url: 'p.jpg' }
    expect(gatedMedia([img], () => undefined)).toEqual([img])
  })
})
