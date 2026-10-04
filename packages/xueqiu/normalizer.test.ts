import { describe, it, expect } from 'vitest'
import type { SourceManifest } from '../../src/manifest/types.ts'
import type { Media } from '../../src/content/types.ts'
import { xueqiuNormalizer } from './normalizer.ts'
import { DETAIL_SOURCE } from './detail.ts'

const m = {} as SourceManifest
const imgUrls = (ms?: Media[]) => (ms ?? []).flatMap((im) => (im.kind === 'image' ? [im.url] : []))

describe('xueqiuNormalizer', () => {
  it('转发/回复帖:archetype=forward,原帖进 quoted(作者+正文),本帖评论进 text', () => {
    const c = xueqiuNormalizer(
      { description: '回复<a href="#">@nilkzhu</a>: 今天2700了', quoteText: '这波经济周期下行之期还未到来<br/>春江水暖鸭先知', quoteAuthor: '汉口巴菲特', quotePermalink: '/123/456' },
      m,
    )
    expect(c.archetype).toBe('forward')
    expect(c.text).toContain('今天2700了')
    expect(c.quoted?.author).toBe('汉口巴菲特')
    expect(c.quoted?.text).toContain('这波经济周期下行之期还未到来')
    expect(c.quoted?.text).toContain('春江水暖鸭先知')
    expect(c.quoted?.permalink).toBe('https://xueqiu.com/123/456')
  })

  it('无评论的纯引用:text 空,原帖仍在 quoted', () => {
    const c = xueqiuNormalizer({ description: '', quoteText: '原帖正文', quoteAuthor: '某人' }, m)
    expect(c.archetype).toBe('forward')
    expect(c.text).toBeUndefined()
    expect(c.quoted?.author).toBe('某人')
    expect(c.quoted?.text).toBe('原帖正文')
  })

  it('原创帖:archetype=text,无 quoted', () => {
    const c = xueqiuNormalizer({ description: '这是一条原创观点<br/>第二段' }, m)
    expect(c.archetype).toBe('text')
    expect(c.text).toContain('这是一条原创观点')
    expect(c.quoted).toBeUndefined()
  })

  it('图片:本帖图进顶层 media,原帖图进 quoted.media', () => {
    const c = xueqiuNormalizer(
      { description: '<img src="https://x/own.jpg">我的评论', quoteText: '<img src="https://x/quote.jpg">原帖', quoteAuthor: '作者' },
      m,
    )
    expect(c.archetype).toBe('forward')
    expect(imgUrls(c.media)).toEqual(['https://x/own.jpg'])
    expect(imgUrls(c.quoted?.media)).toEqual(['https://x/quote.jpg'])
  })

  // 实测 markup(段永平 timeline,2026-07-29):表情是内联 <img>,src 落在 /ugc/images/face/,
  // alt/title 是 [牛] 这种字面。当成图片会既污染图集、又把这个字丢出正文。
  const EMOJI = '<img src="//assets.imedao.com/ugc/images/face/emoji_07_wonderful.png?v=1" title="[牛]" alt="[牛]" height="24" />'

  it('表情不是图片:不进 media,alt 文字留在正文里', () => {
    const c = xueqiuNormalizer({ description: `这波操作${EMOJI}真行` }, m)
    expect(c.archetype).toBe('text')
    expect(c.media).toBeUndefined()
    expect(c.text).toBe('这波操作[牛]真行')
  })

  it('原帖里的表情同样不进 quoted.media', () => {
    const c = xueqiuNormalizer({ description: '', quoteText: `谢谢${EMOJI}`, quoteAuthor: '某人' }, m)
    expect(imgUrls(c.quoted?.media)).toEqual([])
    expect(c.quoted?.text).toBe('谢谢[牛]')
  })

  it('表情与真图混排:只留真图,archetype 仍是 gallery', () => {
    const c = xueqiuNormalizer(
      { description: `看图${EMOJI}<img src="//xqimg.imedao.com/real.jpg!custom.jpg">` },
      m,
    )
    expect(c.archetype).toBe('gallery')
    expect(imgUrls(c.media)).toEqual(['//xqimg.imedao.com/real.jpg!custom.jpg'])
    expect(c.text).toBe('看图[牛]')
  })
})

// user_timeline 把原帖 description 服务端截断（结尾是字面 "..." 或 "…"）。截断了、且有 permalink 可去，
// 才申报「打开时去详情页现取全文」——没截断就没有东西可补，别白占一次 facility 的访问。
describe('xueqiuNormalizer · content.enrich（打开时补全被截断的原帖）', () => {
  it('原帖以 ... 截断 + 有 permalink → enrich 指向本包的 detail enricher', () => {
    const c = xueqiuNormalizer({ description: '回复', quoteText: '由此我在...', quoteAuthor: 'a', quotePermalink: '/2882140015/402749359' }, m)
    expect(c.enrich).toEqual({ source: DETAIL_SOURCE, params: { permalink: 'https://xueqiu.com/2882140015/402749359' } })
  })

  it('中文省略号 … 截断同样申报', () => {
    const c = xueqiuNormalizer({ description: '', quoteText: '正文未完…', quoteAuthor: 'a', quotePermalink: '/1/999' }, m)
    expect(c.enrich).toEqual({ source: DETAIL_SOURCE, params: { permalink: 'https://xueqiu.com/1/999' } })
  })

  it('原帖完整（没截断）→ 不申报', () => {
    const c = xueqiuNormalizer({ description: '', quoteText: '完整的一句话，没有被截断。', quoteAuthor: 'a', quotePermalink: '/1/999' }, m)
    expect(c.enrich).toBeUndefined()
  })

  it('截断了但没有 permalink → 不申报（没有地方可去）', () => {
    const c = xueqiuNormalizer({ description: '', quoteText: '被截断...', quoteAuthor: 'a' }, m)
    expect(c.enrich).toBeUndefined()
  })

  it('原创帖不申报', () => {
    expect(xueqiuNormalizer({ description: '原创...' }, m).enrich).toBeUndefined()
  })
})
