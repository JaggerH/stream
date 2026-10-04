import type { AccumulatorInput, DomFieldSpec, DomHarvest, StateHarvest, EvalHarvest } from './recipe.ts'

/**
 * Extract one field batch out of rendered feed cards.
 *
 * IMPORTANT: this runs IN-PAGE via `page.$$eval(itemSelector, extractCards, fields)`,
 * so it MUST stay self-contained — no imports, no closures over module scope, only
 * its two args and browser globals (RegExp, Object). Playwright serializes it by
 * `.toString()`; a reference to anything outside would throw in the page context.
 * It is also directly unit-testable in Node by passing fake elements.
 */
export function extractCards(
  els: ReadonlyArray<{
    querySelector(sel: string): { getAttribute(a: string): string | null; textContent: string | null } | null
    getAttribute(a: string): string | null
    textContent: string | null
  }>,
  fields: Record<string, DomFieldSpec>,
): Record<string, string>[] {
  return els.map((el) => {
    const out: Record<string, string> = {}
    for (const name of Object.keys(fields)) {
      const spec = fields[name]
      const target = spec.selector ? el.querySelector(spec.selector) : el
      if (!target) continue
      let value = spec.attr ? (target.getAttribute(spec.attr) ?? '') : (target.textContent ?? '')
      value = value.trim()
      if (spec.extract) {
        const m = value.match(new RegExp(spec.extract))
        value = m ? (m[1] ?? m[0]) : ''
      }
      out[name] = value
    }
    return out
  })
}

/**
 * A DOM harvest already produces per-card objects keyed by output field name, so
 * the accumulator maps each field to itself and reads the batch at a synthetic
 * `items` path (browser-drive feeds `{ items: cards }`). Dedupe/targetCount/drift
 * are the shared HarvestAccumulator core.
 */
export function domAccumulatorInput(h: DomHarvest): AccumulatorInput {
  const mapping: Record<string, string> = {}
  for (const k of Object.keys(h.fields)) mapping[k] = k
  return { itemsAt: 'items', dedupeBy: h.dedupeBy, targetCount: h.targetCount, mapping, assert: [] }
}

/**
 * SSR-state harvest: `readState` returns the raw item array, which browser-drive wraps
 * as `{ items: [...] }` and offers ONCE. Unlike DOM, the mapping is the recipe's own
 * (dot-paths / `{path}`-templates into each raw item), not an identity map — the raw
 * item is the site's nested state object, not a pre-flattened card.
 */
export function stateAccumulatorInput(h: StateHarvest): AccumulatorInput {
  return { itemsAt: 'items', dedupeBy: h.dedupeBy, targetCount: h.targetCount, mapping: h.mapping, assert: h.assert ?? [] }
}

/**
 * In-page eval harvest: the recipe's `call` returns `{items, cursor}` per page; the
 * engine offers each page's item array wrapped as `{ items: [...] }` at the synthetic
 * `items` path. Like state, the mapping is the recipe's own dot-paths into each raw
 * item (the site's nested note object), not an identity map.
 */
export function evalAccumulatorInput(h: EvalHarvest): AccumulatorInput {
  return { itemsAt: 'items', dedupeBy: h.dedupeBy, targetCount: h.targetCount, mapping: h.mapping, assert: h.assert ?? [] }
}
