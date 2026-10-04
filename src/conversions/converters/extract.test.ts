import { describe, expect, it, vi } from 'vitest'
import { ConversionStore } from '../store.ts'
import { ConversionRunner } from '../runner.ts'
import { makeExtractConverter, type ExtractBranchRunner, type ExtractConverterDeps, type ExtractResult } from './extract.ts'
import type { Content } from '../../../shared/extract/plan.ts'
import { htmlToMarkdown } from '../../content/article-text.ts'
import { ocrArticleImages, type OcrImagesDeps } from '../../content/images/ocr-images.ts'

const settle = () => new Promise((r) => setTimeout(r, 0))

const branch = (over: Partial<ExtractBranchRunner> = {}): ExtractBranchRunner => ({
  stages: ['a'],
  available: () => true,
  run: async () => ({ ok: true, result: {} }),
  ...over,
})

function setup(over: Partial<ExtractConverterDeps> = {}) {
  const deps: ExtractConverterDeps = {
    ocr: branch({ stages: ['fetch', 'ocr'], run: async () => ({ ok: true, result: { markdown: '# 图上的字' } }) }),
    stt: branch({
      stages: ['media', 'asr'],
      run: async () => ({ ok: true, result: { text: '说了这些', lang: 'zh', segments: [{ start: 0, end: 1, text: 'hi' }] } }),
    }),
    article: { available: () => true, fetch: async () => ({ text: '网页正文' }), ocrImages: async (md) => md },
    ...over,
  }
  const store = new ConversionStore(':memory:')
  const runner = new ConversionRunner({ store, converters: [makeExtractConverter(deps)], derivations: [], costarts: [] })
  return { runner, deps }
}

/** 起一次 extract 并等它落定，返回那条记录。 */
async function run(content: Content, over: Partial<ExtractConverterDeps> = {}, url?: string) {
  const { runner, deps } = setup(over)
  const { record } = runner.start('extract', 'item-1', { options: { content, url } })
  await settle()
  return { rec: runner.get(record.id)!, deps }
}

const result = (rec: { result?: unknown }) => rec.result as ExtractResult

describe('extract converter — 三条分支拍成一个形状', () => {
  it('图 → ocr 分支，markdown 进 text 并标明 format', async () => {
    const { rec } = await run({ archetype: 'gallery', media: [{ kind: 'image', url: 'https://x/i.jpg' }] })
    expect(rec.status).toBe('done')
    expect(result(rec)).toEqual({ text: '# 图上的字', format: 'markdown', branch: 'ocr' })
  })

  // 合同是 text；lang/segments 是转写特产，进 detail 不进顶层——否则 OCR 的结果会凭空多出
  // 两个恒空字段，而 segments 又是声纹归名/播放器同步的命脉，不能砍。
  it('视频 → stt 分支，正文进 text，时间轴进 detail', async () => {
    const { rec } = await run({ archetype: 'video', media: [{ kind: 'video', url: 'https://x/v.mp4' }] })
    const r = result(rec)
    expect(r.text).toBe('说了这些')
    expect(r.branch).toBe('stt')
    expect(r.detail).toEqual({ lang: 'zh', segments: [{ start: 0, end: 1, text: 'hi' }] })
    expect('segments' in r).toBe(false) // 没有被提到顶层
  })

  it('OCR 的结果不带 detail（它本来就产不出时间轴，不补空壳）', async () => {
    const { rec } = await run({ archetype: 'gallery', media: [{ kind: 'image', url: 'https://x/i.jpg' }] })
    expect('detail' in result(rec)).toBe(false)
  })

  it('网页 → article 分支', async () => {
    const { rec } = await run({ archetype: 'link', media: [{ kind: 'link', url: 'https://m/1' }] })
    // article 的 format 是 markdown：投影保留 `![alt](url)`，firecrawl 降级档原生也是 markdown。
    expect(result(rec)).toEqual({ text: '网页正文', format: 'markdown', branch: 'article' })
  })

  // 白拿的一档：正文本来就在 item 上。判据是**一个后端都没打**——只断言拿到了文本的话，
  // 一个「照样跑了一趟 OCR 再返回」的实现也能过。
  it('纯文本 → inline，一个后端都不打', async () => {
    const ocr = branch({ run: vi.fn(async () => ({ ok: true as const, result: { markdown: 'x' } })) })
    const stt = branch({ run: vi.fn(async () => ({ ok: true as const, result: { text: 'x' } })) })
    const article = { available: () => true, fetch: vi.fn(async () => ({ text: 'x' })), ocrImages: async (md: string) => md }
    const { rec } = await run({ archetype: 'text', text: '  就这一句  ' }, { ocr, stt, article })
    expect(result(rec)).toEqual({ text: '就这一句', format: 'plain', branch: 'inline' })
    expect(ocr.run).not.toHaveBeenCalled()
    expect(stt.run).not.toHaveBeenCalled()
    expect(article.fetch).not.toHaveBeenCalled()
  })
})

