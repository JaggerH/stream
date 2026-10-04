import { describe, it, expect } from 'vitest'
import { getPath, substitute, interpret, interpretObject, mapItem, ReplayDriftError, type ResolvedFetch } from './interpret.ts'
import type { Recipe, FetchRecipe, HttpRecipe } from './recipe.ts'
import { XHS_FEED_RECIPE, XHS_FEED_PAGES } from './__fixtures__/xhs-feed.ts'

function singlePageRecipe(): FetchRecipe {
  return {
    version: 1,
    kind: 'fetch',
    sourceId: 'xhs-search',
    cookieDomain: 'xiaohongshu.com',
    entryUrl: 'https://www.xiaohongshu.com/search_result?keyword={keyword}',
    request: {
      url: '/api/sns/web/v1/search/notes?keyword={keyword}&cursor={cursor}',
      method: 'GET',
    },
    pagination: { mode: 'cursor', itemsAt: 'data.items', cursorFrom: 'data.cursor', cursorParam: 'cursor', maxPages: 1 },
    assert: [{ path: 'data.items', desc: 'search returned no items array (login-wall or endpoint moved)' }],
    mapping: { title: 'note.title', url: 'note.link', author: 'note.user.name' },
  }
}

describe('getPath', () => {
  it('reads nested object and array paths', () => {
    const obj = { data: { items: [{ id: 'x' }, { id: 'y' }], cursor: 'c1' } }
    expect(getPath(obj, 'data.cursor')).toBe('c1')
    expect(getPath(obj, 'data.items.1.id')).toBe('y')
  })
  it('returns undefined for a missing segment', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined()
    expect(getPath(null, 'a')).toBeUndefined()
  })
  it('treats the empty path as identity (root)', () => {
    const arr = [{ id: 'x' }]
    expect(getPath(arr, '')).toBe(arr)
    const obj = { a: 1 }
    expect(getPath(obj, '')).toBe(obj)
  })
})

describe('mapItem', () => {
  const raw = { id: 'abc', xsecToken: 'TK-1', noteCard: { displayTitle: '短发女', type: 'video', user: { nickName: 'Nean' } } }

  it('maps plain dot-path fields', () => {
    expect(mapItem(raw, { title: 'noteCard.displayTitle', author: 'noteCard.user.nickName', note_type: 'noteCard.type' }))
      .toEqual({ title: '短发女', author: 'Nean', note_type: 'video' })
  })

  it('composes a template field from the raw item\'s own paths', () => {
    const out = mapItem(raw, { link: 'https://www.xiaohongshu.com/explore/{id}?xsec_token={xsecToken}&s=pc_feed' })
    expect(out.link).toBe('https://www.xiaohongshu.com/explore/abc?xsec_token=TK-1&s=pc_feed')
  })

  it('renders a missing template path as empty, not the literal hole', () => {
    expect(mapItem(raw, { link: '/x/{id}/{missing.deep}' }).link).toBe('/x/abc/')
  })

  it('a leading `=` is a literal constant, not a dot-path (bare constant would resolve to undefined)', () => {
    expect(mapItem(raw, { author: '=转转回收', platform: '=zhuanzhuan' })).toEqual({ author: '转转回收', platform: 'zhuanzhuan' })
    expect(mapItem(raw, { author: '转转回收' }).author).toBeUndefined()
  })
})

describe('substitute', () => {
  it('replaces known holes and leaves unknown ones untouched', () => {
    expect(substitute('/feed?kw={keyword}&c={cursor}', { keyword: 'cat', cursor: '' }))
      .toBe('/feed?kw=cat&c=')
    expect(substitute('/x?c={cursor}', { keyword: 'cat' })).toBe('/x?c={cursor}')
  })
})

describe('interpret — single page', () => {
  it('resolves the fetch template, asserts, and maps items', async () => {
    const calls: ResolvedFetch[] = []
    const deps = {
      fetchInPage: async (req: ResolvedFetch) => {
        calls.push(req)
        return {
          data: {
            cursor: 'c2',
            items: [
              { note: { title: 'A', link: 'https://x/a', user: { name: 'u1' } } },
              { note: { title: 'B', link: 'https://x/b', user: { name: 'u2' } } },
            ],
          },
        }
      },
    }
    const out = await interpret(singlePageRecipe(), deps, { keyword: 'cat' })

    expect(calls[0].url).toBe('/api/sns/web/v1/search/notes?keyword=cat&cursor=')
    expect(calls[0].method).toBe('GET')
    expect(out.pages).toBe(1)
    expect(out.items).toEqual([
      { title: 'A', url: 'https://x/a', author: 'u1' },
      { title: 'B', url: 'https://x/b', author: 'u2' },
    ])
  })

  it('throws ReplayDriftError when an assert path is missing', async () => {
    const deps = { fetchInPage: async () => ({ data: {} }) } // no items array
    await expect(interpret(singlePageRecipe(), deps, { keyword: 'cat' }))
      .rejects.toBeInstanceOf(ReplayDriftError)
  })
})

