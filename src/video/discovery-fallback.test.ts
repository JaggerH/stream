import { describe, expect, it } from 'vitest'
import { videoDiscoveryFallback } from './discovery-fallback.ts'

describe('video discovery fallback', () => {
  it('turns a row whose normalizer declared `meta.discovery` into safe detail fields', () => {
    expect(videoDiscoveryFallback({
      id: 'shelf-1', stream_id: 'video-shelf', source_type: 'rsshub-bridge', source_route: '/x/shelf', title: '功夫女足',
      raw: {},
      content: {
        archetype: 'gallery',
        title: '功夫女足',
        meta: { source: 'shelf', rating: '6.6', discovery: { runtimeMinutes: 106, directors: ['周星驰'], actors: ['张小斐', '迪丽热巴'] } },
      },
      timestamp: '2026-07-15T00:00:00.000Z', fetched_at: '2026-07-15T00:00:00.000Z',
    })).toEqual({
      source: 'shelf-discovery',
      title: '功夫女足',
      runtimeMinutes: 106,
      ratings: [{ source: 'shelf', value: 6.6, scale: 10 }],
      people: [
        { name: '周星驰', role: 'director' },
        { name: '张小斐', role: 'actor' },
        { name: '迪丽热巴', role: 'actor' },
      ],
      externalIds: {},
    })
  })

  it('does not invent a fallback when the normalizer declared no discovery subset', () => {
    expect(videoDiscoveryFallback({ id: 'a', stream_id: 'video-a', source_type: 'rsshub-bridge', source_route: '/a', title: 'A', raw: {}, content: { archetype: 'gallery', meta: { source: 'x', rating: '8' } }, timestamp: 't', fetched_at: 't' })).toBeNull()
  })

  it('does not parse the raw description itself (site text is the package\'s job)', () => {
    expect(videoDiscoveryFallback({
      id: 'b', stream_id: 'video-b', source_type: 'rsshub-bridge', source_route: '/b', title: 'B',
      raw: { description: '片长：106分钟<br>导演：某人<br>' },
      content: { archetype: 'gallery', meta: { source: 'x' } }, timestamp: 't', fetched_at: 't',
    })).toBeNull()
  })
})
