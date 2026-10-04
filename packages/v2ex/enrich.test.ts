import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEnrichers } from './enrich.ts'
import type { Enrichment } from '../../src/content/types.ts'

afterEach(() => vi.unstubAllGlobals())

const run = makeEnrichers()['v2ex-comments']

describe('v2ex-comments enricher', () => {
  it('maps v1 replies → flat comments; the topic body is not refetched', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      seen.push(url)
      return Promise.resolve({
        ok: true,
        json: async () => [
          {
            id: 1,
            content: 'first reply',
            content_rendered: '<p>first reply</p>',
            created: 1700000000,
            member: { username: 'alice', avatar_normal: 'a.png' },
          },
          { id: 2, content: '', content_rendered: '', member: { username: 'empty' } }, // dropped
        ],
      } as Response)
    })
    const e = (await run({ id: '123' })) as Enrichment
    expect(seen).toEqual(['https://www.v2ex.com/api/replies/show.json?topic_id=123'])
    expect(e.article).toBeUndefined()
    expect(e.comments).toHaveLength(1)
    expect(e.comments![0]).toMatchObject({ id: '1', author: 'alice', avatar: 'a.png', text: 'first reply', time: 1700000000 })
    expect(e.comments![0].html).toBe('<p>first reply</p>')
    expect(e.total).toBe(1)
    expect(e.cursor).toBeNull()
  })

  it('failed / non-array response → empty thread, not an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false } as Response))
    expect(await run({ id: '1' })).toEqual({ comments: [], total: 0, cursor: null })
  })

  it('bad id → ValidationError (host answers 400)', async () => {
    await expect(run({})).rejects.toMatchObject({ name: 'ValidationError' })
    await expect(run({ id: '1x' })).rejects.toMatchObject({ name: 'ValidationError' })
  })
})
