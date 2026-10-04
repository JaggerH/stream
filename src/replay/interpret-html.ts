import { ReplayDriftError, ReplayThrottledError, getPath, substitute, type MappedItem } from './interpret.ts'
import { parseDoc, selectRows, extractFields, applyExtract } from './html-extract.ts'
import type { HtmlHop, HtmlRecipe } from './recipe.ts'

/** One page fetch → HTML text. The adapter injects a guarded host fetch (SSRF + cookie); tests
 *  inject fixtures. Detail-page fetches go through the same `fetchHtml`, so they are guarded too. */
export interface InterpretHtmlDeps {
  fetchHtml: (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => Promise<string>
  /** 第 0 页 assert 落空后重取前的等待。测试注入 no-op；不传就真等。 */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Run a kind:'html' recipe: page through the list URL, select rows, extract each row's fields,
 * optionally hydrate each from its detail page, and return mapped items. Mirrors `interpret`
 * (the JSON engine) — same increment-pagination shape and the SAME `ReplayDriftError`, so
 * health/quarantine/repair treat an HTML source that rots exactly like any other.
 */
/** 第 0 页空壳页重取前等多久。慢慢买实测 12 并发里 3 个空壳，串行隔 1 秒再取即有。 */
const RETRY_DELAY_MS = 1500

export async function interpretHtml(
  recipe: HtmlRecipe,
  deps: InterpretHtmlDeps,
  params: Record<string, string> = {},
): Promise<{ items: MappedItem[]; pages: number }> {
  const items: MappedItem[] = []
  const pg = recipe.pagination
  let pages = 0
  let value = pg.start

  const headersFor = (vars: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = {}
    for (const [k, v] of Object.entries(recipe.request.headers ?? {})) h[k] = substitute(v, vars)
    return h
  }

  for (let page = 0; page < pg.maxPages; page++) {
    const vars = { ...params, [pg.param]: String(value) }
    const pageUrl = substitute(recipe.request.url, vars)
    const listHeaders = headersFor(vars)
    // 取页失败的语义**按页号分两种**——和下面 assert 落空那条是同一条规则，只是它发生得更早：
    // 第 0 页取不到 = 这个源坏了/被挡了（响亮地抛）；后续页取不到 = **翻过界了**（增量分页
    // 迟早会走到不存在的那一页，站点回 404 是最常见的说法），保住已抓的页正常收尾。
    // 少了这一格的表现：`maxPages` 只要比某一档的真实页数大，**整轮清空**——前几页真抓到的
    // 行全被丢掉，调用方看到的是「这个源今天没有内容」。活体撞到过：ZOL 2000 档只有 2 页，
    // 而 recipe 写的是 maxPages:3，于是 48 行变 0 行，且没有一处说得出为什么。
    let html: string
    try {
      html = await deps.fetchHtml({ url: pageUrl, method: recipe.request.method, headers: listHeaders })
    } catch (e) {
      if (page > 0) return { items, pages }
      throw e
    }
    pages++
    let doc = parseDoc(html)

    // **第 0 页 assert 落空，等一下再取一次，只补一次。** 站点限流最常见的说法不是 429，是一张
    // 带着完整页眉页脚、只是没有列表行的空壳页（慢慢买实测：12 个并发里 3 个这样，200 OK）。
    // 它是瞬时的，隔一秒再取多半就有了；不补这一次，每撞一回就记一次漂移，三次就进隔离，
    // 之后这个源对所有请求静默 DECLINE——症状是「比价一行都没回」，没有一处说得出为什么。
    if (page === 0 && recipe.assert.some((a) => !doc.querySelector(a.selector))) {
      await (deps.sleep ?? ((ms) => new Promise<void>((r) => { setTimeout(r, ms) })))(RETRY_DELAY_MS)
      html = await deps.fetchHtml({ url: pageUrl, method: recipe.request.method, headers: listHeaders })
      doc = parseDoc(html)
    }

    // Assert list-page shape. A miss on page 0 is a broken/gated source (error → repair); on a
    // later page it is a pagination boundary (login wall / end of listings) — stop, keep pages.
    for (const a of recipe.assert) {
      if (!doc.querySelector(a.selector)) {
        if (page > 0) return { items, pages }
        // **限流和改版长得一模一样**（都是 200 + 没有列表行），只有"外壳还在不在"分得开。
        // 外壳还在 = 空壳页 = 这一趟被限流了，瞬时、和中继断线同一类，**绝不记漂移**——
        // 记了三次就把一份完好的 recipe 关进隔离，之后这个源对所有请求静默返回空。
        if (recipe.shell && doc.querySelector(recipe.shell)) throw new ReplayThrottledError(a.desc, page)
        throw new ReplayDriftError(a.desc, page)
      }
    }

    const rows = selectRows(doc, recipe.list.selector, recipe.list.limit)
    if (rows.length === 0) break // empty page = natural end of an increment listing

    for (const row of rows) {
      const fields: Record<string, string> = extractFields(row, recipe.list.fields, pageUrl)
      if (recipe.detail) {
        const detailUrl = fields[recipe.detail.urlFrom]
        if (typeof detailUrl === 'string' && detailUrl) {
          const detailHtml = await deps.fetchHtml({ url: detailUrl, method: 'GET', headers: listHeaders })
          Object.assign(fields, extractFields(parseDoc(detailHtml), recipe.detail.fields, detailUrl))
        }
      }
      for (const hop of recipe.hops ?? []) {
        Object.assign(fields, await runHop(hop, { ...vars, ...fields }, deps))
      }
      items.push(fields as MappedItem)
    }

    value += pg.step
  }

  return { items, pages }
}

/**
 * Run one hop for one row: build the URL from the fields gathered so far, fetch, extract.
 *
 * Tolerance is the contract, not a convenience: a hop is SUPPLEMENTARY evidence, so a fetch
 * failure, an unparsable body, or a missing URL field returns `{}` — those fields stay unset
 * and the row lives on. (The wikidata id-exchange this replaces had exactly this semantics:
 * any subset of the three properties failing still returned the ones it got.) The one thing
 * a hop failure must NOT do is take 400 otherwise-good rows down with it.
 */
async function runHop(
  hop: HtmlHop,
  vars: Record<string, string>,
  deps: InterpretHtmlDeps,
): Promise<Record<string, string>> {
  const url = hop.urlFrom ? vars[hop.urlFrom] : hop.url && substitute(hop.url, vars)
  // An unfilled {hole} means the evidence this hop follows does not exist for this row
  // (substitute leaves unknown holes literally in place) — skip, don't fetch a broken URL.
  if (!url || /\{\w+\}/.test(url)) return {}
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(hop.headers ?? {})) headers[k] = substitute(v, vars)
  try {
    const body = await deps.fetchHtml({ url, method: 'GET', headers })
    if (hop.parse !== 'json') return extractFields(parseDoc(body), hop.fields, url)
    const json = JSON.parse(body) as unknown
    const out: Record<string, string> = {}
    for (const [name, field] of Object.entries(hop.fields)) {
      const raw = getPath(json, field.path)
      if (typeof raw !== 'string' && typeof raw !== 'number') continue
      const value = field.extract ? applyExtract(String(raw), field.extract) : String(raw)
      if (value !== undefined) out[name] = value
    }
    return out
  } catch {
    return {}
  }
}
