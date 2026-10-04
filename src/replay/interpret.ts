import type { Recipe, FetchRecipe, HttpRecipe, RecipeFieldMap } from './recipe.ts'

/** Both recipe kinds the declarative engine runs: same request/pagination/assert/mapping,
 *  different transport. */
type DeclarativeRecipe = FetchRecipe | HttpRecipe

/** Dot-path lookup. Numeric segments index into arrays. Returns undefined on any miss.
 *  The empty path is identity (the object itself) — so a recipe whose upstream returns a
 *  bare root array (e.g. HF `/api/spaces`) can point `itemsAt: ""` at it. */
export function getPath(obj: unknown, path: string): unknown {
  if (path === '') return obj
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** Replace every {name} with vars[name]; unknown holes are left literally in place. */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? vars[name] : whole,
  )
}

export interface ResolvedFetch {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  /** the resolved param map for this page (base params + pagination cursor) — the compute
   *  sign hook reads it to build a signature over the real request parameters. */
  params?: Record<string, string>
  /** redirect policy carried through from RecipeRequest (default 'follow'). */
  redirect?: 'follow' | 'manual'
}

export type MappedItem = Record<string, unknown>

export interface InterpretDeps {
  fetchInPage: (req: ResolvedFetch) => Promise<unknown>
}

export class ReplayDriftError extends Error {
  constructor(readonly assertDesc: string, readonly page: number) {
    super(`replay drift on page ${page}: ${assertDesc}`)
    this.name = 'ReplayDriftError'
  }
}

/**
 * 「这一趟被限流了」，**不是** recipe 坏了。和中继断线、队列超时同一类：瞬时、下一趟可能就好，
 * 所以 **绝不记漂移**（记了三次就把一份完好的 recipe 关进隔离）。
 *
 * 为什么需要单独一个类：站点限流最常见的说法不是 429，是一张**带着完整页眉页脚、只是没有
 * 列表行的空壳页**（200 OK）——它和"站点改版、选择器全失效"在响应码上一模一样，只能靠
 * 「外壳还在不在」分辨。活体 2026-09-04：发现循环第 3 轮连着验 31 个候选（每个 2 页 = 62 趟），
 * 慢慢买开始回空壳，三次 assert 落空 → `manmanbuy-search` 于 16:18:19 进隔离 → 此后
 * `price_search` 对**所有**查询静默返回 0 行。同一轮几十秒后的比价阶段 6 个品牌全部
 * `no_price`，而站点在浏览器里一切正常、裸 curl 也照样拿得到 31 行。
 * **是我们自己把比价源打进了隔离，而没有一处说得出为什么。**
 */
export class ReplayThrottledError extends Error {
  constructor(readonly assertDesc: string, readonly page: number) {
    super(`replay throttled on page ${page} (shell present, rows absent): ${assertDesc}`)
    this.name = 'ReplayThrottledError'
  }
}

/** The `default`s a recipe's params_schema declares, as a flat var map. A schema entry is
 *  `{type, required, default, description}`; entries without a `default` contribute nothing. */
function paramDefaults(schema: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, spec] of Object.entries(schema ?? {})) {
    const value = (spec as { default?: unknown } | null)?.default
    if (value != null) out[name] = String(value)
  }
  return out
}

function resolveFetch(recipe: DeclarativeRecipe, vars: Record<string, string>): ResolvedFetch {
  const { request } = recipe
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(request.headers ?? {})) headers[k] = substitute(v, vars)
  return {
    url: substitute(request.url, vars),
    method: request.method,
    headers,
    body: request.body != null ? substitute(request.body, vars) : undefined,
    params: vars,
    redirect: request.redirect,
  }
}

/**
 * Fill `{a.b.c}` holes in a template from the RAW item's own dot-paths (missing → '').
 * Symmetric with `substitute` (which fills from a flat vars map) but resolves nested
 * paths, so a mapping can compose a value the source splits across fields — e.g. an
 * item link `.../item/{id}?sig={signature}` built from two feed fields.
 */
function renderTemplate(raw: unknown, tpl: string): string {
  return tpl.replace(/\{([^{}]+)\}/g, (_whole, path: string) => {
    const v = getPath(raw, path.trim())
    return v == null ? '' : String(v)
  })
}

export function mapItem(raw: unknown, mapping: RecipeFieldMap): MappedItem {
  const out: MappedItem = {}
  // A mapping value is a plain dot-path (the common case) UNLESS it contains a `{…}`
  // hole, in which case it is a template composed from the raw item's paths. Dot-paths
  // never contain braces, so this is backward-compatible with every existing recipe.
  // A leading `=` makes the rest a LITERAL (`"author": "=转转回收"`): a constant the response
  // does not carry — the platform name of a single-platform feed is the usual case. Without
  // it a bare constant is read as a dot-path, resolves to undefined and the field is silently
  // absent (bit us: a recycle-price row with no platform name in the purchase receipt).
  for (const [field, spec] of Object.entries(mapping)) {
    out[field] = spec.startsWith('=') ? spec.slice(1) : spec.includes('{') ? renderTemplate(raw, spec) : getPath(raw, spec)
  }
  return out
}

