import { describe, expect, it } from 'vitest'
import { locateCard, type CardPosition, type PageDriver, type ViewportCard } from './actions.ts'

/** A fake masonry feed: `cols` columns, each card ~CARD tall with a per-column stagger (so a row's
 *  cards do NOT share one docY — that's the noise the estimator has to survive). readViewport
 *  returns only the cards overlapping the viewport, deduped, like the real drivers.
 *
 *  `dom` models how much of the feed the page actually keeps in the DOM, which is what decides
 *  whether locateCard can READ the target's position or has to ESTIMATE it:
 *    'all'    — every loaded card stays in the DOM (a long list; what xhs's feed really does)
 *    'window' — only cards near the viewport (a strictly virtualized list)
 *    'none'   — the driver has no findCard capability at all
 *
 *  Counts jumps (evalJson scrollTo) and wheels (scrollOnce) so a test can assert how FEW moves it
 *  took — the whole point of reading the target's position instead of skimming to it. */
function fakeFeed(ids: string[], { cols = 5, viewportH = 800, dom = 'all' as 'all' | 'window' | 'none' } = {}) {
  const CARD = 300
  const ROW = 320
  const docY = (i: number) => Math.floor(i / cols) * ROW + (i % cols) * 7 // stagger within a row
  const scrollHeight = docY(ids.length - 1) + CARD
  const clamp = (y: number) => Math.max(0, Math.min(scrollHeight - viewportH, y))
  let scrollY = 0
  let jumps = 0
  let wheels = 0
  const findCard = async (_sel: string, id: string): Promise<CardPosition | null> => {
    const i = ids.indexOf(id)
    if (i < 0) return null
    if (dom === 'window' && Math.abs(docY(i) - scrollY) > viewportH * 1.5) return null
    return { docY: docY(i), scrollY, viewportH }
  }
  const driver: PageDriver = {
    exists: async () => false,
    goto: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {}, type: async () => true,
    submit: async () => true, sleep: async () => {}, moveMouse: async () => {},
    scrollOnce: async (px: number) => { wheels++; scrollY = clamp(scrollY + px) },
    scrollProbe: async () => ({ scrollY, viewportH, scrollHeight }),
    evalJson: async (expr: string) => {
      const m = expr.match(/scrollTo\(0,\s*(-?\d+)/)
      if (m) { jumps++; scrollY = clamp(Number(m[1])) }
      return null
    },
    readViewport: async (): Promise<ViewportCard[]> => ids
      .map((id, i) => ({ id, top: docY(i) - scrollY, height: CARD }))
      .filter((c) => c.top + c.height > 0 && c.top < viewportH),
    ...(dom === 'none' ? {} : { findCard }),
  }
  return {
    driver,
    get moves() { return jumps + wheels },
    get jumps() { return jumps },
    park: (y: number) => { scrollY = clamp(y) },
    get bottom() { return scrollHeight - viewportH },
  }
}

describe('locateCard', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `n${i}`)

  it('returns true immediately, with no scrolling, when the target is already in view', async () => {
    const p = fakeFeed(ids)
    expect(await locateCard(p.driver, 'a', ids, 'n2')).toBe(true)
    expect(p.moves).toBe(0)
  })

  it('goes straight to a far-below target by reading its position out of the DOM', async () => {
    // 38 rows down. A one-viewport-per-step skim needs ~15 scrolls; reading the card's real
    // document Y takes one jump.
    const p = fakeFeed(ids)
    expect(await locateCard(p.driver, 'a', ids, 'n190')).toBe(true)
    expect(p.jumps).toBe(1)
    expect(p.moves).toBe(1)
  })

  it('goes straight to a far-above target from the bottom', async () => {
    // the post-harvest state: the tab is parked at the loaded bottom and the user opens an early
    // card. Nothing to re-anchor, nothing to skim — the card's position is right there to read.
    const p = fakeFeed(ids)
    p.park(p.bottom)
    expect(await locateCard(p.driver, 'a', ids, 'n5')).toBe(true)
    expect(p.moves).toBe(1)
  })

  it('walks the last stretch with a trusted wheel, not a jump', async () => {
    // within one screen of the target we scroll for real — the gesture right before the click stays
    // human. (n17 sits in the first row below the fold: distance < viewportH.)
    const p = fakeFeed(ids)
    expect(await locateCard(p.driver, 'a', ids, 'n17')).toBe(true)
    expect(p.jumps).toBe(0)
    expect(p.moves).toBeGreaterThan(0)
  })

  it('estimates its way to a target the virtualized DOM has not rendered yet', async () => {
    // a strictly virtualized list: the target's card does not exist to be read, so the position has
    // to be extrapolated from the ledger indices of the cards that ARE on screen. Still converges
    // in a couple of moves rather than a 15-scroll skim.
    const p = fakeFeed(ids, { dom: 'window' })
    expect(await locateCard(p.driver, 'a', ids, 'n190')).toBe(true)
    expect(p.jumps).toBeGreaterThan(0)
    expect(p.moves).toBeLessThanOrEqual(4)
  })

  it('re-anchors at the top and skims when it recognises nothing and cannot read the DOM', async () => {
    // the last-resort path: no findCard capability, and the rendered feed shares no card with the
    // ledger (xhs re-fetches 推荐 on a back-nav, so the tab can be showing a different batch).
    // parked at the bottom, where every visible card is foreign — the only way back to known
    // ground is the feed top.
    const rendered = ids.concat(Array.from({ length: 60 }, (_, i) => `other${i}`))
    const p = fakeFeed(rendered, { dom: 'none' })
    p.park(p.bottom)
    expect(await locateCard(p.driver, 'a', ids, 'n0', { maxSteps: 30 })).toBe(true)
    expect(p.jumps).toBe(1) // the one re-anchor
  })

  it('returns false when the target is neither in the DOM nor in the ledger', async () => {
    const p = fakeFeed(ids)
    expect(await locateCard(p.driver, 'a', ids, 'ghost')).toBe(false)
  })

  it('gives up (rather than spinning) when the page stops responding to scrolls', async () => {
    const p = fakeFeed(ids, { dom: 'window' })
    const frozen: PageDriver = { ...p.driver, scrollOnce: async () => {}, evalJson: async () => null }
    expect(await locateCard(frozen, 'a', ids, 'n190')).toBe(false)
  })
})