describe('interpret — pagination', () => {
  function pagedRecipe(maxPages: number): FetchRecipe {
    const a = singlePageRecipe()
    a.pagination = { ...a.pagination, maxPages, hasMore: 'data.has_more' }
    return a
  }

  it('threads the cursor and concatenates pages until cursor is empty', async () => {
    const seen: string[] = []
    const pageData: Record<string, unknown> = {
      '': { data: { has_more: true, cursor: 'c2', items: [{ note: { title: 'A', link: 'l', user: { name: 'u' } } }] } },
      c2: { data: { has_more: true, cursor: '', items: [{ note: { title: 'B', link: 'l', user: { name: 'u' } } }] } },
    }
    const deps = {
      fetchInPage: async (req: ResolvedFetch) => {
        const c = new URL('https://x' + req.url).searchParams.get('cursor') ?? ''
        seen.push(c)
        return pageData[c]
      },
    }
    const out = await interpret(pagedRecipe(10), deps, { keyword: 'cat' })
    expect(seen).toEqual(['', 'c2'])                // cursor threaded page-to-page
    expect(out.pages).toBe(2)
    expect(out.items.map((i) => i.title)).toEqual(['A', 'B'])
  })

  it('stops at maxPages even when more pages exist', async () => {
    const deps = {
      fetchInPage: async () => ({ data: { has_more: true, cursor: 'always', items: [{ note: { title: 'X', link: 'l', user: { name: 'u' } } }] } }),
    }
    const out = await interpret(pagedRecipe(3), deps, { keyword: 'cat' })
    expect(out.pages).toBe(3)
    expect(out.items).toHaveLength(3)
  })

  it('stops when hasMore is falsy', async () => {
    const deps = {
      fetchInPage: async () => ({ data: { has_more: false, cursor: 'c2', items: [{ note: { title: 'X', link: 'l', user: { name: 'u' } } }] } }),
    }
    const out = await interpret(pagedRecipe(10), deps, { keyword: 'cat' })
    expect(out.pages).toBe(1)
  })

  it('keeps earlier pages when a later page drifts (login-wall past the anonymous window)', async () => {
    // Page 0 returns real items; the cursor points at page 2, which hits a login-wall
    // (assert path `data.items` gone). Drift AFTER a good page is a pagination boundary,
    // not a dead source — the page-0 items must survive, not be discarded.
    const pageData: Record<string, unknown> = {
      '': { data: { has_more: true, cursor: 'c2', items: [{ note: { title: 'A', link: 'l', user: { name: 'u' } } }] } },
      c2: { data: {} }, // login-wall: no items array
    }
    const deps = {
      fetchInPage: async (req: ResolvedFetch) => {
        const c = new URL('https://x' + req.url).searchParams.get('cursor') ?? ''
        return pageData[c]
      },
    }
    const out = await interpret(pagedRecipe(10), deps, { keyword: 'cat' })
    expect(out.items.map((i) => i.title)).toEqual(['A'])
    expect(out.pages).toBe(2) // both pages fetched; the second tripped the boundary
  })
})

