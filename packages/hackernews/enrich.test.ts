import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEnrichers } from './enrich.ts'
import type { Article, Enrichment } from '../../src/content/types.ts'

const STORIES: Record<number, unknown> = {
  1: { id: 1, by: 'op', title: 'Linked', url: 'https://example.com/x', descendants: 7 },
  2: { id: 2, by: 'asker', title: 'Ask HN: why?', text: '<p>body</p>', descendants: 0 },
}
const THREADS: Record<number, unknown> = {
  1: { id: 1, children: [{ id: 11, author: 'alice', text: 'hi', created_at_i: 1, children: [] }] },
  2: { id: 2, children: [] },
}

function mockFetch() {
  vi.stubGlobal('fetch', (url: string) => {
    const fb = url.match(/item\/(\d+)\.json/)
    if (fb) return Promise.resolve({ ok: true, json: async () => STORIES[Number(fb[1])] ?? null } as Response)
    const algolia = url.match(/items\/(\d+)/)
    if (algolia) return Promise.resolve({ ok: true, json: async () => THREADS[Number(algolia[1])] ?? null } as Response)
    return Promise.resolve({ ok: false, json: async () => null } as Response)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('hackernews-comments enricher', () => {
  it('returns the linked article (via the host reader) + comments + HN total', async () => {
    mockFetch()
    const readArticle = vi.fn(async (url: string): Promise<Article> => ({ sourceUrl: url, html: '<p>a</p>' }))
    const e = (await makeEnrichers({ readArticle })['hackernews-comments']({ id: '1' })) as Enrichment
    expect(readArticle).toHaveBeenCalledWith('https://example.com/x')
    // the article keeps the story title when the page gave none
    expect(e.article).toMatchObject({ sourceUrl: 'https://example.com/x', title: 'Linked' })
    expect(e.comments?.map((c) => c.id)).toEqual(['11'])
    expect(e.total).toBe(7)
    expect(e.cursor).toBeNull()
  })

  it('Ask/Show HN text post → the post body is the article; no external read', async () => {
    mockFetch()
    const readArticle = vi.fn(async () => null)
    const e = (await makeEnrichers({ readArticle })['hackernews-comments']({ id: '2' })) as Enrichment
    expect(readArticle).not.toHaveBeenCalled()
    expect(e.article).toMatchObject({ title: 'Ask HN: why?', author: 'asker', html: '<p>body</p>' })
    expect(e.article?.sourceUrl).toMatch(/item\?id=2$/)
    expect(e.total).toBe(0)
  })

  it('dead story → empty enrichment (not an error)', async () => {
    mockFetch()
    const e = await makeEnrichers({ readArticle: async () => null })['hackernews-comments']({ id: '999' })
    expect(e).toEqual({})
  })

  it('bad id → ValidationError (host answers 400)', async () => {
    const run = makeEnrichers({ readArticle: async () => null })['hackernews-comments']
    await expect(run({})).rejects.toMatchObject({ name: 'ValidationError' })
    await expect(run({ id: 'abc' })).rejects.toMatchObject({ name: 'ValidationError' })
  })
})
