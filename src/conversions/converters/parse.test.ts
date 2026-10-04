import { describe, expect, it, vi } from 'vitest'
import { makeParseConverter } from './parse.ts'
import { makeExtractConverter } from './extract.ts'
import { ConversionRunner } from '../runner.ts'
import { ConversionStore } from '../store.ts'

const settle = () => new Promise((r) => setTimeout(r, 0))

// OCR 不再是一个对外的 kind——它是 extract 的一条分支。所以这里也经 extract 驱动：
// 那是它唯一的真实入口，绕过去测等于测一条没人走的路。另外两条分支给成不可用，
// 判定只可能落在 ocr 上（gallery 的 archetype 也把它钉死了）。
const IMAGE = [{ kind: 'image' as const, url: 'u' }]
const GALLERY = { archetype: 'gallery' as const, media: IMAGE }

const dead = { stages: [], available: () => false, run: async () => ({ ok: false as const, error: { code: 'x', message: 'x' } }) }

function setup(over: Parameters<typeof makeParseConverter>[0] extends infer D ? Partial<D> : never = {} as never) {
  const store = new ConversionStore(':memory:')
  const ocrImagesDeps = {
    fetchBytes: vi.fn(async (url: string) => ({ bytes: new Uint8Array([1]), mime: 'image/png' })),
    ocr: vi.fn(async () => '图上有字'),
  }
  const deps = {
    resolveSource: vi.fn(async () => ({ bytes: new Uint8Array([1]), mime: 'image/png' })),
    parse: vi.fn(async () => ({ markdown: '# hello', ladder: { via: 'zhipu', rungs: [{ member: 'zhipu', source: 'ocr-vlm', ms: 12, outcome: 'win' as const }] } })),
    resolveImages: vi.fn(() => ['u']),
    ocrImages: vi.fn(() => ocrImagesDeps),
    available: () => true,
    ...(over as object),
  } as Parameters<typeof makeParseConverter>[0]
  const converter = makeExtractConverter({
    ocr: makeParseConverter(deps),
    stt: dead,
    article: { available: () => false, fetch: async () => null, ocrImages: async (md: string) => md },
  })
  const runner = new ConversionRunner({ store, converters: [converter], derivations: [], costarts: [] })
  return { store, runner, deps, ocrImagesDeps }
}

/** 起一次「转成文字」，目标是一张图 → 必走 ocr 分支。 */
const startOcr = (runner: ConversionRunner) =>
  runner.start('extract', 'item-1', { options: { media: IMAGE, content: GALLERY } })

/** 起一次「转成文字」，目标是多图 gallery → 走逐图管线。 */
const startOcrMulti = (runner: ConversionRunner, media: Array<{ kind: 'image'; url: string }>) =>
  runner.start('extract', 'item-1', { options: { media, content: { archetype: 'gallery' as const, media } } })

describe('ocr 分支（原 parse converter）', () => {
  it('阶段声明带分支前缀，可用性随分支走', () => {
    const { runner } = setup()
    const k = runner.kinds()[0]
    expect(k.kind).toBe('extract')
    // article:ocr 是**声明**的阶段（正文里有图才真的跑，那时才进 timing）——
    // 声明是给 /api/conversion-kinds 看的"这个 kind 有哪些段"，与某一次实际跑过哪些段是两件事。
    expect(k.stages).toEqual(['ocr:fetch', 'ocr:ocr', 'article:fetch', 'article:ocr'])
    expect(k.branches).toEqual({ ocr: true, stt: false, article: false })
  })

  it('产出 markdown，fetch 与 ocr 分开计时', async () => {
    const { runner } = setup()
    const { record } = startOcr(runner)
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect(rec.result).toEqual({ text: '# hello', format: 'markdown', branch: 'ocr' })
    expect(rec.timing!.stages.map((s) => s.name)).toEqual(['ocr:fetch', 'ocr:ocr'])
  })

  it('media 提示递给 resolver，字节递给后端', async () => {
    const { runner, deps } = setup()
    const { record } = startOcr(runner)
    await settle()
    expect(deps.resolveSource).toHaveBeenCalledWith(IMAGE)
    expect(deps.parse).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/png', 'item-1', expect.anything())
    expect(runner.get(record.id)!.status).toBe('done')
  })

  it('取不到可解析的源 → 结构化错误码，且失败也留计时（慢失败才是要查的那种）', async () => {
    const { runner } = setup({ resolveSource: vi.fn(async () => null) } as never)
    const { record } = startOcr(runner)
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('error')
    expect(rec.error).toEqual({ code: 'no_source', message: 'no parseable source' })
    expect(rec.timing!.stages.map((s) => s.name)).toEqual(['ocr:fetch'])
  })

  it('后端炸了 → 落成 error 记录，原文带出来', async () => {
    const { runner } = setup({ parse: vi.fn(async () => { throw new Error('MinerU 503') }) } as never)
    const { record } = startOcr(runner)
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('error')
    expect(rec.error!.message).toContain('MinerU 503')
  })

  it('多图 gallery：逐图并发识别，每张都进管线，单图路径不被调用', async () => {
    const { runner, deps, ocrImagesDeps } = setup({ resolveImages: vi.fn(() => ['u1', 'u2', 'u3']) } as never)
    const media = [{ kind: 'image' as const, url: 'u1' }, { kind: 'image' as const, url: 'u2' }, { kind: 'image' as const, url: 'u3' }]
    const { record } = startOcrMulti(runner, media)
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect(rec.result).toMatchObject({ format: 'markdown', branch: 'ocr' })
    const text = (rec.result as { text: string }).text
    expect(text).toContain('![图 1](u1)')
    expect(text).toContain('![图 2](u2)')
    expect(text).toContain('![图 3](u3)')
    expect(text).toContain('图中文字：图上有字')
    // 三张图各 fetch + ocr 一次；单图路径（resolveSource/parse）完全不碰
    expect(ocrImagesDeps.fetchBytes).toHaveBeenCalledTimes(3)
    expect(ocrImagesDeps.ocr).toHaveBeenCalledTimes(3)
    expect(deps.resolveSource).not.toHaveBeenCalled()
    expect(deps.parse).not.toHaveBeenCalled()
    // 多图是集合：只有一个 ocr 阶段（逐图并发一把包住），没有单图路径的 fetch 分段
    expect(rec.timing!.stages.map((s) => s.name)).toEqual(['ocr:ocr'])
  })

  it('多图超上限：只识别前 9 张，超出部分留可见标记', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'image' as const, url: `u${i + 1}` }))
    const { runner, ocrImagesDeps } = setup({ resolveImages: vi.fn(() => many.map((m) => m.url)) } as never)
    const { record } = startOcrMulti(runner, many)
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect(ocrImagesDeps.fetchBytes).toHaveBeenCalledTimes(9)
    const text = (rec.result as { text: string }).text
    expect(text).toContain('![图 9](u9)')
    expect(text).not.toContain('![图 10]')
    expect(text).toContain('[未识别：共 12 张图，超出上限 9 张，其余未识别]')
  })

  it('单图仍走 parse 行（带 ladder），不进多图管线', async () => {
    const { runner, deps, ocrImagesDeps } = setup() // resolveImages 默认 ['u']——一张
    const { record } = startOcr(runner)
    await settle()
    const rec = runner.get(record.id)!
    expect(rec.status).toBe('done')
    expect(deps.parse).toHaveBeenCalled()
    expect(ocrImagesDeps.ocr).not.toHaveBeenCalled()
    expect(rec.ladder?.via).toBe('zhipu')
  })
})
