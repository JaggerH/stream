import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHnStory, fetchThreadComments } from './client.ts'

// story metadata comes from Firebase item/{id}.json; the comment tree from Algolia
// items/{id} (nested children inline). Story 1 → comments 2 (OP, reply 4) and 3; 9 deleted.
const FB_ITEMS: Record<number, unknown> = {
  1: { id: 1, type: 'story', by: 'op', title: 'Title', url: 'https://example.com/post', descendants: 4 },
  5: { id: 5, deleted: true },
}
const ALGOLIA_ITEMS: Record<number, unknown> = {
  1: {
    id: 1,
    author: 'op',
    title: 'Title',
    url: 'https://example.com/post',
    text: null,
    children: [
      {
        id: 2,
        author: 'op',
        text: '<p>op&#x2F;reply</p>',
        created_at_i: 100,
        children: [{ id: 4, author: 'bob', text: 'nested', created_at_i: 102, children: [] }],
      },
      { id: 3, author: 'alice', text: 'plain reply', created_at_i: 101, children: [] },
      { id: 9, author: null, text: null, children: [] },
    ],
  },
}

function mockFetch() {
  vi.stubGlobal('fetch', (url: string) => {
    const fb = url.match(/item\/(\d+)\.json/)
    if (fb) return Promise.resolve({ ok: true, json: async () => FB_ITEMS[Number(fb[1])] ?? null } as Response)
    const algolia = url.match(/items\/(\d+)/)
    if (algolia)
      return Promise.resolve({ ok: true, json: async () => ALGOLIA_ITEMS[Number(algolia[1])] ?? null } as Response)
    return Promise.resolve({ ok: false, json: async () => null } as Response)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchHnStory', () => {
  it('reads story metadata (url, author, total)', async () => {
    mockFetch()
    const s = await fetchHnStory(1)
    expect(s).toMatchObject({ id: 1, by: 'op', url: 'https://example.com/post', total: 4 })
  })

  it('returns null for a dead/deleted root', async () => {
    mockFetch()
    expect(await fetchHnStory(5)).toBeNull()
  })
})

describe('fetchThreadComments', () => {
  it('builds a threaded tree, flags OP, drops dead', async () => {
    mockFetch()
    const comments = await fetchThreadComments(1, 'op')

    // dead comment (9) dropped; 2 top-level survive
    expect(comments.map((c) => c.id)).toEqual(['2', '3'])

    const [opComment, plain] = comments
    expect(opComment.badges).toEqual(['OP']) // author === story.by
    expect(plain.badges).toBeUndefined()

    // html kept for the host to sanitize; entities decoded into the text mirror
    expect(opComment.html).toContain('<p>')
    expect(opComment.text).toBe('op/reply')

    // nested reply threads under the OP comment
    expect(opComment.replies?.map((r) => r.id)).toEqual(['4'])
    expect(plain.replies).toBeUndefined()
  })

  it('returns [] when the thread request fails', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')))
    expect(await fetchThreadComments(1)).toEqual([])
  })
})
