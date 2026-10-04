import { describe, expect, it } from 'vitest'
import { v2exNormalizer } from './normalizer.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const mf = { id: 'rsshub:v2ex/topics/:type' } as SourceManifest

describe('v2exNormalizer', () => {
  it('text topic → text archetype + declares where the replies live', () => {
    const c = v2exNormalizer(
      {
        title: '女性的消费水平确实是高',
        link: 'https://www.v2ex.com/t/1242297',
        description: 'BatmanOfficial: <p>每次经过大商场</p>\n',
      },
      mf,
    )
    expect(c.archetype).toBe('text')
    expect(c.text).toContain('每次经过大商场')
    expect(c.enrich).toEqual({ source: 'v2ex-comments', params: { id: '1242297' }, prefetch: true })
  })

  it('topic with images → gallery, still carries the enrich declaration', () => {
    const c = v2exNormalizer(
      { title: 't', link: 'https://v2ex.com/t/5#reply3', description: '<p>看图</p><img src="https://i.imgur.com/a.png">' },
      mf,
    )
    expect(c.archetype).toBe('gallery')
    expect(c.media).toEqual([{ kind: 'image', url: 'https://i.imgur.com/a.png' }])
    expect(c.enrich?.params).toEqual({ id: '5' })
  })

  it('no topic link → no enrich declaration', () => {
    const c = v2exNormalizer({ title: 't', link: 'https://example.com/t/5', description: 'x' }, mf)
    expect(c.enrich).toBeUndefined()
  })
})
