import { describe, it, expect } from 'vitest'
import { buildInPageFetch, runFetchRecipe, type ReplayPage, type ReplayLauncher } from './browser-fetch.ts'
import { ReplayDriftError } from './interpret.ts'
import type { ResolvedFetch } from './interpret.ts'
import type { FetchRecipe } from './recipe.ts'

/** A fake page: ignores the evaluate fn, returns a canned {status, text}. */
function fakePage(status: number, text: string, sink?: ResolvedFetch[]): ReplayPage {
  return {
    async evaluate(_fn, arg) {
      sink?.push(arg)
      return { status, text } as never
    },
  }
}

describe('buildInPageFetch', () => {
  it('returns the parsed JSON body and forwards the request', async () => {
    const sink: ResolvedFetch[] = []
    const fetchInPage = buildInPageFetch(fakePage(200, '{"data":{"items":[1,2]}}', sink))
    const body = await fetchInPage({ url: '/api?x=1', method: 'GET', headers: { a: 'b' } })
    expect(body).toEqual({ data: { items: [1, 2] } })
    expect(sink[0]).toEqual({ url: '/api?x=1', method: 'GET', headers: { a: 'b' } })
  })

  it('throws ReplayDriftError on non-JSON (login-wall / block)', async () => {
    const fetchInPage = buildInPageFetch(fakePage(403, '<html>login</html>'))
    await expect(fetchInPage({ url: '/api', method: 'GET', headers: {} }))
      .rejects.toBeInstanceOf(ReplayDriftError)
  })
})

function hnRecipe(): FetchRecipe {
  return {
    version: 1, kind: 'fetch', sourceId: 'hn', cookieDomain: '',
    entryUrl: 'https://hn.algolia.com/',
    request: { url: 'https://hn.algolia.com/api/v1/search?query={query}', method: 'GET' },
    pagination: { mode: 'cursor', itemsAt: 'hits', cursorFrom: '', cursorParam: 'cursor', maxPages: 1 },
    assert: [{ path: 'hits', desc: 'no hits array' }],
    mapping: { title: 'title', url: 'url' },
  }
}

describe('runFetchRecipe', () => {
  it('launches, interprets, maps, and always closes', async () => {
    let closed = false
    let sawEntry = ''
    const launcher: ReplayLauncher = {
      async launch(entryUrl) {
        sawEntry = entryUrl
        const page: ReplayPage = {
          async evaluate() {
            return { status: 200, text: '{"hits":[{"title":"A","url":"http://a"}]}' } as never
          },
        }
        return { page, close: async () => { closed = true } }
      },
    }
    const items = await runFetchRecipe(hnRecipe(), { query: 'x' }, launcher)
    expect(sawEntry).toBe('https://hn.algolia.com/')
    expect(items).toEqual([{ title: 'A', url: 'http://a' }])
    expect(closed).toBe(true)
  })

  it('binds run params into a templated entryUrl (xueqiu /u/{id})', async () => {
    let sawEntry = ''
    const recipe: FetchRecipe = { ...hnRecipe(), entryUrl: 'https://xueqiu.com/u/{id}' }
    const launcher: ReplayLauncher = {
      async launch(entryUrl) {
        sawEntry = entryUrl
        const page: ReplayPage = {
          async evaluate() { return { status: 200, text: '{"hits":[]}' } as never },
        }
        return { page, close: async () => {} }
      },
    }
    await runFetchRecipe(recipe, { id: '1247347556', query: 'x' }, launcher)
    expect(sawEntry).toBe('https://xueqiu.com/u/1247347556')
  })

  it('closes even when interpretation throws', async () => {
    let closed = false
    const launcher: ReplayLauncher = {
      async launch() {
        const page: ReplayPage = { async evaluate() { return { status: 200, text: '{}' } as never } } // no hits → assert drift
        return { page, close: async () => { closed = true } }
      },
    }
    await expect(runFetchRecipe(hnRecipe(), { query: 'x' }, launcher)).rejects.toThrow()
    expect(closed).toBe(true)
  })
})
