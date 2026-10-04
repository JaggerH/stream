import { describe, it, expect } from 'vitest'
import { closestKey, unknownKey, unknownKeyMessage } from './strict-input.ts'

describe('不认识的键', () => {
  it('全都认识 → null', () => {
    expect(unknownKey(['stream', 'limit'], ['stream', 'limit', 'order'])).toBeNull()
  })

  it('挑出第一个不认识的', () => {
    expect(unknownKey(['limit', 'stream_id'], ['stream', 'limit', 'order'])).toBe('stream_id')
  })

  it('下划线/驼峰的另一种写法认得出来——这类编辑距离不小，纯按距离会漏', () => {
    expect(closestKey('stream_id', ['stream', 'limit', 'order'])).toBe('stream')
    expect(closestKey('streamId', ['stream', 'limit'])).toBe('stream')
    expect(closestKey('source_id', ['sourceId', 'params'])).toBe('sourceId')
  })

  it('拼错一两个字母也认得出来', () => {
    expect(closestKey('lmit', ['stream', 'limit', 'order'])).toBe('limit')
    expect(closestKey('membres', ['label', 'members', 'options'])).toBe('members')
  })

  it('差太远就不猜——瞎猜比不猜更误导', () => {
    expect(closestKey('completely_unrelated', ['stream', 'limit', 'order'])).toBeUndefined()
  })

  it('报错要同时说"你写了什么"和"大概想写什么"，否则只知道错了不知道往哪改', () => {
    const msg = unknownKeyMessage('查询参数', 'stream_id', ['stream', 'limit', 'order'])
    expect(msg).toContain('stream_id')
    expect(msg).toContain("是不是想写 'stream'")
    expect(msg).toContain('limit, order, stream')
  })

  it('猜不出来时也要说清"被忽略了，不是生效了"', () => {
    const msg = unknownKeyMessage('字段', 'zzzzzzzz', ['label', 'members'])
    expect(msg).toContain('被忽略了，不是生效了')
  })
})
