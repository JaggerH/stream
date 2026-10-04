import { describe, expect, it } from 'vitest'
import { sanitizeEnrichment, sanitizeHtml } from './sanitize.ts'

const mark = (html: string) => `[clean]${html}`

describe('sanitizeEnrichment', () => {
  it('runs the cleaner over article.html and every comment html, nested replies included', () => {
    const out = sanitizeEnrichment(
      {
        article: { sourceUrl: 'https://x', html: '<p>a</p>', title: 't' },
        comments: [
          { id: '1', text: 't', html: '<p>ok</p>', replies: [{ id: '2', text: 't', html: '<b>r</b>' }] },
          { id: '3', text: 'plain only' },
        ],
        total: 3,
        cursor: null,
      },
      mark,
    )
    expect(out).toEqual({
      article: { sourceUrl: 'https://x', html: '[clean]<p>a</p>', title: 't' },
      comments: [
        { id: '1', text: 't', html: '[clean]<p>ok</p>', replies: [{ id: '2', text: 't', html: '[clean]<b>r</b>' }] },
        { id: '3', text: 'plain only' },
      ],
      total: 3,
      cursor: null,
    })
  })

  it('leaves non-enrichment answers untouched', () => {
    const owner = { mid: '1', name: 'n', face: 'f' }
    expect(sanitizeEnrichment(owner, mark)).toBe(owner)
    expect(sanitizeEnrichment(null, mark)).toBeNull()
    expect(sanitizeEnrichment([1, 2], mark)).toEqual([1, 2])
  })
})

describe('sanitizeHtml', () => {
  // 每一条都必须剥干净：危险元素整棵剪掉、事件属性剥掉、危险协议的 URL 属性整条删。
  const ATTACKS: Array<[string, string, RegExp]> = [
    ['script + onclick', '<p onclick="x()">a</p><script>evil()</script>', /script|onclick|evil/i],
    ['img onerror', '<img src="x" onerror="evil()">', /onerror|evil/i],
    ['iframe', '<iframe src="https://evil.example"></iframe><b>k</b>', /iframe|evil/i],
    ['javascript: href', '<a href="javascript:evil()">l</a>', /javascript|evil/i],
    ['entity-obfuscated javascript: href', '<a href="jav&#x61;script&colon;evil()">l</a>', /javascript|evil/i],
    ['whitespace-obfuscated javascript: href', '<a href=" java\tscript:evil()">l</a>', /script|evil/i],
    ['svg onload', '<svg onload="evil()"><circle r="1"></circle></svg>', /svg|onload|evil/i],
    ['img srcset javascript:', '<img src="https://ok.example/a.png" srcset="javascript:evil() 1x">', /srcset|javascript|evil/i],
    ['style expression', '<p style="width: expression(evil())">p</p>', /style|expression|evil/i],
    ['form action', '<form action="javascript:evil()"><button formaction="javascript:evil()">b</button></form>', /form|button|javascript|evil/i],
    ['object / embed / meta / link / base', '<object data="x"></object><embed src="x"><meta http-equiv="refresh" content="0;url=javascript:evil()"><link rel="import" href="x"><base href="javascript:evil()">', /object|embed|meta|link|base|evil/i],
    ['data: html', '<a href="data:text/html,evil">l</a><img src="data:text/html,evil">', /data:text|evil/i],
    ['vbscript', '<a href="vbscript:evil">l</a>', /vbscript|evil/i],
    // 序列化时属性值里的引号必须转义，否则值会冲出属性、长出一个新的事件属性。
    ['quote breakout in an attribute value', `<a title='x" onmouseover="evil()' href="https://ok">l</a>`, /"\s*onmouseover=/i],
    ['textarea-style raw text breakout', '<p title="&lt;/p&gt;&lt;script&gt;evil()&lt;/script&gt;">x</p>', /<script/i],
  ]
  for (const [name, payload, bad] of ATTACKS) {
    it(`strips ${name}`, () => {
      expect(sanitizeHtml(payload)).not.toMatch(bad)
    })
  }

  it('keeps the harmless parts next to what it strips', () => {
    expect(sanitizeHtml('<p onclick="x()">a</p><script>evil()</script>')).toBe('<p>a</p>')
    expect(sanitizeHtml('<iframe src="https://e"></iframe><b>k</b>')).toBe('<b>k</b>')
    expect(sanitizeHtml('<a href="javascript:x">l</a>')).toBe('<a>l</a>')
  })

  it('leaves ordinary rich text as it was', () => {
    const rich =
      '<p>Hello <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="nofollow">link</a> and <a href="/rel/path">rel</a> ' +
      '<a href="mailto:a@b.c">mail</a></p>' +
      '<img src="https://i.example/a.png" alt="x" srcset="https://i.example/a.png 1x, https://i.example/a@2x.png 2x">' +
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">' +
      '<pre><code>a &lt; b &amp;&amp; c</code></pre>' +
      '<blockquote><p>quoted</p></blockquote>' +
      '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>' +
      '<ul><li>one</li></ul><h2>t</h2><em>e</em><strong>s</strong><br>'
    expect(sanitizeHtml(rich)).toBe(rich)
  })

  it('plain text stays text (entities escaped the way innerHTML would)', () => {
    expect(sanitizeHtml('plain text & stuff')).toBe('plain text &amp; stuff')
    expect(sanitizeHtml('')).toBe('')
  })
})
