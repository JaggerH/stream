import { describe, it, expect } from 'vitest'
import { describeTarget, targetFields, targetFrom, taskTarget } from './target.ts'

describe('Target', () => {
  it('三格恰好一格 → 对应的目标；空串当没给', () => {
    expect(targetFrom({ deviceId: 'linux:nas' })).toEqual({ kind: 'device', deviceId: 'linux:nas' })
    expect(targetFrom({ accountId: ' 123 ', deviceId: '' })).toEqual({ kind: 'identity', accountId: '123' })
    expect(targetFrom({ environment: '工作' })).toEqual({ kind: 'environment', environment: '工作' })
    expect(targetFrom({})).toBeUndefined()
  })

  it('两格以上 → 拒', () => {
    expect(() => targetFrom({ deviceId: 'a', accountId: 'b' })).toThrow(/只能给一个/)
  })

  it('targetFields 往返', () => {
    for (const t of [{ kind: 'device', deviceId: 'd' }, { kind: 'identity', accountId: 'a' }, { kind: 'environment', environment: 'e' }] as const) {
      expect(targetFrom(targetFields(t))).toEqual(t)
    }
  })

  it('任务行：身份 → 环境 → 设备', () => {
    expect(taskTarget({ device: 'd', environment: 'e', identity: 'a' })).toEqual({ kind: 'identity', accountId: 'a' })
    expect(taskTarget({ device: 'd', environment: 'e' })).toEqual({ kind: 'environment', environment: 'e' })
    expect(taskTarget({ device: 'd' })).toEqual({ kind: 'device', deviceId: 'd' })
    expect(taskTarget({})).toBeUndefined()
  })

  it('describeTarget 说得出是哪个', () => {
    expect(describeTarget({ kind: 'identity', accountId: '42' }, 'xhs')).toBe('身份 xhs:42')
    expect(describeTarget({ kind: 'environment', environment: '工作' }, 'xhs')).toBe('环境「工作」里的 xhs')
  })
})
