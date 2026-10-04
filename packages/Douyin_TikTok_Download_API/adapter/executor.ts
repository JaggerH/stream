import type { ApiBinding, ApiQueryParam } from '../../../src/manifest/types.ts'

/** The declarative arm of ApiBinding (endpoint/query/unwrap/normalize) — handler bindings
 *  are dispatched separately by the adapter. */
export type DeclApiBinding = Extract<ApiBinding, { endpoint: string }>

/** Maps a raw upstream item into the bridge shape makeStreamItem reads (guid/title/link/…).
 *  bilibili/tiktok return raw items (their presenter reads them); douyin registers one. */
export type Normalizer = (raw: unknown) => unknown

/** True for the declarative arm (vs a named handler). */
export function isDeclarative(api: ApiBinding | undefined): api is DeclApiBinding {
  return !!api && 'endpoint' in api
}

/**
 * Resolve a binding's `query` map into concrete upstream query values.
 *  - value = params[from] ?? default
 *  - required && blank → throw
 *  - blank (undefined / '') → omit the key (matches the old adapters' skip-empty behavior)
 */
export function resolveQuery(
  query: Record<string, ApiQueryParam> | undefined,
  params: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [upstream, spec] of Object.entries(query ?? {})) {
    const raw = params[spec.from]
    const v = raw == null || raw === '' ? spec.default : raw
    if (spec.required && (v == null || v === '')) {
      throw new Error(`[api] missing required param "${spec.from}" (→ ${upstream})`)
    }
    if (v == null || v === '') continue
    out[upstream] = String(v)
  }
  return out
}

/**
 * Pull the item list out of a JSON response via a dot-path (e.g. `data.itemList`).
 * The resolved node normalizes to an array: array → itself, single object → `[object]`
 * (so anchor lookups fit the "array of raw items" contract), null/undefined → `[]`.
 */
export function pickList(response: unknown, unwrap?: string): unknown[] {
  let node: unknown = response
  if (unwrap) {
    for (const key of unwrap.split('.')) {
      if (node == null || typeof node !== 'object') return []
      node = (node as Record<string, unknown>)[key]
    }
  }
  if (Array.isArray(node)) return node
  if (node && typeof node === 'object') return [node]
  return []
}

/**
 * Execute a declarative binding: resolve the query, GET the endpoint, unwrap the list,
 * and (if declared) map each item through a registered normalizer. `get` returns the
 * parsed JSON response; the adapter injects its HTTP client so this stays unit-testable.
 */
export async function runDeclarative(
  binding: DeclApiBinding,
  params: Record<string, unknown>,
  get: (path: string, query: Record<string, string>) => Promise<unknown>,
  normalizers: Record<string, Normalizer> = {},
): Promise<unknown[]> {
  const query = resolveQuery(binding.query, params)
  const response = await get(binding.endpoint, query)
  const items = pickList(response, binding.unwrap)
  if (!binding.normalize) return items
  const fn = normalizers[binding.normalize]
  if (!fn) throw new Error(`[api] unknown normalize "${binding.normalize}"`)
  return items.map(fn)
}