describe('extract converter — 不可行时失败，绝不换分支', () => {
  // 判定层已经守过一遍（shared/extract/plan.test.ts）；这里守的是 converter **真的没去跑别人**。
  // 一条视频 post 把封面图 OCR 出来当正文，比失败更坏：它会安静产出一份看着成功实则全错的
  // 结果，下游的总结会认真地总结那张封面。
  it('视频有封面图但转写不可用 → 报错，且没有碰 ocr 分支', async () => {
    const ocrRun = vi.fn(async () => ({ ok: true as const, result: { markdown: '封面上的字' } }))
    const { rec } = await run(
      { archetype: 'video', media: [{ kind: 'video', url: 'https://x/v.mp4' }, { kind: 'image', url: 'https://x/cover.jpg' }] },
      { stt: branch({ available: () => false }), ocr: branch({ run: ocrRun }) },
    )
    expect(rec.status).toBe('error')
    expect(rec.error?.code).toBe('branch_unavailable')
    expect(ocrRun).not.toHaveBeenCalled()
    expect(rec.result).toBeUndefined()
  })

  it('判定失败落成结构化 error code，不是 internal_error', async () => {
    const { rec } = await run({ archetype: 'gallery', media: [] })
    expect(rec.error?.code).toBe('no_source')
  })

  it('没有 content（判不出 archetype）→ 明确报出来，不猜', async () => {
    const { runner } = setup()
    const { record } = runner.start('extract', 'i', { options: {} })
    await settle()
    expect(runner.get(record.id)!.error?.code).toBe('no_content')
  })

  it('分支跑完了但没产出正文 → empty_result，不落一份空正文', async () => {
    const { rec } = await run(
      { archetype: 'gallery', media: [{ kind: 'image', url: 'https://x/i.jpg' }] },
      { ocr: branch({ run: async () => ({ ok: true, result: { markdown: '   ' } }) }) },
    )
    expect(rec.status).toBe('error')
    expect(rec.error?.code).toBe('empty_result')
  })
})

describe('extract converter — 分支的账要认得出是谁的', () => {
  // 三条分支的阶段本来就不是一回事，摊平成 `fetch|ocr|media|asr` 会让「这次走了哪条」只能靠
  // 阶段名去猜——而 `fetch` 这个名字 ocr 和 article 都想用。
  it('阶段名带分支前缀', async () => {
    const { rec } = await run(
      { archetype: 'gallery', media: [{ kind: 'image', url: 'https://x/i.jpg' }] },
      { ocr: branch({ stages: ['fetch', 'ocr'], run: async (ctx) => {
        await ctx.stage('fetch', async () => {})
        await ctx.stage('ocr', async () => {})
        return { ok: true, result: { markdown: 'x' } }
      } }) },
    )
    expect(rec.timing!.stages.map((s) => s.name)).toEqual(['ocr:fetch', 'ocr:ocr'])
  })

  it('分支的梯子走法原样带上来（谁做的这件事不能在中转时丢掉）', async () => {
    const ladder = { via: 'zhipu', rungs: [{ member: 'zhipu', source: 'ocr-vlm', ms: 12, outcome: 'win' as const }] }
    const { rec } = await run(
      { archetype: 'gallery', media: [{ kind: 'image', url: 'https://x/i.jpg' }] },
      { ocr: branch({ run: async () => ({ ok: true, result: { markdown: 'x' }, ladder }) }) },
    )
    expect(rec.ladder).toEqual(ladder)
  })
})

