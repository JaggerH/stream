import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { makeHttpFetch } from './http-fetch.ts'
import type { HttpRecipe } from './recipe.ts'

/**
 * The compute hook end-to-end over a mock transport, modelled on zuna: engine prefetches
 * key+ip (I/O), sandbox signs the request (HMAC) and decrypts the response (AES) — all with
 * the site's OWN scheme, no browser. Deterministic: a fake fetch stands in for the network.
 */

const SECRET = 'a09d0f3700a279584e1515354fbe08a7ee1c617f919543142fa625b82f1b5ad0'
const KEY = crypto.randomBytes(32).toString('base64')

/** Build the AES-GCM envelope zuna returns, so decode has something real to decrypt. */
function envelope(payload: unknown): Record<string, unknown> {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64'), iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return {
    enc: 1, alg: 'AES-256-GCM',
    iv: iv.toString('base64'), ciphertext: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
  }
}

const recipe: HttpRecipe = {
  version: 1,
  kind: 'http',
  sourceId: 'zuna-search',
  request: { url: 'https://music.znnu.com/api/search', method: 'POST' },
  compute: {
    capabilities: ['hmacSha256', 'aesGcmDecrypt'],
    prefetch: [
      { as: 'keyResp', request: { url: 'https://music.znnu.com/api/key', method: 'GET' } },
      { as: 'ipResp', request: { url: 'https://music.znnu.com/api/ip', method: 'GET' } },
    ],
    // input = { params, pre:{keyResp,ipResp}, now }; returns fields merged into the request
    sign: `(() => {
      const p = { act: 'search', keyword: input.params.keyword, ip: input.pre.ipResp.ip };
      let s = input.now + 'music.znnu.com';
      for (const k of Object.keys(p).sort()) s += k + '=' + p[k];
      const signature = hmacSha256('${SECRET}', s);
      const enc = (o) => Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
      return {
        body: enc({ ...p, signature, timestamp: String(input.now), domain: 'music.znnu.com' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Key-Token': input.pre.keyResp.data.keyToken },
      };
    })()`,
    // input = { body, pre }; returns the decoded object the mapping then reads
    decode: `(() => {
      const d = input.body.data;
      if (!d || d.enc !== 1) return input.body;
      return JSON.parse(aesGcmDecrypt({ key: input.pre.keyResp.data.key, iv: d.iv, ciphertext: d.ciphertext, tag: d.tag }));
    })()`,
  },
  pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'songs', maxPages: 1 },
  assert: [{ path: 'songs', desc: 'decrypted payload has songs[]' }],
  mapping: { title: 'name', author: 'artists', guid: 'id' },
}

