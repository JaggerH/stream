import { describe, it, expect, vi } from 'vitest'
import { ContentCache } from '../../content-cache.ts'
import { ocrArticleImages, type OcrImagesDeps } from './ocr-images.ts'
import { withImageOcrCache, wireOcrImageCache } from './ocr-cache.ts'

const MD = '正文一\n![配图](https://e.com/a.png)\n正文二'

function fresh(): ContentCache {
  const cache = new ContentCache(':memory:')
  wireOcrImageCache(cache)
  return cache
}

const deps = (ocr: OcrImagesDeps['ocr'], cache: ContentCache | null): OcrImagesDeps =>
  withImageOcrCache(
    {
      // 每次都产一个**新的** Uint8Array：缓存不能靠"字节对象恰好是同一个"蒙对。
      fetchBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }),
      ocr,
    },
    cache,
  )

describe('按图缓存 —— 一张图只付一次视觉模型', () => {
  it('同一张图片 URL 过两次，第二次一次模型都不调', async () => {
    const cache = fresh()
    const ocr = vi.fn(async () => '图上的字')
    const d = deps(ocr, cache)
    await ocrArticleImages(MD, d)
    const second = await ocrArticleImages(MD, d)
    expect(ocr).toHaveBeenCalledTimes(1)
    // 命中也要产出**同样的正文**——缓存只省调用，不改结果。
    expect(second.markdown).toContain('图中文字：图上的字')
    expect(second.recognized).toBe(1)
  })

  it('缓存按图不按文章：换一篇文章、换一份 deps，同一张图照样命中', async () => {
    const cache = fresh()
    const ocr = vi.fn(async () => '图上的字')
    await ocrArticleImages(`第一篇\n${MD}`, deps(ocr, cache))
    await ocrArticleImages(`另一篇完全不同的文章\n${MD}`, deps(ocr, cache))
    expect(ocr).toHaveBeenCalledTimes(1)
  })

  // null 有两种来源：图上真没字，和 `parse` 行全员失败（没配 / 限流）。后者缓存 30 天等于
  // 把一次配置故障固化成"这张图没字"——一个改完配置也不会自愈的假事实。所以 null 不入库。
  it('没识别出东西不进缓存（下次还会再试）', async () => {
    const cache = fresh()
    const ocr = vi.fn(async () => null)
    const d = deps(ocr, cache)
    await ocrArticleImages(MD, d)
    await ocrArticleImages(MD, d)
    expect(ocr).toHaveBeenCalledTimes(2)
  })

  it('没接缓存层（测试 / 独立跑）时原样直调，不炸', async () => {
    const ocr = vi.fn(async () => '图上的字')
    const d = deps(ocr, null)
    await ocrArticleImages(MD, d)
    await ocrArticleImages(MD, d)
    expect(ocr).toHaveBeenCalledTimes(2)
  })
})
