import { describe, it, expect } from 'vitest'
import { slimExtractReceipt } from './extract-receipt.ts'
import type { SourceManifest } from '../manifest/types.ts'

/** 算 `unblock` 用的 manifest 表。默认这张表里没有任何"能自助补"的东西——下面绝大多数用例
 *  验的是投影本身，不该被 unblock 这一格干扰；要验它的那条用例自带一张表。 */
const MANIFESTS: SourceManifest[] = []

/** 活体那条抖音记录的形状（`GET /api/conversions?expand=result` 原样）：模型用不上的格子占了大头。 */
const FAT_RECORD = {
  id: 'cv_0mteldard00005qnzrq',
  kind: 'extract',
  itemId: '54302ede4b47213a',
  inputId: null,
  status: 'done',
  snapshot: { title: '郑钦文捐赠100万元', source: 'douyin-follow', url: 'https://www.iesdouyin.com/share/video/7679?' + 'x=1&'.repeat(100), poster: 'https://p3.douyinpic.com/' + 'y'.repeat(300) },
  timing: { totalMs: 2102, stages: [{ name: 'stt:media', ms: 677 }, { name: 'stt:asr', ms: 1419 }] },
  ladder: { via: '@streamapp/builtin/groq-whisper', rungs: [{ member: 'x', source: 'y', ms: 1419, outcome: 'win' }] },
  createdAt: '2026-08-29T16:25:16.729Z',
  startedAt: '2026-08-29T16:25:16.736Z',
  finishedAt: '2026-08-29T16:25:18.838Z',
  updatedAt: '2026-08-29T16:25:18.838Z',
  result: {
    text: '山山流水终于穿过了群山一座座',
    format: 'plain',
    branch: 'stt',
    detail: {
      lang: 'Chinese',
      segments: [{ start: 0, end: 6.96, text: '山山流水终于穿过了群山一座座' }],
      media: [{ kind: 'video', embed: '/api/media/douyin/video?u=' + 'z'.repeat(600), poster: 'https://p3.douyinpic.com/' + 'w'.repeat(300), w: 1440, h: 2560 }],
    },
  },
}

