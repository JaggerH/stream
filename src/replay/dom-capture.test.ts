import { describe, it, expect, vi } from 'vitest'
import { rankContainers, captureDom, type SigCount, type FieldCandidate, type EvaluablePage } from './dom-capture.ts'

describe('rankContainers — repeating-container detection', () => {
  const sigs: SigCount[] = [
    { sig: 'div.wrapper', count: 1 },              // page chrome — one-off
    { sig: 'section.note-item', count: 30 },       // the feed card — repeats a lot
    { sig: 'a.cover', count: 30 },                 // per-card link — also repeats
    { sig: 'nav.header', count: 1 },               // chrome
    { sig: 'li.tag', count: 6 },                   // minor repeat
    { sig: 'span', count: 200 },                   // no class → excluded (no '.')
  ]

  it('keeps only signatures that repeat >= minCount and have a class, most-repeated first', () => {
    const ranked = rankContainers(sigs, { minCount: 5 })
    expect(ranked.map((c) => c.selector)).toEqual(['section.note-item', 'a.cover', 'li.tag'])
    expect(ranked[0]).toEqual({ selector: 'section.note-item', count: 30 })
  })

  it('excludes classless signatures (no reliable selector) and rare ones', () => {
    const ranked = rankContainers(sigs, { minCount: 10 })
    expect(ranked.map((c) => c.selector)).not.toContain('span')
    expect(ranked.map((c) => c.selector)).not.toContain('li.tag') // count 6 < 10
  })

  it('caps to top N', () => {
    const many: SigCount[] = Array.from({ length: 20 }, (_, i) => ({ sig: `div.c${i}x`, count: 100 - i }))
    expect(rankContainers(many, { minCount: 1, top: 3 })).toHaveLength(3)
  })
})

describe('captureDom — orchestration over a page surface', () => {
  it('ranks containers then samples fields from the top candidate', async () => {
    const sigCounts: SigCount[] = [
      { sig: 'section.note-item', count: 24 },
      { sig: 'div.chrome', count: 1 },
    ]
    const fields: FieldCandidate[] = [
      { selector: 'a.cover', attr: 'href', sample: '/explore/abc123' },
      { selector: 'span.title', sample: 'a note title' },
    ]
    const evaluate = vi.fn()
      .mockResolvedValueOnce(sigCounts) // collectSignatures
      .mockResolvedValueOnce(fields)    // sampleContainer(top)
    const page: EvaluablePage = { url: () => 'https://site/explore', evaluate: evaluate as any }

    const report = await captureDom(page, { minCount: 5 })

    expect(report.url).toBe('https://site/explore')
    expect(report.containers[0].selector).toBe('section.note-item')
    expect(report.fields).toEqual(fields)
    // second evaluate was called with the winning container selector
    expect(evaluate.mock.calls[1][1]).toBe('section.note-item')
  })

  it('no repeating container → no field sampling', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce([{ sig: 'div.solo', count: 1 }] as SigCount[])
    const page: EvaluablePage = { url: () => 'https://site/x', evaluate: evaluate as any }

    const report = await captureDom(page, { minCount: 5 })

    expect(report.containers).toHaveLength(0)
    expect(report.fields).toEqual([])
    expect(evaluate).toHaveBeenCalledTimes(1) // never sampled fields
  })
})
