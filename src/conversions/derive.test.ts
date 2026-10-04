import { describe, expect, it } from 'vitest'
import {
  CONVERSION_COSTARTS, CONVERSION_DERIVATIONS, costartsFor, derivationsFor,
  type CostartRule, type DerivationRule,
} from './derive.ts'
import type { ConversionRecord } from './store.ts'

function rec(over: Partial<ConversionRecord> = {}): ConversionRecord {
  return {
    id: 'c1',
    kind: 'extract',
    itemId: 'item-1',
    status: 'done',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...over,
  }
}

/** 走了转写分支的 extract 产物：判据是带不带 detail.segments。 */
const TRANSCRIPT = { text: '你好', format: 'plain', branch: 'stt', detail: { segments: [{ start: 0, end: 1, text: '你好' }] } }
/** 走了 OCR 分支的：同样是 done 的 extract，但产不出时间轴。 */
const OCR = { text: '# 标题', format: 'markdown', branch: 'ocr' }
/** 同一条转写，另带 media：视频 / 纯音频两种。 */
const withMedia = (media: unknown[]) => ({ ...TRANSCRIPT, detail: { ...TRANSCRIPT.detail, media } })

describe('derivationsFor', () => {
  it('转写落定（media 判不出来）→ 派 frames：判不出是不是视频时放行', () => {
    expect(derivationsFor(rec({ result: TRANSCRIPT }), CONVERSION_DERIVATIONS)).toEqual(['frames'])
  })

  it('转写落定且 media 里有视频 → 派 frames', () => {
    const r = rec({ result: withMedia([{ kind: 'video', vid: 'BV1' }]) })
    expect(derivationsFor(r, CONVERSION_DERIVATIONS)).toEqual(['frames'])
  })

  it('media 明确在、里头一个 video 都没有（纯音频播客）→ 不派 frames', () => {
    const r = rec({ result: withMedia([{ kind: 'audio', url: 'https://x/a.mp3' }]) })
    expect(derivationsFor(r, CONVERSION_DERIVATIONS)).toEqual([])
  })

  it('补说话人**不在**接力表里——它和转成文字并肩起跑，不等上游（见 costartsFor）', () => {
    for (const r of [TRANSCRIPT, withMedia([{ kind: 'audio', url: 'https://x/a.mp3' }])]) {
      expect(derivationsFor(rec({ result: r }), CONVERSION_DERIVATIONS)).not.toContain('identify')
    }
  })

  it('OCR 落定 → 什么都不派（没有时间轴，frames 没有上游可读）', () => {
    expect(derivationsFor(rec({ result: OCR }), CONVERSION_DERIVATIONS)).toEqual([])
  })

  it('规则表里每条 when 都是纯判据：拿一条畸形记录喂过去也不许抛（抛出会静默吃掉整张表）', () => {
    for (const rule of CONVERSION_DERIVATIONS) {
      expect(() => rule.when(rec({ result: { detail: { segments: [], media: null } } }))).not.toThrow()
      expect(() => rule.when(rec({ result: undefined }))).not.toThrow()
    }
  })

  it('branch 是 stt 但没有 detail.segments → 不派（判据是带不带时间轴，不是 branch 字样）', () => {
    const sttNoSegments = { text: 'x', format: 'plain', branch: 'stt' }
    expect(derivationsFor(rec({ result: sttNoSegments }), CONVERSION_DERIVATIONS)).toEqual([])
  })

  it('失败的转写不派生', () => {
    expect(derivationsFor(rec({ status: 'error', result: TRANSCRIPT }), CONVERSION_DERIVATIONS)).toEqual([])
  })

  it('还在跑的不派生', () => {
    expect(derivationsFor(rec({ status: 'running' }), CONVERSION_DERIVATIONS)).toEqual([])
  })

  it('identify 自己落定不再往下派——今天的规则表里它是终点', () => {
    expect(derivationsFor(rec({ kind: 'identify', result: {} }), CONVERSION_DERIVATIONS)).toEqual([])
  })

  it('同一个 to 被两条规则同时命中时只派一次', () => {
    const twice: DerivationRule[] = [
      { from: 'extract', to: 'identify', when: () => true },
      { from: 'extract', to: 'identify', when: () => true },
    ]
    expect(derivationsFor(rec({ result: TRANSCRIPT }), twice)).toEqual(['identify'])
  })

  it('自派生（to === from）被挡掉——那是一个无限循环', () => {
    const loop: DerivationRule[] = [{ from: 'extract', to: 'extract', when: () => true }]
    expect(derivationsFor(rec({ result: TRANSCRIPT }), loop)).toEqual([])
  })
})

describe('costartsFor —— 并肩起跑（不等上游）', () => {
  const video = [{ kind: 'video', vid: 'BV1' }]
  const audio = [{ kind: 'audio', platform: 'lizhi', track_id: '1' }]

  it('起转成文字、且这条 item 有能转写的音视频 → 同时起补说话人', () => {
    expect(costartsFor('extract', { media: video }, CONVERSION_COSTARTS)).toEqual(['identify'])
    expect(costartsFor('extract', { media: audio }, CONVERSION_COSTARTS)).toEqual(['identify'])
  })

  it('没有可转写的东西（网页/图片）→ 不并肩，别白起一批必然 no_media 的记录', () => {
    expect(costartsFor('extract', { media: [{ kind: 'link', url: 'https://x' }] }, CONVERSION_COSTARTS)).toEqual([])
    expect(costartsFor('extract', { media: [{ kind: 'image', url: 'https://x/a.png' }] }, CONVERSION_COSTARTS)).toEqual([])
  })

  it('拿不到 media（判不出来）→ 不并肩。这一层贵，方向和 frames 那条**刻意相反**', () => {
    expect(costartsFor('extract', {}, CONVERSION_COSTARTS)).toEqual([])
    expect(costartsFor('extract', { media: [] }, CONVERSION_COSTARTS)).toEqual([])
  })

  it('起别的 kind 不触发', () => {
    expect(costartsFor('identify', { media: video }, CONVERSION_COSTARTS)).toEqual([])
    expect(costartsFor('frames', { media: video }, CONVERSION_COSTARTS)).toEqual([])
  })

  it('规则表里每条 when 都是纯判据：畸形 options 喂过去也不许抛', () => {
    for (const rule of CONVERSION_COSTARTS) {
      expect(() => rule.when({})).not.toThrow()
      expect(() => rule.when({ media: null })).not.toThrow()
      expect(() => rule.when({ media: 'not-an-array' })).not.toThrow()
    }
  })

  it('自并肩（to === from）被挡掉——那是无限递归', () => {
    const loop: CostartRule[] = [{ from: 'extract', to: 'extract', when: () => true }]
    expect(costartsFor('extract', {}, loop)).toEqual([])
  })

  it('同一个 to 被两条规则命中时只起一次', () => {
    const twice: CostartRule[] = [
      { from: 'extract', to: 'identify', when: () => true },
      { from: 'extract', to: 'identify', when: () => true },
    ]
    expect(costartsFor('extract', {}, twice)).toEqual(['identify'])
  })
})