describe('interpret — increment pagination', () => {
  function incrementRecipe(maxPages: number, step = 1): Recipe {
    return {
      version: 1, kind: 'fetch', sourceId: 'inc', cookieDomain: '',
      entryUrl: 'https://x/',
      request: { url: '/api?q={q}&page={page}', method: 'GET' },
      pagination: { mode: 'increment', itemsAt: 'hits', param: 'page', start: 0, step, maxPages },
      assert: [{ path: 'hits', desc: 'no hits' }],
      mapping: { title: 't' },
    }
  }

  it('maps a ROOT-array response via an empty itemsAt (e.g. HF /api/spaces)', async () => {
    const recipe: Recipe = {
      version: 1, kind: 'http', sourceId: 'root', request: { url: '/api?q={q}', method: 'GET' },
      pagination: { mode: 'increment', itemsAt: '', param: 'page', start: 1, step: 1, maxPages: 1 },
      assert: [{ path: '', desc: 'root array' }],
      mapping: { title: 'name' },
    }
    const deps = { fetchInPage: async () => [{ name: 'a' }, { name: 'b' }] } // bare array at the root
    const out = await interpret(recipe, deps, { q: 'x' })
    expect(out.items.map((i) => i.title)).toEqual(['a', 'b'])
  })

  it('injects an incrementing counter and stops on the first empty page', async () => {
    const seen: string[] = []
    const byPage: Record<string, unknown> = {
      '0': { hits: [{ t: 'a' }, { t: 'b' }] },
      '1': { hits: [{ t: 'c' }] },
      '2': { hits: [] }, // empty → natural end
    }
    const deps = {
      fetchInPage: async (req: ResolvedFetch) => {
        const p = new URL('https://x' + req.url).searchParams.get('page') ?? ''
        seen.push(p)
        return byPage[p]
      },
    }
    const out = await interpret(incrementRecipe(10), deps, { q: 'x' })
    expect(seen).toEqual(['0', '1', '2'])
    expect(out.pages).toBe(3)
    expect(out.items.map((i) => i.title)).toEqual(['a', 'b', 'c'])
  })

  it('honors a custom step (offset-style)', async () => {
    const seen: string[] = []
    const deps = {
      fetchInPage: async (req: ResolvedFetch) => {
        const p = new URL('https://x' + req.url).searchParams.get('page') ?? ''
        seen.push(p)
        return { hits: p === '40' ? [] : [{ t: p }] }
      },
    }
    const out = await interpret(incrementRecipe(10, 20), deps, { q: 'x' })
    expect(seen).toEqual(['0', '20', '40'])
    expect(out.items.map((i) => i.title)).toEqual(['0', '20'])
  })

  it('stops at maxPages', async () => {
    const deps = { fetchInPage: async () => ({ hits: [{ t: 'x' }] }) } // never empties
    const out = await interpret(incrementRecipe(3), deps, { q: 'x' })
    expect(out.pages).toBe(3)
    expect(out.items).toHaveLength(3)
  })

  it('keeps earlier pages when a later page drifts (the xueqiu login-wall case)', async () => {
    // xueqiu shape: page 1 (index 0) is anonymously readable; page 2 (index 1) is a
    // login-wall whose body omits the `hits` array → assert drift. The 20-item first page
    // must be harvested, not thrown away because pagination reached the wall.
    const byPage: Record<string, unknown> = {
      '0': { hits: [{ t: 'a' }, { t: 'b' }] },
      '1': { error_code: 10022, needLogin: true }, // login-wall: no `hits` array
    }
    const deps = {
      fetchInPage: async (req: ResolvedFetch) => {
        const p = new URL('https://x' + req.url).searchParams.get('page') ?? ''
        return byPage[p]
      },
    }
    const out = await interpret(incrementRecipe(5), deps, { q: 'x' })
    expect(out.items.map((i) => i.title)).toEqual(['a', 'b'])
    expect(out.pages).toBe(2)
  })

  it('still throws when the FIRST page drifts (a genuinely dead / login-gated source)', async () => {
    const deps = { fetchInPage: async () => ({ error_code: 10022 }) } // page 0 has no `hits`
    await expect(interpret(incrementRecipe(5), deps, { q: 'x' }))
      .rejects.toBeInstanceOf(ReplayDriftError)
  })
})

describe('interpret — xhs fixture end-to-end', () => {
  it('drives the fixture recipe across its two pages and maps every field', async () => {
    const deps = {
      fetchInPage: async (req: ResolvedFetch) => {
        const c = new URL('https://x' + req.url).searchParams.get('cursor') ?? ''
        const page = XHS_FEED_PAGES[c]
        if (page === undefined) throw new Error(`fixture has no page for cursor "${c}"`)
        return page
      },
    }
    const out = await interpret(XHS_FEED_RECIPE, deps, { keyword: '露营' })
    expect(out.pages).toBe(2)               // stops when has_more=false on page 2
    expect(out.items).toHaveLength(3)
    expect(out.items[0]).toEqual({ title: 'a1', url: 'https://www.xiaohongshu.com/explore/a1', author: 'user-a1', like_count: 42 })
  })
})

describe('interpretObject', () => {
  const probe = (over: Partial<HttpRecipe> = {}): HttpRecipe => ({
    version: 1, kind: 'http', sourceId: 'probe', output: 'object',
    request: { url: 'https://x.com/a?id={id}', method: 'GET' },
    assert: [{ path: 'validity', desc: 'verdict has validity' }],
    ...over,
  })

  it('返回 fetchInPage（即 decode）的对象原样，参数默认值照 params_schema 填', async () => {
    let seenUrl = ''
    const out = await interpretObject(
      probe({ meta: { params_schema: { id: { type: 'string', required: true }, passcode: { type: 'string', default: '' } } } }),
      { fetchInPage: async (req) => { seenUrl = req.url; return { validity: 'alive', files: [] } } },
      { id: 'X1' },
    )
    expect(out).toEqual({ validity: 'alive', files: [] })
    expect(seenUrl).toBe('https://x.com/a?id=X1')
  })

  it('null = decline，跳过 assert', async () => {
    const out = await interpretObject(probe(), { fetchInPage: async () => null }, { id: 'X1' })
    expect(out).toBeNull()
  })

  it('assert 落空抛 ReplayDriftError（page 0）', async () => {
    await expect(interpretObject(probe(), { fetchInPage: async () => ({ nope: 1 }) }, { id: 'X1' }))
      .rejects.toThrow(ReplayDriftError)
  })
})
