import { describe, expect, it } from 'vitest'
import { parseDoc, selectRows, extractField, extractFields } from './html-extract.ts'

const LIST = `
<ul id="threads">
  <li class="row"><div class="subject"><a href="/t/1">  First thread  </a></div><span class="date">2026-07-01</span></li>
  <li class="row"><div class="subject"><a href="/t/2">Second</a></div><span class="date">2026-07-02</span></li>
  <li class="row hidden"><div class="subject"><a href="/t/3">Hidden</a></div></li>
</ul>`

describe('html-extract', () => {
  it('selects rows and honors limit', () => {
    const doc = parseDoc(LIST)
    expect(selectRows(doc, 'li.row', 5).length).toBe(3)
    expect(selectRows(doc, 'li.row', 2).length).toBe(2)
    expect(selectRows(doc, 'li.row:not(.hidden)').length).toBe(2)
  })

  it('extracts text, trimmed', () => {
    const [row] = selectRows(parseDoc(LIST), 'li.row')
    expect(extractField(row, { selector: 'div.subject > a', text: true }, 'https://s.com/x')).toBe('First thread')
  })

  it('extracts an attribute and resolves relative URLs', () => {
    const [row] = selectRows(parseDoc(LIST), 'li.row')
    expect(extractField(row, { selector: 'div.subject > a', attr: 'href', resolve: true }, 'https://s.com/list/2')).toBe('https://s.com/t/1')
  })

  it('extracts innerHTML', () => {
    const doc = parseDoc('<div class="b"><b>hi</b> there</div>')
    const [el] = selectRows(doc, 'div.b')
    expect(extractField(el, { html: true }, 'https://s.com')).toBe('<b>hi</b> there')
  })

  it('returns undefined when the selector matches nothing', () => {
    const [row] = selectRows(parseDoc(LIST), 'li.row')
    expect(extractField(row, { selector: '.nope', text: true }, 'https://s.com')).toBeUndefined()
  })

  it('reads the element itself when selector is omitted', () => {
    const [date] = selectRows(parseDoc(LIST), 'span.date')
    expect(extractField(date, { text: true }, 'https://s.com')).toBe('2026-07-01')
  })

  it('tries a selector list in order and keeps the first that matches', () => {
    const doc = parseDoc('<div class="p"><cite><a href="/cited">cited</a></cite><ul><li><a href="/own">own</a></li></ul></div>')
    const [el] = selectRows(doc, 'div.p')
    // Document order would hand back the cited link; the list says "prefer the page's own".
    expect(extractField(el, { selector: ['li > a', 'a'], attr: 'href' }, 'https://s.com')).toBe('/own')
  })

  it('falls through a selector list to the last that matches', () => {
    const doc = parseDoc('<div class="p"><cite><a href="/cited">cited</a></cite></div>')
    const [el] = selectRows(doc, 'div.p')
    expect(extractField(el, { selector: ['li > a', 'a'], attr: 'href' }, 'https://s.com')).toBe('/cited')
  })

  it('returns undefined when no selector in the list matches', () => {
    const [row] = selectRows(parseDoc(LIST), 'li.row')
    expect(extractField(row, { selector: ['.nope', '.also-nope'], text: true }, 'https://s.com')).toBeUndefined()
  })

  it('maps a whole field set, skipping misses', () => {
    const [row] = selectRows(parseDoc(LIST), 'li.row')
    const out = extractFields(row, {
      title: { selector: 'div.subject > a', text: true },
      link: { selector: 'div.subject > a', attr: 'href', resolve: true },
      missing: { selector: '.nope', text: true },
    }, 'https://s.com/list')
    expect(out).toEqual({ title: 'First thread', link: 'https://s.com/t/1' })
  })
})
