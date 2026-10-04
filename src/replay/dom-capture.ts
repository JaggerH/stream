/**
 * Browser-recipe authoring aid: structured DOM snapshot of a rendered surface, so recipe
 * `itemSelector` / `fields` / modal selectors are read off the real logged-in
 * page instead of guessed with throwaway scratch scripts.
 *
 * Split by the $$eval serialization rule (see dom-harvest.ts): the in-page
 * collectors are self-contained (no nested named function consts — esbuild's
 * keepNames would emit `__name` and break Playwright serialization); the ranking
 * lives here in Node where it is unit-testable against a plain fixture.
 */

/** One repeated element signature counted across the page. */
export interface SigCount {
  sig: string
  count: number
}

/** A candidate feed-card selector (the repeating container = itemSelector). */
export interface ContainerCandidate {
  selector: string
  count: number
}

/** A candidate field within a card. */
export interface FieldCandidate {
  selector: string
  attr?: string
  sample: string
}

/** Candidate selectors found inside an opened post modal. */
export interface ModalScan {
  commentCountSelector?: string
  nextImageSelector?: string
  videoSelector?: string
}

export interface DomCaptureReport {
  url: string
  containers: ContainerCandidate[]
  /** field candidates sampled from the first match of the top container */
  fields: FieldCandidate[]
  modal?: ModalScan
}

/**
 * Rank repeated element signatures into itemSelector candidates: keep signatures
 * that repeat at least `minCount` times (a feed card recurs; page chrome does
 * not), most-repeated first, capped to `top`.
 */
export function rankContainers(
  sigCounts: SigCount[],
  opts: { minCount?: number; top?: number } = {},
): ContainerCandidate[] {
  const minCount = opts.minCount ?? 5
  const top = opts.top ?? 8
  return sigCounts
    .filter((s) => s.count >= minCount && s.sig.includes('.'))
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
    .map((s) => ({ selector: s.sig, count: s.count }))
}

// ── In-page collectors (self-contained; pass to page.evaluate) ───────────────
// Only non-function consts and anonymous array-method callbacks inside — no
// const-assigned arrows, so esbuild does not wrap them with __name.

/** Count every element's `tag.classlist` signature (stable classes only). */
export function collectSignatures(): SigCount[] {
  const counts: Record<string, number> = {}
  const els = document.querySelectorAll('body *')
  for (let i = 0; i < els.length; i++) {
    const el = els[i]
    // drop classes with digits (hashed/utility churn) so the signature is stable
    const cls = Array.from(el.classList).filter((c) => c && !/\d/.test(c)).sort()
    if (cls.length === 0) continue
    const sig = el.tagName.toLowerCase() + '.' + cls.join('.')
    counts[sig] = (counts[sig] || 0) + 1
  }
  return Object.keys(counts).map((sig) => ({ sig, count: counts[sig] }))
}

/** Sample field candidates (href/text) from the FIRST element matching `sel`. */
export function sampleContainer(sel: string): FieldCandidate[] {
  const first = document.querySelector(sel)
  if (!first) return []
  const out: FieldCandidate[] = []
  const kids = first.querySelectorAll('*')
  for (let i = 0; i < kids.length && out.length < 40; i++) {
    const k = kids[i]
    const cls = Array.from(k.classList).filter((c) => c && !/\d/.test(c)).sort()
    const subSel = k.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '')
    const href = k.getAttribute('href')
    const text = (k.textContent || '').trim().slice(0, 60)
    if (href) out.push({ selector: subSel, attr: 'href', sample: href })
    else if (text) out.push({ selector: subSel, sample: text })
  }
  return out
}

/** Minimal Playwright-page surface this module needs (evaluate only). */
export interface EvaluablePage {
  url(): string
  evaluate<R>(fn: (arg: any) => R, arg?: any): Promise<R>
}

/**
 * Orchestrate a capture: count signatures, rank into itemSelector candidates,
 * then sample fields from the top candidate. Pure over the page surface, so a
 * fake page drives the unit test.
 */
export async function captureDom(
  page: EvaluablePage,
  opts: { minCount?: number; top?: number } = {},
): Promise<DomCaptureReport> {
  const sigCounts = await page.evaluate(collectSignatures)
  const containers = rankContainers(sigCounts, opts)
  const fields: FieldCandidate[] = containers.length
    ? await page.evaluate(sampleContainer, containers[0].selector)
    : []
  return { url: page.url(), containers, fields }
}