describe('slimExtractReceipt', () => {
  it('落定：留下正文、分支、时间轴、身份与卡片要的 snapshot', () => {
    const out = slimExtractReceipt(FAT_RECORD, '54302ede4b47213a', MANIFESTS) as Record<string, any>
    expect(out.status).toBe('done')
    expect(out.item).toBe('54302ede4b47213a')
    expect(out.snapshot).toBe(FAT_RECORD.snapshot) // 卡片画标题/来源/缩略图/原文链接
    expect(out.result.text).toBe('山山流水终于穿过了群山一座座')
    expect(out.result.branch).toBe('stt')
    expect(out.result.detail.segments).toHaveLength(1)
    expect(out.result.detail.lang).toBe('Chinese')
  })

  it('丢掉模型一格都用不上的：id / 时间戳 / timing / ladder / detail.media', () => {
    const out = slimExtractReceipt(FAT_RECORD, 'i1', MANIFESTS) as Record<string, unknown>
    for (const k of ['id', 'kind', 'itemId', 'inputId', 'timing', 'ladder', 'createdAt', 'startedAt', 'finishedAt', 'updatedAt']) {
      expect(out).not.toHaveProperty(k)
    }
    expect((out.result as { detail: Record<string, unknown> }).detail).not.toHaveProperty('media')
    // 这条工具天生要被调好几次，所以省下来的是**每一轮**都要付的（`detail.media` 一格就 900+ 字符）。
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(FAT_RECORD).length / 2)
  })

  it('还没落定：只回身份、状态和「在等什么」，snapshot 只留名字', () => {
    const running = { ...FAT_RECORD, status: 'running', result: undefined, waiting_for: 'on_screen_text', note: '别下结论' }
    const out = slimExtractReceipt(running, 'i1', MANIFESTS) as Record<string, any>
    expect(out).toEqual({
      status: 'running',
      item: 'i1',
      waiting_for: 'on_screen_text',
      note: '别下结论',
      snapshot: { title: '郑钦文捐赠100万元', source: 'douyin-follow' },
    })
    // 两个签名 URL 加起来 800+ 字符，而这一档正文一个字都还没有——每轮重付一次是纯亏。
    expect(JSON.stringify(out).length).toBeLessThan(200)
  })

  it('窄回执三格与画面文字层照常穿过去', () => {
    const withLayers = {
      status: 'done',
      result: { text: '- 要点', digested: true, digest_failed: false, full_text_chars: 9000, next_step: 'get_conversions' },
      on_screen_text: { status: 'done', text: '[00:03] 屏幕上的字' },
    }
    const out = slimExtractReceipt(withLayers, 'i1', MANIFESTS) as Record<string, any>
    expect(out.result.digested).toBe(true)
    expect(out.result.full_text_chars).toBe(9000)
    expect(out.result.next_step).toBe('get_conversions')
    expect(out.on_screen_text.text).toContain('屏幕上的字')
  })

  it('失败与坏形状：error 留着，非对象原样退回，绝不抛', () => {
    expect(slimExtractReceipt({ status: 'error', error: 'item not found' }, 'i1', MANIFESTS)).toEqual({
      status: 'error', item: 'i1', error: 'item not found',
    })
    expect(slimExtractReceipt('boom', 'i1', MANIFESTS)).toBe('boom')
    expect(slimExtractReceipt(null, 'i1', MANIFESTS)).toBe(null)
  })

  // `unblock` 这一格：`unblockOptionsFor` 自己的判据由 src/auth/unblock.test.ts 钉着，
  // 这里只钉**投影这一层**——什么时候带、什么时候不带。
  describe('unblock', () => {
    const provisionable = [
      { id: 'groq-stt', title: 'groq-stt', runtime_config: { ref: 'groq', fields: {} } },
      { id: 'groq-create-key', title: '建一把 Groq key', runtime_config: { ref: 'groq', fields: {}, provisions: ['apiKey'] } },
    ] as unknown as SourceManifest[]
    const failedLadder = {
      status: 'error', error: '没有可用成员',
      ladder: { via: null, rungs: [{ member: 'groq', source: 'groq-stt', ms: 1, outcome: 'miss' }] },
    }

    it('失败 + 缺配置 + 有 recipe 能补 → 带上这一格', () => {
      const out = slimExtractReceipt(failedLadder, 'i1', provisionable) as Record<string, any>
      expect(out.unblock).toMatchObject([{ sourceId: 'groq-create-key', ref: 'groq', member: 'groq' }])
      // 梯子明细本身仍然整个剥掉——`unblock` 是它的结论，不是它的转发。
      expect(out).not.toHaveProperty('ladder')
    })

    // 空数组不许出现：一格白烧的上下文，还会让模型以为"我看过了、没有"从而多说一句废话。
    it('没有可补的东西时整格不出现，不是空数组', () => {
      const out = slimExtractReceipt(failedLadder, 'i1', MANIFESTS) as Record<string, unknown>
      expect(out).not.toHaveProperty('unblock')
    })

    // 成功的那次不提——梯子的意义就是有人弃权也照样出结果，这时候说"你还缺 groq key"是噪音。
    it('成功的那次不提（哪怕梯子上有人 miss）', () => {
      const won = { ...failedLadder, status: 'done', ladder: { via: 'openai', rungs: failedLadder.ladder.rungs } }
      expect(slimExtractReceipt(won, 'i1', provisionable)).not.toHaveProperty('unblock')
    })

    it('老记录没有 ladder（或形状不对）时不抛，也不带这一格', () => {
      expect(slimExtractReceipt({ status: 'error', error: 'x' }, 'i1', provisionable)).not.toHaveProperty('unblock')
      expect(slimExtractReceipt({ status: 'error', ladder: 'garbage' }, 'i1', provisionable)).not.toHaveProperty('unblock')
    })
  })
})
