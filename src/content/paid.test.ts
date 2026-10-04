import { describe, it, expect } from 'vitest'
import { normalize } from './normalize.ts'
import type { SourceManifest } from '../manifest/types.ts'

const M = {} as SourceManifest

describe('付费标（normalize 统一注入）', () => {
  it('源站标价 > 0 → paid', () => {
    expect(normalize({ title: '944.三十五探悬疑案件', price: 60 } as never, M).paid).toBe(true)
  })

  it('价格 0 / 缺失 → 不标付费（免费集、以及压根不报价的源）', () => {
    expect(normalize({ title: '945.胡说', price: 0 } as never, M).paid).toBeUndefined()
    expect(normalize({ title: '945.胡说' } as never, M).paid).toBeUndefined()
  })

  it('付费标与能不能播无关——补上了音频依然是付费集', () => {
    // 绑定/网盘把音频补上（enclosure 在手）之后，付费这个事实不该消失
    const c = normalize({ title: '944.三十五探悬疑案件', price: 60, enclosure_url: 'https://cdn/x.mp3', enclosure_type: 'audio/mpeg' } as never, M)
    expect(c.media?.some((m) => m.kind === 'audio')).toBe(true)
    expect(c.paid).toBe(true)
  })

  it('脏价格不炸也不误标', () => {
    expect(normalize({ title: 'x', price: 'abc' } as never, M).paid).toBeUndefined()
    expect(normalize({ title: 'x', price: null } as never, M).paid).toBeUndefined()
  })
})
