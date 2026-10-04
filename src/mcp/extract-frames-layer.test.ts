import { describe, it, expect } from 'vitest'
import { applyFramesLayer, onScreenTextOf, ON_SCREEN_TEXT_MAX_CHARS } from './extract-frames-layer.ts'

const DONE = { status: 'done', result: { text: '山山流水终于穿过了群山一座座', branch: 'stt' } }
const TRACK = [
  { at: 0.4585, text: '8月29日，据中华慈善总会官微发布\n捐赠善款100万元' },
  { at: 3.2099, text: '中华慈善总会携手网球运动员郑钦文捐赠100万元善款支援西藏吉隆抢险救灾' },
]

describe('applyFramesLayer', () => {
  it('没有这一层（非视频）→ 回执原封不动（同一个引用）', () => {
    expect(applyFramesLayer(DONE, 'i1', undefined)).toBe(DONE)
  })

  it('上游 extract 自己还没好 → 不加戏，原样退回', () => {
    const running = { status: 'running' }
    expect(applyFramesLayer(running, 'i1', { status: 'queued' })).toBe(running)
  })

  // 这条是整个文件的理由。活体 2026-08-30：回执带着转写 + 一句「稍等再取」，模型照样
  // 当场把那 14 个字的歌词总结了出来，而画面上整段新闻通稿还在抽。
  it('还在跑 + 转写站不住 → 报 running 且**不带 result**：手里没有字，才总结不了', () => {
    for (const status of ['queued', 'running'] as const) {
      const out = applyFramesLayer(DONE, 'i1', { status }) as Record<string, unknown>
      expect(out.status).toBe('running')
      expect(out).not.toHaveProperty('result')
      expect(out.item).toBe('i1')
      expect(out.waiting_for).toBe('on_screen_text')
    }
  })

  // 走到「还在跑」= 服务端 90 秒预算已经花光（extract-settle.ts），也就是说这条属于
  // 重尾那一批。这时候叫模型重试就是让它每次再冻一分半——「五张卡片」正是这么来的。
  it('还在跑 → 两档都**明确禁止再调一次**，一律交回给用户', () => {
    for (const standsAlone of [true, false]) {
      const out = applyFramesLayer(DONE, 'i1', { status: 'running' }, standsAlone) as Record<string, unknown>
      const note = standsAlone ? String((out.on_screen_text as { note: string }).note) : String(out.note)
      expect(note).toContain('别再调 extract')
      expect(note).toContain('告诉用户')
      expect(note).not.toContain('再调一次 extract')
    }
  })

  // 转写完整、画面上的字只是补充（闸门判 deictic 那一类）→ 扣着一份能读的转写等十几分钟
  // 没有道理；给出去，另挂一条「还缺一层」。
  it('还在跑 + 转写站得住 → 正文照给，另挂 on_screen_text: running', () => {
    const out = applyFramesLayer(DONE, 'i1', { status: 'running' }, true) as Record<string, unknown>
    expect(out.status).toBe('done')
    expect(out.result).toBe(DONE.result)
    expect((out.on_screen_text as { status: string }).status).toBe('running')
  })

  it('这一层落定 → 画面文字**直接拼进回执**，不指望模型自己再去调 get_conversions', () => {
    const out = applyFramesLayer(DONE, 'i1', { status: 'done', track: TRACK }) as Record<string, unknown>
    expect(out.status).toBe('done')
    expect(out.result).toBe(DONE.result) // 转写照旧在
    const layer = out.on_screen_text as { text: string; note: string }
    expect(layer.text).toContain('中华慈善总会携手网球运动员郑钦文')
    expect(layer.text).toContain('[00:03]') // 时间戳，便于跟转写对齐
    expect(layer.note).toContain('不在上面的转写里')
  })

  it('逐帧看过、没料 → 标 empty + scanned，绝不拼一个空字符串装成「画面上什么都没有」', () => {
    const layer = { status: 'done' as const, track: [], probe: { stop: 'done', ocrTried: 12 } }
    const out = applyFramesLayer(DONE, 'i1', layer) as { on_screen_text: Record<string, unknown> }
    expect(out.on_screen_text.empty).toBe(true)
    expect(out.on_screen_text.scanned).toBe(true)
    expect(out.on_screen_text).not.toHaveProperty('text')
    expect(String(out.on_screen_text.note)).toContain('12')
  })

  // 这条是活体撞出来的（2026-08-30，item 091cde94499fbd0b，丽江通报那条短新闻）：
  // frames 0.0 秒落 done + 空轨，而它其实停在闸门（dense_speech，378 字/分钟）——一帧都
  // 没抽。当时回执对模型说的是「跑过了，画面上没有转写之外的字」，纯属编造。
  // `frames.ts` 头注早就写着「track: [] 不是证据，要看 probe.stop」，这里之前没照做。
  it('判为不抽（闸门/无源/画面不动）→ 报 not_scanned，绝不说成「画面上没有字」', () => {
    for (const stop of ['gate', 'no_source', 'still_picture']) {
      const out = applyFramesLayer(DONE, 'i1', { status: 'done', track: [], probe: { stop } }) as {
        on_screen_text: Record<string, unknown>
      }
      expect(out.on_screen_text.status).toBe('not_scanned')
      expect(out.on_screen_text.scanned).toBe(false)
      expect(out.on_screen_text.empty).toBeUndefined()
      expect(String(out.on_screen_text.note)).toContain('没验到')
      expect(String(out.on_screen_text.why)).not.toBe('')
    }
  })

  // 探过几帧、判「没有新字」是真的看过，跟上面三档不一样，别一起归进 not_scanned。
  it('探过没料（no_new_text）算看过 → 仍是 empty', () => {
    const layer = { status: 'done' as const, track: [], probe: { stop: 'no_new_text', ocrTried: 3 } }
    const out = applyFramesLayer(DONE, 'i1', layer) as { on_screen_text: Record<string, unknown> }
    expect(out.on_screen_text.scanned).toBe(true)
  })

  it('这一层失败 → 说清是后端失败，不许被读成「画面上没有字」', () => {
    const out = applyFramesLayer(DONE, 'i1', { status: 'error' }) as { on_screen_text: { note: string } }
    expect(out.on_screen_text.note).toContain('后端失败')
    expect(out.on_screen_text.note).toContain('get_conversions')
  })

  it('回执不是对象（形状变了）→ 原样退回，绝不抛', () => {
    expect(applyFramesLayer('boom', 'i1', { status: 'done' })).toBe('boom')
    expect(applyFramesLayer(null, 'i1', { status: 'done' })).toBe(null)
    expect(applyFramesLayer([1], 'i1', { status: 'done' })).toEqual([1])
  })
})

describe('onScreenTextOf', () => {
  it('空轨 → undefined（「探过没料」和「有字」在账上必须分得开）', () => {
    expect(onScreenTextOf([])).toBeUndefined()
    expect(onScreenTextOf(undefined)).toBeUndefined()
  })

  it('超长截断——回执体积是硬约束，全份仍在 get_conversions 里', () => {
    const long = [{ at: 0, text: 'あ'.repeat(ON_SCREEN_TEXT_MAX_CHARS + 500) }]
    const out = onScreenTextOf(long)!
    expect(out.length).toBe(ON_SCREEN_TEXT_MAX_CHARS + 1) // 截断标记
    expect(out.endsWith('…')).toBe(true)
  })
})
