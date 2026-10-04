import { describe, expect, it } from 'vitest'
import { interpretHtml } from './interpret-html.ts'
import { ReplayDriftError, ReplayThrottledError } from './interpret.ts'
import type { HtmlRecipe } from './recipe.ts'

const PAGES: Record<string, string> = {
  'https://s.com/list-1.htm': `<ul>
    <li class="row"><a href="/t/1">First</a></li>
    <li class="row"><a href="/t/2">Second</a></li>
  </ul>`,
  'https://s.com/list-2.htm': `<ul></ul>`,
  'https://s.com/t/1': `<div id="m">magnet:one</div>`,
  'https://s.com/t/2': `<div id="m">magnet:two</div>`,
}

function recipe(over: Partial<HtmlRecipe> = {}): HtmlRecipe {
  return {
    version: 1,
    kind: 'html',
    sourceId: 'test',
    request: { url: 'https://s.com/list-{page}.htm', method: 'GET' },
    list: {
      selector: 'li.row',
      limit: 10,
      fields: {
        title: { selector: 'a', text: true },
        link: { selector: 'a', attr: 'href', resolve: true },
      },
    },
    detail: { urlFrom: 'link', fields: { enclosure_url: { selector: '#m', text: true } } },
    pagination: { mode: 'increment', param: 'page', start: 1, step: 1, maxPages: 3 },
    assert: [{ selector: 'li.row', desc: 'list has rows' }],
    ...over,
  }
}

const fetchHtml = async (req: { url: string }) => {
  const html = PAGES[req.url]
  if (html == null) throw new Error(`no fixture for ${req.url}`)
  return html
}

describe('interpretHtml', () => {
  it('maps list rows and hydrates each from its detail page', async () => {
    const { items, pages } = await interpretHtml(recipe(), { fetchHtml })
    expect(items.length).toBe(2)
    expect(items[0]).toMatchObject({ title: 'First', link: 'https://s.com/t/1', enclosure_url: 'magnet:one' })
    expect(items[1]).toMatchObject({ title: 'Second', enclosure_url: 'magnet:two' })
    // page 1 (list-1, 2 rows) then page 2 (list-2, empty → stop).
    expect(pages).toBe(2)
  })

  it('honors list.limit', async () => {
    const { items } = await interpretHtml(recipe({ list: { selector: 'li.row', limit: 1, fields: { title: { selector: 'a', text: true } } }, detail: undefined }), { fetchHtml })
    expect(items.length).toBe(1)
  })

  it('drifts when the assert selector matches nothing on page 0（等一下重取一次仍空才算）', async () => {
    let fetches = 0
    let slept = 0
    await expect(
      interpretHtml(
        recipe({ assert: [{ selector: '.absent', desc: 'missing marker' }] }),
        { fetchHtml: async (req) => { fetches++; return fetchHtml(req) }, sleep: async () => { slept++ } },
      ),
    ).rejects.toBeInstanceOf(ReplayDriftError)
    expect(fetches).toBe(2)
    expect(slept).toBe(1)
  })

  it('**第 0 页先回空壳、重取就有** —— 限流的常态，不算漂移', async () => {
    let calls = 0
    const flaky = async (req: { url: string }) => {
      if (req.url === 'https://s.com/list-1.htm' && calls++ === 0) return '<div class="chrome">页眉页脚都在，就是没有行</div>'
      return fetchHtml(req)
    }
    const r = await interpretHtml(recipe({ pagination: { mode: 'increment', param: 'page', start: 1, step: 1, maxPages: 1 } }), { fetchHtml: flaky, sleep: async () => {} })
    expect(r.items).toHaveLength(2)
    expect(calls).toBe(2)
  })

  // 翻过界（maxPages 比这一档真实页数大）是增量分页的常态，站点通常回 404。
  // 活体撞到过：ZOL 2000 档只有 2 页而 recipe 写 maxPages:3，第 3 页 404 把**整轮**清空，
  // 前两页真抓到的 48 行一起丢，调用方只看到「这个源今天没有内容」。
  it('后续页取不到 = 翻过界了：保住已抓的页正常收尾', async () => {
    const only2Pages = async (req: { url: string }) => {
      if (req.url === 'https://s.com/list-2.htm') throw new Error('HTTP 404')
      const html = PAGES[req.url]
      if (html == null) throw new Error(`no fixture for ${req.url}`)
      return html
    }
    const { items, pages } = await interpretHtml(recipe(), { fetchHtml: only2Pages })
    expect(items.length).toBe(2)
    expect(pages).toBe(1)
  })

  it('**第 0 页取不到就是源坏了**——照抛，不许当成翻过界静默交空清单', async () => {
    const dead = async () => {
      throw new Error('HTTP 404')
    }
    await expect(interpretHtml(recipe(), { fetchHtml: dead })).rejects.toThrow(/404/)
  })

  it('skips detail hydration when urlFrom field is absent', async () => {
    const { items } = await interpretHtml(
      recipe({ list: { selector: 'li.row', fields: { title: { selector: 'a', text: true } } } }),
      { fetchHtml },
    )
    // no `link` field extracted → detail is skipped, no fixture miss thrown
    expect(items.length).toBe(2)
    expect(items[0].enclosure_url).toBeUndefined()
  })

  it('HtmlField.extract slices the value; a miss drops the field', async () => {
    const { items } = await interpretHtml(recipe({
      detail: undefined,
      list: {
        selector: 'li.row',
        fields: {
          tid: { selector: 'a', attr: 'href', extract: '/t/(\\d+)' },
          missing: { selector: 'a', attr: 'href', extract: '^magnet:' },
        },
      },
    }), { fetchHtml })
    expect(items[0].tid).toBe('1')
    expect(items[0].missing).toBeUndefined()
  })
})

