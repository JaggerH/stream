import { describe, expect, it } from 'vitest'

import { ensureChipStyles } from '../src/client/input/chip-styles.ts'

/** 从一份 TTF 里读出**最宽**那个字形的 advance（单位：em）。
 *
 *  这份字体只有两个字形：`.notdef`（0.5 em）和 U+FFFC 那个格子——最宽的就是格子。
 *  表目录 → `head` 拿 unitsPerEm（偏移 18）、`hhea` 拿 numberOfHMetrics（偏移 34）、
 *  `hmtx` 里每条 longHorMetric 头两个字节是 advance。**不引 fontTools 那种大家伙**——
 *  这里要证的只有一个数，自己数字节比多一个依赖便宜。 */
function widestAdvanceEm(ttf: Uint8Array): number {
  const view = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength)
  const numTables = view.getUint16(4)
  const tables = new Map<string, number>()
  for (let i = 0; i < numTables; i += 1) {
    const at = 12 + i * 16
    const tag = String.fromCharCode(...ttf.slice(at, at + 4))
    tables.set(tag, view.getUint32(at + 8))
  }
  const head = tables.get('head')
  const hhea = tables.get('hhea')
  const hmtx = tables.get('hmtx')
  if (head === undefined || hhea === undefined || hmtx === undefined) throw new Error('字体里没有 head/hhea/hmtx')
  const count = view.getUint16(hhea + 34)
  let widest = 0
  for (let i = 0; i < count; i += 1) widest = Math.max(widest, view.getUint16(hmtx + i * 4))
  return widest / view.getUint16(head + 18)
}

describe('引用格子的样式修补', () => {
  it('挂一份 style，幂等', () => {
    ensureChipStyles()
    ensureChipStyles()
    expect(document.querySelectorAll('#stream-chip-styles')).toHaveLength(1)
  })

  it('内嵌字体把 U+FFFC 的字宽做成 6 em —— 格子宽度的唯一来源就是这个数', () => {
    ensureChipStyles()
    const css = document.getElementById('stream-chip-styles')?.textContent ?? ''
    // 只接管这一个码位：这份字体里除了 U+FFFC 什么都没有，不钉 unicode-range 就会被拿去
    // 顶别的字符（整个输入框变豆腐块）。
    expect(css).toContain('unicode-range:U+FFFC')
    // 独立族名 + 插在 DshChipCell 前面：同名覆盖走不通（实测先声明的那份赢），理由见被测
    // 模块头注。三层元素少一层就是那一层和另外两层错位。
    expect(css).toContain('font-family:StreamChipCellWide;')
    for (const sel of ['[data-input-backdrop]', '[data-input-mirror]', '[data-input-backdrop]~textarea']) {
      expect(css).toContain(sel)
    }
    expect(css).toContain('font-family:StreamChipCellWide,DshChipCell,')
    const b64 = /base64,([A-Za-z0-9+/=]+)\)/.exec(css)?.[1]
    expect(b64).toBeDefined()
    const bytes = Uint8Array.from(atob(b64 as string), (ch) => ch.charCodeAt(0))
    expect(widestAdvanceEm(bytes)).toBe(6)
  })

  it('标题左对齐 + 右侧省略号 —— DSH 原样是居中 + clip，两头一起切', () => {
    ensureChipStyles()
    const css = document.getElementById('stream-chip-styles')?.textContent ?? ''
    // 三样缺一不可：`display:block` 是让 text-overflow 生效的前提（flex 容器里那段匿名
    // 文字吃不到省略号），`text-align:left` 才是治"两头一起切"的那一条。
    // 选择器咬的是属性不是类名：DSH 的类名带每次构建都会变的哈希。
    expect(css).toContain('[data-decoration="chip"]>span{display:block;text-align:left;text-overflow:ellipsis}')
  })
})
