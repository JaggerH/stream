import { describe, it, expect } from 'vitest'
import {
  FALLBACK_CONTEXT_WINDOW,
  declaredContextWindow,
  knownModelContextWindow,
  memberContextWindow,
} from './capacity.ts'

describe('capacity —— 猜只许往小里猜', () => {
  it('用户填的最大：填了就用填的，压过内置表', () => {
    expect(memberContextWindow(200000, 'deepseek-chat')).toBe(200000)
    expect(memberContextWindow('200000', 'deepseek-chat')).toBe(200000)
  })

  it('没填 → 查表；表里也没有 → 保守下限（**不是** 0、不是无限）', () => {
    expect(memberContextWindow(undefined, 'deepseek-chat')).toBe(65_536)
    expect(memberContextWindow(undefined, 'glm-4.5-air')).toBe(128_000)
    expect(memberContextWindow(undefined, 'deepseek-v4-flash')).toBe(1_000_000)
    expect(memberContextWindow(undefined, 'some-nobody-model')).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(memberContextWindow(undefined, '')).toBe(FALLBACK_CONTEXT_WINDOW)
  })

  it('中转网关的 `<厂商>/` 前缀要剥掉——不剥就查不到表，白白掉到下限', () => {
    // 活体配置里 Cloudflare AI Gateway 那一档就是这个形状。
    expect(knownModelContextWindow('deepseek/deepseek-chat')).toBe(65_536)
    expect(knownModelContextWindow('DeepSeek/DeepSeek-Chat')).toBe(65_536)
  })

  it('非正整数一律当没填——`0`/负数/空串不是"无限"', () => {
    for (const bad of [0, -1, '0', '-5', 'abc', '', '  ', 1.5, null, {}]) {
      expect(declaredContextWindow(bad)).toBeUndefined()
    }
    expect(memberContextWindow(0, 'some-nobody-model')).toBe(FALLBACK_CONTEXT_WINDOW)
  })

  it('查不到就是查不到，不在这一层补默认（"没查到"和"就是这么小"得分得开）', () => {
    expect(knownModelContextWindow('some-unknown-model')).toBeUndefined()
  })

})