/** Assert the response shape; throw drift on any missing assert path. */
function checkAsserts(recipe: DeclarativeRecipe, resp: unknown, page: number): void {
  for (const a of recipe.assert) {
    if (getPath(resp, a.path) == null) throw new ReplayDriftError(a.desc, page)
  }
}

/** Pull the item array at pagination.itemsAt; drift if it is not an array. */
function extractItems(itemsAt: string, resp: unknown, page: number): unknown[] {
  const raw = getPath(resp, itemsAt)
  if (!Array.isArray(raw)) {
    throw new ReplayDriftError(`items path "${itemsAt}" is not an array`, page)
  }
  return raw
}

/** Drift on a page AFTER at least one page succeeded (page > 0) is a pagination boundary —
 *  a login-wall / rate-limit / end-of-feed reached past the anonymously-readable window —
 *  not a dead source. The caller treats it as a natural stop and keeps the pages already
 *  harvested. Only a first-page (page 0) drift means the source itself is broken/gated and
 *  must surface as an error (health + repair). */
function isBoundaryDrift(e: unknown, page: number): boolean {
  return e instanceof ReplayDriftError && page > 0
}

/**
 * Object-output twin of interpret(): one resolved request, asserts, and the response —
 * i.e. decode's return value — handed back verbatim. No pagination, no mapping: a probe
 * answers a question, it does not produce a feed. `null` is the recipe's own decline and
 * short-circuits the asserts (there is no shape to guard on a non-answer).
 */
export async function interpretObject(
  recipe: HttpRecipe,
  deps: InterpretDeps,
  callParams: Record<string, string> = {},
): Promise<unknown> {
  const params = { ...paramDefaults(recipe.meta?.params_schema), ...callParams }
  const resp = await deps.fetchInPage(resolveFetch(recipe, params))
  if (resp == null) return null
  checkAsserts(recipe, resp, 0)
  return resp
}

export async function interpret(
  recipe: Recipe,
  deps: InterpretDeps,
  callParams: Record<string, string> = {},
): Promise<{ items: MappedItem[]; pages: number }> {
  // 'fetch' and 'http' differ ONLY in who sends the bytes — which is deps.fetchInPage's
  // job, not this engine's. Pagination/assert/mapping are identical, so both run here.
  if (recipe.kind !== 'fetch' && recipe.kind !== 'http') {
    throw new Error('interpret only supports fetch and http recipes')
  }
  // A declared `default` in params_schema is a promise to the recipe author that the hole
  // will be filled — so honour it here, once, rather than making every caller remember.
  // Left to the caller, an omitted optional param sends the LITERAL `{passcode}` upstream
  // (substitute leaves unknown holes in place), and the site answers with a generic error
  // that names nothing. Call params always win; only absent ones fall back.
  const params = { ...paramDefaults(recipe.meta?.params_schema), ...callParams }
  const items: MappedItem[] = []
  // object 输出的 http recipe 走 interpretObject，不该到这来；装载校验已挡，这里的守卫
  // 同时替 TS 收窄可选字段。
  const pg = recipe.pagination
  const mapping = recipe.mapping
  if (!pg || !mapping) {
    throw new Error(`recipe "${recipe.sourceId}": items 输出需要 pagination 与 mapping（object 输出走 interpretObject）`)
  }
  let pages = 0

  if (pg.mode === 'increment') {
    let value = pg.start
    for (let page = 0; page < pg.maxPages; page++) {
      const resp = await deps.fetchInPage(resolveFetch(recipe, { ...params, [pg.param]: String(value) }))
      pages++
      let raw: unknown[]
      try {
        checkAsserts(recipe, resp, page)
        raw = extractItems(pg.itemsAt, resp, page)
      } catch (e) {
        if (isBoundaryDrift(e, page)) break
        throw e
      }
      for (const r of raw) items.push(mapItem(r, mapping))
      if (raw.length === 0) break // an empty page is the natural end of an increment feed
      if (pg.hasMore && !getPath(resp, pg.hasMore)) break
      value += pg.step
    }
    return { items, pages }
  }

  // cursor mode
  let cursor = ''
  for (let page = 0; page < pg.maxPages; page++) {
    const resp = await deps.fetchInPage(resolveFetch(recipe, { ...params, [pg.cursorParam]: cursor }))
    pages++
    let raw: unknown[]
    try {
      checkAsserts(recipe, resp, page)
      raw = extractItems(pg.itemsAt, resp, page)
    } catch (e) {
      if (isBoundaryDrift(e, page)) break
      throw e
    }
    for (const r of raw) items.push(mapItem(r, mapping))
    if (pg.hasMore && !getPath(resp, pg.hasMore)) break
    const next = getPath(resp, pg.cursorFrom)
    if (next == null || next === '') break
    cursor = String(next)
  }

  return { items, pages }
}
