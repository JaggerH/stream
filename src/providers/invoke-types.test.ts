import { describe, it, expect } from 'vitest'
import { fillHoles, memberCallArgs } from './invoke-types.ts'

describe('memberCallArgs — 非 builtin 成员的调用形状', () => {
  it('字符串输入：键就是它，成员参数原样', () => {
    expect(memberCallArgs('周杰伦', { level: 'lossless' })).toEqual({ key: '周杰伦', params: { level: 'lossless' } })
    expect(memberCallArgs('x', undefined)).toEqual({ key: 'x', params: undefined })
  })

  it('对象输入：字段进 params、键留空——绝不产出 "[object Object]"', () => {
    const call = memberCallArgs({ vid: 'BV1xx', format: 'dash' }, undefined)
    expect(call).toEqual({ key: '', params: { vid: 'BV1xx', format: 'dash' } })
    expect(JSON.stringify(call)).not.toContain('[object Object]')
  })

  it('成员行上绑的参数覆盖输入字段（那是用户给这条行的显式配置）', () => {
    expect(memberCallArgs({ vid: 'BV1xx', format: 'dash' }, { format: 'progressive' }).params)
      .toEqual({ vid: 'BV1xx', format: 'progressive' })
  })

  it('数组 / null 不算对象输入（照 String 走，和以前一致）', () => {
    expect(memberCallArgs(null, undefined).key).toBe('null')
    expect(memberCallArgs(['a'], undefined).key).toBe('a')
  })
})

describe('fillHoles', () => {
  it("'$input' 洞换成输入本身（对象也整个放进去）", () => {
    expect(fillHoles({ id: '$input', level: 'hi' }, '42')).toEqual({ id: '42', level: 'hi' })
    expect(fillHoles({ q: '$input' }, { a: 1 })).toEqual({ q: { a: 1 } })
    expect(fillHoles(undefined, 'x')).toBeUndefined()
  })
})