// 正文里的配图逐张过 OCR，批注回图片原位。图文混排的文章（公众号是典型）关键信息常在图里，
// 丢图 = 交出一份残缺正文。
describe('extract converter — article 分支的逐图 OCR', () => {
  // **真的** html→markdown 投影，不是手写的 markdown 字面量。这一条是「raw `<img>` 守门」：
  // `listMarkdownImages` 只认 `![alt](url)`，对原始 HTML 的 `<img>` 返回 []——真混进来的话，
  // 那些图会**一张标记都不留地消失**（正撞"不缺省信息"这个目的），而测试若用手写的 markdown
  // 当输入，永远看不见这件事。所以这里让产出方和消费方在同一条用例里对上。
  const ARTICLE_HTML = '<p>前文</p><img src="https://e.com/a.png" alt="配图"><p>后文</p>'

  const ocrDeps = (over: Partial<OcrImagesDeps> = {}): OcrImagesDeps => ({
    fetchBytes: async () => ({ bytes: new Uint8Array([1]), mime: 'image/png' }),
    ocr: async () => '图上写着的字',
    ...over,
  })

  const articleOf = (html: string, deps: OcrImagesDeps, seen?: string[]) => ({
    available: () => true,
    fetch: async () => ({ text: htmlToMarkdown(html) }),
    ocrImages: async (md: string) =>
      (
        await ocrArticleImages(md, {
          ...deps,
          fetchBytes: async (url: string) => {
            seen?.push(url)
            return deps.fetchBytes(url)
          },
        })
      ).markdown,
  })

  const LINK: Content = { archetype: 'link', media: [{ kind: 'link', url: 'https://m/1' }] }

  it('图被识别、批注落在图那一行的行尾，原图保留', async () => {
    const seen: string[] = []
    const { rec } = await run(LINK, { article: articleOf(ARTICLE_HTML, ocrDeps(), seen) })
    const text = result(rec).text
    // 消费方真的看见了这张图（这就是 raw `<img>` 守门断言：投影若吐原始 HTML，这里是空数组）
    expect(seen).toEqual(['https://e.com/a.png'])
    expect(text).toContain('![配图](https://e.com/a.png)')
    expect(text).not.toContain('<img')
    expect(text.split('\n')).toEqual(['前文', '![配图](https://e.com/a.png)', '> 图中文字：图上写着的字', '后文'])
  })

  // `parse` 行全员 miss（没配视觉模型 / 都失败）时 invoke 的 value 是 null。正文照常交付，
  // 图留一条看得见的标记——静静跳过正好是"缺省信息"。
  it('OCR 全员没结果 → 正文照常返回，图上留标记', async () => {
    const { rec } = await run(LINK, { article: articleOf(ARTICLE_HTML, ocrDeps({ ocr: async () => null })) })
    expect(rec.status).toBe('done')
    expect(result(rec).text).toContain('> [未识别：图上没有可读文字]')
    expect(result(rec).text).toContain('前文')
  })

  // OCR 是**增量**信息。它整个塌了（接线炸了、缓存库炸了）不能把正文一起带走——
  // "正文有、图没识别"是个有用的结果，判成整体失败则连正文一起没了。
  it('逐图 OCR 抛错 → 正文照常返回，且图留下标记（不是静静吞掉）', async () => {
    const { rec } = await run(LINK, {
      article: { available: () => true, fetch: async () => ({ text: '![图](https://e.com/a.png)\n正文' }), ocrImages: async () => { throw new Error('接线炸了') } },
    })
    expect(rec.status).toBe('done')
    expect(result(rec).text).toContain('正文')
    // 修复前：catch 直接 `return text`，图片标记消失——"这篇没跑 OCR"和"跑了但全塌了"分不出来。
    expect(result(rec).text).toContain('[未识别：接线炸了]')
  })

  it('逐图 OCR 抛错、正文有多张图 → 每一张都留标记，不是只留一张', async () => {
    const { rec } = await run(LINK, {
      article: {
        available: () => true,
        fetch: async () => ({ text: '![图一](https://e.com/a.png)\n中间\n![图二](https://e.com/b.png)' }),
        ocrImages: async () => { throw new Error('缓存库炸了') },
      },
    })
    expect(rec.status).toBe('done')
    const marks = result(rec).text.match(/\[未识别：缓存库炸了\]/g) ?? []
    expect(marks.length).toBe(2)
  })

  it('逐图 OCR 抛错、原因超长 → 截断到 200 字符（不能把整页错误塞进正文）', async () => {
    const { rec } = await run(LINK, {
      article: {
        available: () => true,
        fetch: async () => ({ text: '![图](https://e.com/a.png)\n正文' }),
        ocrImages: async () => { throw new Error('X'.repeat(500)) },
      },
    })
    const m = result(rec).text.match(/\[未识别：(X+)…\]/)
    expect(m).not.toBeNull()
    expect(m![1].length).toBe(200)
  })

  it('有图 → 账本上有 article:ocr 这一段', async () => {
    const { rec } = await run(LINK, { article: articleOf(ARTICLE_HTML, ocrDeps()) })
    expect(rec.timing!.stages.map((s) => s.name)).toEqual(['article:fetch', 'article:ocr'])
  })

  // 「没跑」和「跑了 0ms」必须分得开：未发生的阶段**不出现在数组里**，不是 ms:0。
  it('正文里没有图 → 根本不建 article:ocr 这个阶段', async () => {
    const ocrImages = vi.fn(async (md: string) => md)
    const { rec } = await run(LINK, {
      article: { available: () => true, fetch: async () => ({ text: '一段没有配图的正文' }), ocrImages },
    })
    expect(rec.timing!.stages.map((s) => s.name)).toEqual(['article:fetch'])
    expect(ocrImages).not.toHaveBeenCalled()
  })
})

describe('extract converter — 分支可用性对外可读', () => {
  it('kinds() 带出各分支配没配（前端靠它 + item 自己的 archetype 决定按钮）', () => {
    const { runner } = setup({ stt: branch({ available: () => false }) })
    const extract = runner.kinds().find((k) => k.kind === 'extract')!
    // kind 级恒可用：inline 一档不打后端。per-item 的可行性由 branches + archetype 决定。
    expect(extract.available).toBe(true)
    expect(extract.branches).toEqual({ stt: false, ocr: true, article: true })
  })
})
