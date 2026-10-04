import { describe, expect, it } from 'vitest'
import { gateResolveOnlyVideoMedia } from './video-playability.ts'
import type { StoredItem } from '../item-store.ts'

function galleryItem(id: string, streamId: string): StoredItem {
  return {
    id,
    stream_id: streamId,
    source_type: 'rsshub-bridge',
    source_route: '/movie/episodes',
    fetched_at: '',
    timestamp: '',
    title: 'Episode',
    raw: {},
    type: 'post',
    content: {
      archetype: 'gallery',
      media: [
        { kind: 'image', url: 'cover.jpg' },
        { kind: 'video', page_url: 'https://origin.example.test/episode' },
      ],
    },
  } as StoredItem
}

describe('gateResolveOnlyVideoMedia', () => {
  it('replaces a bound and mapped gallery episode with the same-origin resolver video', () => {
    const boundItem = galleryItem('i-1', 'bound-stream')

    const [gatedHit] = gateResolveOnlyVideoMedia(
      [boundItem],
      (key) => (key === 'item:i-1' ? { rightFile: 'episode.mp4' } : undefined),
      (streamId) => streamId === 'bound-stream',
      (streamId) => streamId === 'bound-stream',
    )

    expect(gatedHit.content!.media).toEqual([
      { kind: 'video', url: '/api/media/videos/resolve?id=i-1', poster: 'cover.jpg', resolveOnly: true },
    ])
  })

  it('keeps a bound but unmapped gallery episode visible as a disabled video card', () => {
    const boundItem = galleryItem('i-2', 'bound-stream')

    const [gatedMiss] = gateResolveOnlyVideoMedia(
      [boundItem],
      () => undefined,
      (streamId) => streamId === 'bound-stream',
      (streamId) => streamId === 'bound-stream',
    )

    expect(gatedMiss.content!.media).toEqual([
      { kind: 'video', poster: 'cover.jpg', resolveOnly: true },
    ])
  })

  it('leaves a gallery item from an unbound stream unchanged', () => {
    const unboundItem = galleryItem('i-3', 'unbound-stream')

    const [gatedUnbound] = gateResolveOnlyVideoMedia(
      [unboundItem],
      () => undefined,
      () => false,
      () => true,
    )

    expect(gatedUnbound).toEqual(unboundItem)
  })

  it('leaves a bound item from a non-video stream unchanged', () => {
    const nonVideoItem = galleryItem('i-4', 'timeline-stream')

    const [gatedNonVideo] = gateResolveOnlyVideoMedia(
      [nonVideoItem],
      () => ({ rightFile: 'episode.mp4' }),
      () => true,
      () => false,
    )

    expect(gatedNonVideo).toEqual(nonVideoItem)
  })
})