describe('interpretHtml hops', () => {
  const HOP_PAGES: Record<string, string> = {
    ...PAGES,
    // one JSON endpoint per detail row, keyed by an id the list page carries
    'https://api.example/claims/1': JSON.stringify({ claims: { P345: [{ mainsnak: { datavalue: { value: 'tt0000001' } } }] } }),
    'https://api.example/claims/2': 'not json at all',
    // a second (chained) hop whose URL is built from the FIRST hop's field
    'https://api.example/by-imdb/tt0000001': JSON.stringify({ tmdb: 42 }),
    // an html hop
    'https://mirror.example/t/1': '<span class="rating">9.1</span>',
  }
  const hopFetch = async (req: { url: string }) => {
    const body = HOP_PAGES[req.url]
    if (body == null) throw new Error(`no fixture for ${req.url}`)
    return body
  }
  const baseList = {
    selector: 'li.row',
    fields: {
      title: { selector: 'a', text: true },
      link: { selector: 'a', attr: 'href', resolve: true },
      tid: { selector: 'a', attr: 'href', extract: '/t/(\\d+)' },
    },
  }

  it('a json hop templates its URL from row fields, reads dot-paths, guards shapes', async () => {
    const { items } = await interpretHtml(recipe({
      detail: undefined,
      list: baseList,
      hops: [{
        url: 'https://api.example/claims/{tid}',
        parse: 'json',
        fields: {
          imdb: { path: 'claims.P345.0.mainsnak.datavalue.value', extract: '^tt\\d+$' },
          junk: { path: 'claims.P345.0.mainsnak.datavalue.value', extract: '^\\d+$' },
        },
      }],
    }), { fetchHtml: hopFetch })
    expect(items[0].imdb).toBe('tt0000001')
    expect(items[0].junk).toBeUndefined()
    // row 2's endpoint returns unparsable JSON → tolerated, fields just unset
    expect(items[1].imdb).toBeUndefined()
    expect(items[1].title).toBe('Second')
  })

  it('hops chain: a later hop builds its URL from an earlier hop’s field', async () => {
    const { items } = await interpretHtml(recipe({
      detail: undefined,
      list: baseList,
      hops: [
        { url: 'https://api.example/claims/{tid}', parse: 'json', fields: { imdb: { path: 'claims.P345.0.mainsnak.datavalue.value' } } },
        { url: 'https://api.example/by-imdb/{imdb}', parse: 'json', fields: { tmdb: { path: 'tmdb' } } },
      ],
    }), { fetchHtml: hopFetch })
    expect(items[0].tmdb).toBe('42') // numbers are String()-ed — recipe fields are strings
    // row 2 never got `imdb` → the chained hop's hole stays unfilled → hop skipped, row kept
    expect(items[1].tmdb).toBeUndefined()
  })

  it('an html hop extracts via selectors, and urlFrom takes a field verbatim', async () => {
    const pages: Record<string, string> = { ...HOP_PAGES, 'https://s.com/t/1': HOP_PAGES['https://mirror.example/t/1'], 'https://s.com/t/2': '<div>no rating</div>' }
    const { items } = await interpretHtml(recipe({
      detail: undefined,
      list: baseList,
      hops: [{ urlFrom: 'link', fields: { rating: { selector: '.rating', text: true } } }],
    }), { fetchHtml: async (req) => pages[req.url] ?? '' })
    expect(items[0].rating).toBe('9.1')
    expect(items[1].rating).toBeUndefined()
  })

  it('a hop fetch failure never takes the row down', async () => {
    const { items } = await interpretHtml(recipe({
      detail: undefined,
      list: baseList,
      hops: [{ url: 'https://down.example/{tid}', parse: 'json', fields: { x: { path: 'x' } } }],
    }), { fetchHtml: hopFetch })
    expect(items.length).toBe(2)
    expect(items[0].x).toBeUndefined()
  })

  it('legacy detail recipes are untouched: hops run after detail and see its fields', async () => {
    const pages: Record<string, string> = { ...HOP_PAGES, 'https://api.example/m/magnet:one': JSON.stringify({ ok: 'yes' }) }
    const { items } = await interpretHtml(recipe({
      hops: [{ url: 'https://api.example/m/{enclosure_url}', parse: 'json', fields: { verified: { path: 'ok' } } }],
    }), { fetchHtml: async (req) => { const b = pages[req.url]; if (b == null) throw new Error('miss'); return b } })
    expect(items[0]).toMatchObject({ enclosure_url: 'magnet:one', verified: 'yes' })
    expect(items[1].verified).toBeUndefined() // magnet:two's endpoint missing → tolerated
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 限流 ≠ 改版。两者的响应完全一样（200 + assert 落空），唯一分得开的是「外壳还在不在」。
// 活体 2026-09-04：发现循环连着验 31 个候选（每个 2 页 = 62 趟），慢慢买开始回空壳页，
// 三次 assert 落空 → manmanbuy-search 进隔离 → 此后 price_search 对**所有**查询静默返回
// 0 行(连 iPhone 17 都查不到)，而站点在浏览器里完全正常、裸 curl 也拿得到 31 行。
// 判成 drift 的代价就是这个：把一份完好的 recipe 关进隔离，且没有一处说得出为什么。
// ─────────────────────────────────────────────────────────────────────────────
describe('空壳页 = 限流，不是漂移', () => {
  const SHELL = '<header class="HeaderPC_mainHeader__x1"></header><footer class="FooterPC_footerBox__y2"></footer>'
  const shellOnly = async () => `<html><body>${SHELL}<ul></ul></body></html>`
  const gutted = async () => '<html><body><div>404 Not Found</div></body></html>'
  const withShell = (over: Partial<HtmlRecipe> = {}) =>
    recipe({ shell: '[class*="HeaderPC_mainHeader__"], [class*="FooterPC_footerBox__"]', detail: undefined, ...over })

  it('外壳还在、列表行没了 → ReplayThrottledError（瞬时，调用方据此 DECLINE、不记漂移）', async () => {
    await expect(
      interpretHtml(withShell(), { fetchHtml: shellOnly, sleep: async () => {} }),
    ).rejects.toThrow(ReplayThrottledError)
  })

  it('外壳也没了 → 仍然是 ReplayDriftError（真改版，该进隔离该修）', async () => {
    await expect(
      interpretHtml(withShell(), { fetchHtml: gutted, sleep: async () => {} }),
    ).rejects.toThrow(ReplayDriftError)
  })

  // 没申报 shell 的 recipe 行为一个字都不能变——这条改动对它们必须是透明的。
  it('recipe 没给 shell → 一律记漂移（旧行为原样保留）', async () => {
    await expect(
      interpretHtml(recipe({ detail: undefined }), { fetchHtml: shellOnly, sleep: async () => {} }),
    ).rejects.toThrow(ReplayDriftError)
  })

  // 重取那一次仍然先跑：空壳是瞬时的,隔一秒多半就有了。抛限流是**重取也没救回来**之后的事。
  it('重取救回来了就正常出数,不抛任何错', async () => {
    let n = 0
    const flaky = async (req: { url: string }) => {
      n++
      return n === 1 ? `<html><body>${SHELL}<ul></ul></body></html>` : (PAGES[req.url] ?? '<ul></ul>')
    }
    const { items } = await interpretHtml(
      withShell({ pagination: { mode: 'increment', param: 'page', start: 1, step: 1, maxPages: 1 } }),
      { fetchHtml: flaky, sleep: async () => {} },
    )
    expect(items).toHaveLength(2)
  })
})
