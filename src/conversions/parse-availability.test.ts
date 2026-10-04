import { describe, it, expect } from 'vitest'
import { parseLadderLit } from './parse-availability.ts'

describe('parseLadderLit — 「这台机器认不认得出图上的字」', () => {
  it('梯子上只有 ocr-mineru、包没装 → 不亮（mineru 是可选包，缺席不是错）', () => {
    expect(parseLadderLit([{ source: 'ocr-mineru' }], { mineruInstalled: false })).toBe(false)
  })
  it('只有 ocr-mineru、包装了 → 亮', () => {
    expect(parseLadderLit([{ source: 'ocr-mineru' }], { mineruInstalled: true })).toBe(true)
  })
  it('系统行的默认成员是带命名空间的 @streamapp/builtin/ocr-mineru：同样按 mineru 可达性判', () => {
    const ns = [{ source: '@streamapp/builtin/ocr-mineru' }]
    expect(parseLadderLit(ns, { mineruInstalled: false })).toBe(false)
    expect(parseLadderLit(ns, { mineruInstalled: true })).toBe(true)
  })
  it('用户自己加的视觉模型成员 → 不看 mineru 也亮', () => {
    expect(parseLadderLit([{ source: 'ocr-vlm' }], { mineruInstalled: false })).toBe(true)
  })
  it('空梯子 → 不亮；非 source 型成员（matches / provider）不算数', () => {
    expect(parseLadderLit([], { mineruInstalled: true })).toBe(false)
    expect(parseLadderLit([{ matches: 'x' }], { mineruInstalled: true })).toBe(false)
  })
})
