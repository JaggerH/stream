import { describe, it, expect } from 'vitest'
import zh from './locales/zh'
import en from './locales/en'

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  )
}

// i18next 会为一个基名派生复数变体键(zh 单一形态用 _other,en 用 _one/_other 等)。
// 语言之间的复数分类天然不同(zh 只有 other,en 有 one/other,阿拉伯语有 zero/two/few/many),
// 所以按扁平键集严格相等会逼着在每种语言里补上它用不到的复数占位键。
// 对等检查只关心「基名」两边都在,复数后缀由 i18next 各自按语言处理。
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
const baseKeys = (obj: Record<string, unknown>): string[] =>
  Array.from(new Set(flatKeys(obj).map((k) => k.replace(PLURAL_SUFFIX, '')))).sort()

describe('i18n resources', () => {
  it('zh and en have identical key sets (plural suffixes stripped)', () => {
    expect(baseKeys(en)).toEqual(baseKeys(zh))
  })

  it('zh and en declare the same namespaces', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
