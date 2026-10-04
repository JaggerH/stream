import { describe, it, expect } from 'vitest'
import { extractCards, domAccumulatorInput } from './dom-harvest.ts'
import { HarvestAccumulator } from './harvest.ts'
import type { DomHarvest } from './recipe.ts'

// Minimal fake DOM element — mirrors the browser Element surface extractCards
// touches (querySelector / getAttribute / textContent). The real path runs the
// SAME function in-page via page.$$eval; this exercises the extraction logic.
function el(opts: {
  text?: string
  attrs?: Record<string, string>
  children?: Record<string, { text?: string; attrs?: Record<string, string> }>
}): any {
  const make = (t?: string, a?: Record<string, string>) => ({
    textContent: t ?? null,
    getAttribute: (name: string) => a?.[name] ?? null,
    querySelector: () => null,
  })
  return {
    textContent: opts.text ?? null,
    getAttribute: (name: string) => opts.attrs?.[name] ?? null,
    querySelector: (sel: string) => {
      const c = opts.children?.[sel]
      return c ? make(c.text, c.attrs) : null
    },
  }
}

const FIELDS = {
  noteId: { selector: 'a.cover', attr: 'href', extract: '/explore/(\\w+)' },
  title: { selector: '.title' },
  link: { selector: 'a.cover', attr: 'href' },
}

describe('extractCards', () => {
  it('reads sub-selector text, attr, and regex-extracted id', () => {
    const cards = extractCards(
      [
        el({
          children: {
            'a.cover': { attrs: { href: 'https://www.xiaohongshu.com/explore/abc123?x=1' } },
            '.title': { text: '  hello world  ' },
          },
        }),
      ],
      FIELDS,
    )
    expect(cards).toEqual([
      { noteId: 'abc123', title: 'hello world', link: 'https://www.xiaohongshu.com/explore/abc123?x=1' },
    ])
  })

  it('skips a field whose sub-element is missing (no crash)', () => {
    const cards = extractCards([el({ children: { '.title': { text: 'only title' } } })], FIELDS)
    expect(cards[0]).toEqual({ title: 'only title' })
  })

  it('reads the card element itself when no selector given', () => {
    const cards = extractCards([el({ text: 'card text' })], { body: {} })
    expect(cards[0]).toEqual({ body: 'card text' })
  })
})

describe('domAccumulatorInput + HarvestAccumulator (dedupe across ticks)', () => {
  const H: DomHarvest = {
    mode: 'dom',
    itemSelector: '.note-card',
    fields: FIELDS,
    dedupeBy: 'noteId',
    targetCount: 3,
  }

  const card = (id: string) => ({ noteId: id, title: 't' + id, link: 'u' + id })

  it('derives an itemsAt="items" identity-mapped accumulator config', () => {
    expect(domAccumulatorInput(H)).toEqual({
      itemsAt: 'items',
      dedupeBy: 'noteId',
      targetCount: 3,
      mapping: { noteId: 'noteId', title: 'title', link: 'link' },
      assert: [],
    })
  })

  it('dedupes recycled cards across ticks and stops at targetCount', () => {
    const acc = new HarvestAccumulator(domAccumulatorInput(H))
    // tick 1: two cards
    expect(acc.offer({ items: [card('1'), card('2')] }).fresh).toBe(2)
    // tick 2: virtualized list re-shows card 2 (recycled), plus a new 3
    expect(acc.offer({ items: [card('2'), card('3')] }).fresh).toBe(1)
    expect(acc.size).toBe(3)
    expect(acc.done).toBe(true)
    expect(acc.items().map((i) => (i as any).title)).toEqual(['t1', 't2', 't3'])
  })
})