describe('http recipe with compute hook (zuna-shaped)', () => {
  it('prefetches, signs, sends, decrypts — yielding mapped items', async () => {
    const seen: { url: string; body?: string; keyToken?: string }[] = []
    const fakeFetch = (async (u: URL | string, init: RequestInit = {}) => {
      const url = String(u)
      if (url.endsWith('/api/key')) return new Response(JSON.stringify({ data: { key: KEY, keyToken: 'TK-123' } }))
      if (url.endsWith('/api/ip')) return new Response(JSON.stringify({ ip: '1.2.3.4' }))
      // the signed main POST
      seen.push({ url, body: init.body as string, keyToken: (init.headers as Record<string, string>)?.['X-Key-Token'] })
      return new Response(JSON.stringify({ code: 200, data: envelope({ songs: [{ id: 42, name: '屋顶', artists: '周杰伦' }] }) }))
    }) as unknown as typeof fetch

    // interpret drives makeHttpFetch; call the fetchInPage the way interpret would (via runHttp).
    const { interpret } = await import('./interpret.ts')
    const { items } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe, undefined, fakeFetch, () => 1784177905) },
      { keyword: '周杰伦' },
    )

    // sandbox signed with the site's own scheme and the token header rode along
    expect(seen).toHaveLength(1)
    expect(seen[0].keyToken).toBe('TK-123')
    expect(seen[0].body).toContain('signature=')
    expect(seen[0].body).toContain('keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6')

    // response decrypted and mapped
    expect(items).toEqual([{ title: '屋顶', author: '周杰伦', guid: 42 }])
  })

  // A `default` in params_schema used to be decoration: an omitted optional param sent the
  // LITERAL `{passcode}` upstream, and the site answered with a generic error naming nothing.
  it('fills an omitted param from its declared default, in prefetch and request alike', async () => {
    const seen: string[] = []
    const withDefault: HttpRecipe = {
      version: 1, kind: 'http', sourceId: 'defaulted',
      request: { url: 'https://x.test/detail?code={passcode}', method: 'GET' },
      compute: {
        capabilities: [],
        prefetch: [{ as: 'tok', request: { url: 'https://x.test/token', method: 'POST', body: '{"passcode":"{passcode}"}' } }],
        sign: `(() => ({ url: 'https://x.test/detail?t=' + input.pre.tok.stoken }))()`,
      },
      pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'list', maxPages: 1 },
      assert: [{ path: 'list', desc: 'list' }],
      mapping: { guid: 'fid' },
      meta: { params_schema: { passcode: { type: 'string', required: false, default: '' } } },
    }
    const fakeFetch = (async (u: URL | string, init?: RequestInit) => {
      if (String(u).includes('/token')) {
        seen.push(String(init?.body))
        return new Response(JSON.stringify({ stoken: 'ST' }))
      }
      return new Response(JSON.stringify({ list: [{ fid: 'f1' }] }))
    }) as unknown as typeof fetch

    const { interpret } = await import('./interpret.ts')
    const { items } = await interpret(withDefault, { fetchInPage: makeHttpFetch(withDefault, undefined, fakeFetch) }, { })
    expect(seen).toEqual(['{"passcode":""}']) // the default, not the literal hole
    expect(items).toEqual([{ guid: 'f1' }])
  })

  it('a supplied param still beats its declared default', async () => {
    const seen: string[] = []
    const r: HttpRecipe = {
      version: 1, kind: 'http', sourceId: 'defaulted2',
      request: { url: 'https://x.test/detail', method: 'GET' },
      compute: {
        capabilities: [],
        prefetch: [{ as: 'tok', request: { url: 'https://x.test/token', method: 'POST', body: '{"passcode":"{passcode}"}' } }],
        sign: `(() => ({ url: 'https://x.test/detail' }))()`,
      },
      pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'list', maxPages: 1 },
      assert: [{ path: 'list', desc: 'list' }],
      mapping: { guid: 'fid' },
      meta: { params_schema: { passcode: { type: 'string', default: '' } } },
    }
    const fakeFetch = (async (u: URL | string, init?: RequestInit) => {
      if (String(u).includes('/token')) { seen.push(String(init?.body)); return new Response(JSON.stringify({ stoken: 'ST' })) }
      return new Response(JSON.stringify({ list: [{ fid: 'f1' }] }))
    }) as unknown as typeof fetch
    const { interpret } = await import('./interpret.ts')
    await interpret(r, { fetchInPage: makeHttpFetch(r, undefined, fakeFetch) }, { passcode: 'x9y8' })
    expect(seen).toEqual(['{"passcode":"x9y8"}'])
  })

  // A prefetch that opens a per-target session (quark: pwd_id → stoken) is meaningless without
  // the target's own params. Sending `{pwd_id}` literally would just make upstream answer
  // "not found" with nothing saying why.
  it('templates {param} holes in a prefetch url and body, like the main request', async () => {
    const pre: { url: string; body?: string }[] = []
    const chained: HttpRecipe = {
      version: 1, kind: 'http', sourceId: 'chained',
      request: { url: 'https://x.test/detail?id={id}', method: 'GET' },
      compute: {
        capabilities: [],
        prefetch: [{ as: 'tok', request: { url: 'https://x.test/token?for={id}', method: 'POST', body: '{"id":"{id}"}' } }],
        // thread the prefetched token into the real request — no crypto, just chaining
        sign: `(() => ({ url: 'https://x.test/detail?id=' + input.params.id + '&t=' + input.pre.tok.stoken }))()`,
      },
      pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'list', maxPages: 1 },
      assert: [{ path: 'list', desc: 'list' }],
      mapping: { guid: 'fid' },
    }
    let mainUrl = ''
    const fakeFetch = (async (u: URL | string, init: RequestInit = {}) => {
      const url = String(u)
      if (url.includes('/token')) {
        pre.push({ url, body: init.body as string })
        return new Response(JSON.stringify({ stoken: 'ST-9' }))
      }
      mainUrl = url
      return new Response(JSON.stringify({ list: [{ fid: 'f1' }] }))
    }) as unknown as typeof fetch

    const { interpret } = await import('./interpret.ts')
    const { items } = await interpret(chained, { fetchInPage: makeHttpFetch(chained, undefined, fakeFetch) }, { id: 'abc123' })

    expect(pre).toEqual([{ url: 'https://x.test/token?for=abc123', body: '{"id":"abc123"}' }])
    expect(mainUrl).toBe('https://x.test/detail?id=abc123&t=ST-9')
    expect(items).toEqual([{ guid: 'f1' }])
  })

  it('memoizes the prefetch per param set — one run never reuses another target session', async () => {
    let tokens = 0
    const recipeB: HttpRecipe = {
      version: 1, kind: 'http', sourceId: 'memo',
      request: { url: 'https://x.test/detail?id={id}', method: 'GET' },
      compute: {
        capabilities: [],
        prefetch: [{ as: 'tok', request: { url: 'https://x.test/token?for={id}', method: 'GET' } }],
        sign: `(() => ({ url: 'https://x.test/detail?t=' + input.pre.tok.stoken }))()`,
      },
      pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'list', maxPages: 1 },
      assert: [{ path: 'list', desc: 'list' }],
      mapping: { guid: 'fid' },
    }
    const fakeFetch = (async (u: URL | string) => {
      const url = String(u)
      if (url.includes('/token')) {
        tokens++
        return new Response(JSON.stringify({ stoken: `ST-${new URL(url).searchParams.get('for')}` }))
      }
      return new Response(JSON.stringify({ list: [{ fid: new URL(url).searchParams.get('t') }] }))
    }) as unknown as typeof fetch

    const fetchInPage = makeHttpFetch(recipeB, undefined, fakeFetch)
    const a = await fetchInPage({ url: 'https://x.test/detail?id=A', method: 'GET', headers: {}, params: { id: 'A' } })
    const b = await fetchInPage({ url: 'https://x.test/detail?id=B', method: 'GET', headers: {}, params: { id: 'B' } })
    const aAgain = await fetchInPage({ url: 'https://x.test/detail?id=A', method: 'GET', headers: {}, params: { id: 'A' } })

    // B must NOT inherit A's token; A's second page reuses A's (no third token call)
    expect((a as { list: { fid: string }[] }).list[0].fid).toBe('ST-A')
    expect((b as { list: { fid: string }[] }).list[0].fid).toBe('ST-B')
    expect((aAgain as { list: { fid: string }[] }).list[0].fid).toBe('ST-A')
    expect(tokens).toBe(2)
  })

  // A probe's verdict arrives IN the upstream error body (quark: 403 41031 封禁 / 404 41006 不存在).
  // Without the opt-in those are exceptions — indistinguishable from a real outage, which would
  // then read as "every link is dead".
  describe('acceptNonOk (probe archetype)', () => {
    const probe = (acceptNonOk?: boolean): HttpRecipe => ({
      version: 1, kind: 'http', sourceId: 'probe', acceptNonOk,
      request: { url: 'https://x.test/detail', method: 'GET' },
      compute: {
        capabilities: [],
        prefetch: [{ as: 'tok', request: { url: 'https://x.test/token', method: 'POST' } }],
        sign: `(() => ({ url: 'https://x.test/detail' }))()`,
        // the verdict lives in the prefetched error body, not in an exception
        decode: `(() => (input.pre.tok.code !== 0 ? { list: [] } : { list: input.body.list }))()`,
      },
      pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'list', maxPages: 1 },
      assert: [{ path: 'list', desc: 'list' }],
      mapping: { guid: 'fid' },
    })
    const deadFetch = (async (u: URL | string) =>
      String(u).includes('/token')
        ? new Response(JSON.stringify({ code: 41031, message: '分享者用户封禁' }), { status: 403 })
        : new Response(JSON.stringify({ list: [] }), { status: 400 })) as unknown as typeof fetch

    it('hands a non-2xx body to decode → the dead target is 0 items, not an exception', async () => {
      const { interpret } = await import('./interpret.ts')
      const r = probe(true)
      const { items } = await interpret(r, { fetchInPage: makeHttpFetch(r, undefined, deadFetch) }, {})
      expect(items).toEqual([])
    })

    it('without the opt-in a non-2xx still throws — a feed must never read a 500 as "no items"', async () => {
      const { interpret } = await import('./interpret.ts')
      const r = probe(false)
      await expect(interpret(r, { fetchInPage: makeHttpFetch(r, undefined, deadFetch) }, {})).rejects.toThrow(/403/)
    })
  })

  it('surfaces a decode failure as an error, not an empty feed', async () => {
    const fakeFetch = (async (u: URL | string) => {
      const url = String(u)
      if (url.endsWith('/api/key')) return new Response(JSON.stringify({ data: { key: KEY, keyToken: 'x' } }))
      if (url.endsWith('/api/ip')) return new Response(JSON.stringify({ ip: '1.2.3.4' }))
      // corrupt envelope → aesGcmDecrypt throws inside the sandbox → ComputeError
      return new Response(JSON.stringify({ code: 200, data: { enc: 1, alg: 'AES-256-GCM', iv: 'AA==', ciphertext: 'AA==', tag: 'AA==' } }))
    }) as unknown as typeof fetch

    const { interpret } = await import('./interpret.ts')
    await expect(interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe, undefined, fakeFetch, () => 1784177905) },
      { keyword: 'x' },
    )).rejects.toThrow()
  })
})
