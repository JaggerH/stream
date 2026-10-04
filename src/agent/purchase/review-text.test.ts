import { describe, it, expect, vi } from 'vitest'
import { makeReviewText, MIN_USABLE_TEXT } from './review-text.ts'
import type { ReviewItem } from './job.ts'

const ITEM: ReviewItem = { id: 'r1', title: '横评', url: 'https://x/1' }
const long = (n = MIN_USABLE_TEXT) => '正'.repeat(n)

function deps(over: Partial<Parameters<typeof makeReviewText>[0]> = {}) {
  return {
    excerptOf: () => '',
    hasMedia: () => false,
    transcribe: async () => '',
    readUrl: async () => '',
    ...over,
  }
}

describe('makeReviewText', () => {
  it('摘要够长就直接用，不去起转换也不抓页', async () => {
    const transcribe = vi.fn(async () => long())
    const readUrl = vi.fn(async () => long())
    const text = await makeReviewText(deps({ excerptOf: () => long(), hasMedia: () => true, transcribe, readUrl }))(ITEM)
    expect(text).toBe(long())
    expect(transcribe).not.toHaveBeenCalled()
    expect(readUrl).not.toHaveBeenCalled()
  })

  it('**视频横评走转写**——本地 ASR 几乎白拿，跳过它等于整类证据消失', async () => {
    const transcribe = vi.fn(async () => long())
    const text = await makeReviewText(deps({ excerptOf: () => '标题党一句话', hasMedia: () => true, transcribe }))(ITEM)
    expect(transcribe).toHaveBeenCalledOnce()
    expect(text).toBe(long())
  })

  it('没有媒体的条目不白起一次转换', async () => {
    const transcribe = vi.fn(async () => long())
    await makeReviewText(deps({ excerptOf: () => '短', hasMedia: () => false, readUrl: async () => long(), transcribe }))(ITEM)
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('转写挂了不放倒这一篇——回落到抓页', async () => {
    const text = await makeReviewText(
      deps({
        excerptOf: () => '短',
        hasMedia: () => true,
        transcribe: async () => { throw new Error('ASR 后端没起来') },
        readUrl: async () => long(),
      }),
    )(ITEM)
    expect(text).toBe(long())
  })

  it('**"取到一点点"不算取到**：短摘要不许直接凑合，要继续往下走', async () => {
    // 一段 200 字的视频简介喂给抽取关节，模型会诚实地抽出零条点名，而回执长得和
    // 「这篇确实没夸谁」一模一样——那是这条线最怕的一类静默。
    const readUrl = vi.fn(async () => long())
    const text = await makeReviewText(deps({ excerptOf: () => '简介'.repeat(50), readUrl }))(ITEM)
    expect(readUrl).toHaveBeenCalledOnce()
    expect(text).toBe(long())
  })

  it('三档都很短时取最长的那一份，不回空', async () => {
    const text = await makeReviewText(
      deps({ excerptOf: () => '一二三', hasMedia: () => true, transcribe: async () => '一二三四五', readUrl: async () => '一二' }),
    )(ITEM)
    expect(text).toBe('一二三四五')
  })
})
