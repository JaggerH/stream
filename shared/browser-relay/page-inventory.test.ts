import { describe, it, expect } from 'vitest'
import { inventoryExpression, inventorySeqExpression, refFromSelector, REF_ATTRIBUTE, SEQ_ATTRIBUTE } from './page-inventory.ts'

describe('inventoryExpression', () => {
  it('是一个语法有效的表达式（不是语句序列）', () => {
    // facility 那条路会把它包成 `(${expression})`——语句序列在那里会当场 SyntaxError，
    // 而报错发生在页内、只回来一句含糊的注入失败。所以这条钉的是"能被包起来"。
    const expr = inventoryExpression()
    expect(() => new Function(`return (${expr})`)).not.toThrow()
  })

  it('编号挂在页面上：计数器 + data 属性，重复快照才能沿用原号', () => {
    const expr = inventoryExpression()
    expect(expr).toContain('__streamInvSeq')
    expect(expr).toContain(REF_ATTRIBUTE)
    expect(REF_ATTRIBUTE).toBe('data-stream-el')
  })

  it('清单有上限，超了报 truncated 而不是无声截断', () => {
    const expr = inventoryExpression()
    expect(expr).toContain('200')
    expect(expr).toContain('truncated')
  })

  it('异常回 {__error} 而不是抛出去', () => {
    expect(inventoryExpression()).toContain('__error')
  })

  it('跨 iframe 编号：计数挂在 <html> 上（隔离世界与主世界共享），调用方给的下限进起点，回执带 seq', () => {
    const expr = inventoryExpression({ floor: 41, maxItems: 7 })
    expect(() => new Function(`return (${expr})`)).not.toThrow()
    expect(expr).toContain(SEQ_ATTRIBUTE)
    expect(expr).toMatch(/, 41\);/)
    expect(expr).toContain('MAX_ITEMS = 7')
    expect(expr).toContain('seq: w.__streamInvSeq')
    expect(() => new Function(`return (${inventorySeqExpression()})`)).not.toThrow()
  })

  it('refFromSelector 只反解 ref 展开出的那个形状', () => {
    expect(refFromSelector('[data-stream-el="12"]')).toBe(12)
    expect(refFromSelector('#go')).toBeNull()
    expect(refFromSelector('div [data-stream-el="12"]')).toBeNull()
    expect(refFromSelector(undefined)).toBeNull()
  })
})
