// src/conversions/converters/parse.ts
//
// OCR / 文档解析（MinerU）作为一种 conversion。重构前这条链路自带一整套队列 + 状态机
// （src/docparse/service.ts）；现在它只剩「怎么跑一次」——排队/去重/取消/计时全归 ConversionRunner。
import type { Media } from '../../content/types.ts'
import type { SourceBytes } from '../../docparse/media.ts'
import type { LadderTrace } from '../../providers/ladder-trace.ts'
import { ocrArticleImages, type OcrImagesDeps } from '../../content/images/ocr-images.ts'
import type { ExtractBranchRunner } from './extract.ts'

/** 多图 gallery 一次最多识别多少张。再往上会吃光 ocrArticleImages 的总预算（60s）并把后头的
 *  图全标「总超时」，还白烧 token——设上限让「超出」变成一条可见标记，而不是整批拖垮。 */
const MAX_OCR_IMAGES = 9

export interface ParseConverterDeps {
  /** item 上**所有**图片的 URL（第一张在前）；空数组 = 没有图。单图/无图路径仍走
   *  `resolveSource`（保持 ladder 与 fetch/ocr 分段的现状）。 */
  resolveImages: (media: Media[] | undefined) => string[]
  /** 逐图 OCR 管线（与 article 分支同款：并发、超时、按图缓存、失败标记）。多图才用它。 */
  ocrImages: (signal?: AbortSignal) => OcrImagesDeps
  /** 把 item 的 media 解析成可解析的字节（图片 / 取回的 PDF）；null = 没有可解析的东西。 */
  resolveSource: (media: Media[] | undefined) => Promise<SourceBytes | null>
  /** 走 parse 能力行的梯子出 markdown，并带回**是谁干的**（`ladder`）。失败时抛 `LadderError`，
   *  让走法在失败那条路上也留得住。 */
  parse: (bytes: Uint8Array, mime: string, itemId: string, signal?: AbortSignal) => Promise<{ markdown: string; ladder: LadderTrace }>
  /** 后端配没配。 */
  available: () => boolean
}

export function makeParseConverter(deps: ParseConverterDeps): ExtractBranchRunner {
  return {
    stages: ['fetch', 'ocr'],
    available: deps.available,
    async run(ctx) {
      const media = ctx.options.media as Media[] | undefined
      const images = deps.resolveImages(media)
      // 多图 = 一个**集合**：逐图并发识别（上限 MAX_OCR_IMAGES），任何单图失败都不拖垮整批
      // （标 `[未识别：…]` 留在正文里，和 article 分支同一个纪律）。ladder 不进信封——每张图
      // 各有各的走法，一个信封装不下；要查谁干的看 DebugBox 的 recipe 频道。
      if (images.length > 1) {
        const shown = images.slice(0, MAX_OCR_IMAGES)
        const markdown = shown.map((url, i) => `![图 ${i + 1}](${url})`).join('\n')
        const over = images.length - shown.length
        const result = await ctx.stage('ocr', () => ocrArticleImages(markdown, deps.ocrImages(ctx.signal)))
        const overNote = over > 0
          ? `\n\n[未识别：共 ${images.length} 张图，超出上限 ${MAX_OCR_IMAGES} 张，其余未识别]\n`
          : ''
        return { ok: true, result: { markdown: result.markdown + overNote } }
      }
      const src = await ctx.stage('fetch', () => deps.resolveSource(media))
      if (!src) return { ok: false, error: { code: 'no_source', message: 'no parseable source' } }
      const res = await ctx.stage('ocr', () => deps.parse(src.bytes, src.mime, ctx.itemId, ctx.signal))
      return { ok: true, result: { markdown: res.markdown }, ladder: res.ladder }
    },
  }
}
