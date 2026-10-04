import { parseHTML } from 'linkedom'
import type { HtmlField } from './recipe.ts'

/** The slice of the DOM this module uses. linkedom's Document/Element satisfy it; typing it
 *  structurally keeps us off linkedom's internal types (which aren't the lib DOM types). */
interface ElementLike {
  querySelector(sel: string): ElementLike | null
  querySelectorAll(sel: string): Iterable<ElementLike>
  textContent: string | null
  innerHTML: string
  getAttribute(name: string): string | null
}

/** Parse an HTML string into a queryable root (linkedom — no browser). */
export function parseDoc(html: string): ElementLike {
  return parseHTML(html).document as unknown as ElementLike
}

/** All elements matching `selector` under `root`, capped at `limit` when given. */
export function selectRows(root: ElementLike, selector: string, limit?: number): ElementLike[] {
  const all = [...root.querySelectorAll(selector)]
  return limit == null ? all : all.slice(0, limit)
}

/** Resolve a possibly-relative URL against the page it was found on; leave junk untouched. */
function resolveUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).href
  } catch {
    return value
  }
}

/** The element a field reads from: no selector → the row itself; a list → first one that hits. */
function selectorTarget(el: ElementLike, selector: HtmlField['selector']): ElementLike | null {
  if (!selector) return el
  for (const one of Array.isArray(selector) ? selector : [selector]) {
    const hit = el.querySelector(one)
    if (hit) return hit
  }
  return null
}

/**
 * Pull one field off an element. `selector` targets a descendant (omit → the element itself);
 * text (default) reads trimmed textContent, `attr` reads an attribute, `html` reads innerHTML;
 * `resolve` turns a relative URL absolute. Returns undefined when the selector matches nothing.
 *
 * A selector *list* is tried in order and the first one that matches wins. That order is the
 * only way to say "this evidence beats that one": a single selector always returns the first
 * match in **document order**, which on a Wikipedia article hands back an IMDb link cited in a
 * footnote (often about one episode) instead of the article's own external link.
 */
export function extractField(el: ElementLike, field: HtmlField, baseUrl: string): string | undefined {
  const target = selectorTarget(el, field.selector)
  if (!target) return undefined

  let value: string | null
  if (field.attr) value = target.getAttribute(field.attr)
  else if (field.html) value = target.innerHTML
  else value = target.textContent

  if (value == null) return undefined
  const trimmed = field.html ? value : value.trim()
  const resolved = field.resolve ? resolveUrl(trimmed, baseUrl) : trimmed
  return field.extract ? applyExtract(resolved, field.extract) : resolved
}

/** Regex slice-or-guard shared by HTML fields and JSON hop fields: capture group 1 (or the
 *  full match) replaces the value; no match drops the field — same contract as
 *  DomFieldSpec.extract. */
export function applyExtract(value: string, pattern: string): string | undefined {
  const m = value.match(new RegExp(pattern))
  return m ? m[1] ?? m[0] : undefined
}

/** Extract a whole field set from one element, dropping fields whose selector missed. */
export function extractFields(
  el: ElementLike,
  fields: Record<string, HtmlField>,
  baseUrl: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, field] of Object.entries(fields)) {
    const v = extractField(el, field, baseUrl)
    if (v !== undefined) out[name] = v
  }
  return out
}
