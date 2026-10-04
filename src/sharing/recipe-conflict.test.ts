import { describe, it, expect } from 'vitest'
import { resolveRecipeConflict } from './recipe-conflict.ts'

describe('resolveRecipeConflict', () => {
  it('未装 → install', () => {
    expect(resolveRecipeConflict({ id: '@a/xhs', version: '2.1.3' }, null)).toEqual({ action: 'install' })
  })
  it('更高同 major → upgrade', () => {
    expect(resolveRecipeConflict({ id: '@a/xhs', version: '2.1.3' }, { id: '@a/xhs', version: '2.0.0' }))
      .toEqual({ action: 'upgrade', from: '2.0.0', to: '2.1.3' })
  })
  it('更低/同版本同 major → reuse', () => {
    expect(resolveRecipeConflict({ id: '@a/xhs', version: '2.0.0' }, { id: '@a/xhs', version: '2.1.3' }))
      .toEqual({ action: 'reuse', keep: '2.1.3' })
  })
  it('跨 major → ask', () => {
    expect(resolveRecipeConflict({ id: '@a/xhs', version: '3.0.0' }, { id: '@a/xhs', version: '2.9.9' }))
      .toEqual({ action: 'ask', from: '2.9.9', to: '3.0.0' })
  })
  it('T3 降级：任一无 version → install（当前 facility 单包语义）', () => {
    expect(resolveRecipeConflict({ id: 'xhs' }, { id: 'xhs' })).toEqual({ action: 'install' })
  })
})
