import { describe, it, expect } from 'vitest'
import { withRuntimeDefaults, missingRequiredRuntimeFields } from './runtime-config.ts'
import type { RuntimeConfigSpec } from './types.ts'

const spec = (fields: RuntimeConfigSpec['fields']): RuntimeConfigSpec => ({ ref: 'tmdb', fields })

const TMDB = spec({
  apiKey: { type: 'secret', label: 'API Key' },
  language: { type: 'string', label: '语言', default: 'zh-CN' },
})

describe('withRuntimeDefaults', () => {
  it('缺失的字段 → 用 manifest 的 default（正是 language 全英文的根因）', () => {
    // 用户只存了 apiKey，language 从没进 overlay
    expect(withRuntimeDefaults(TMDB, { apiKey: 'k' })).toEqual({ apiKey: 'k', language: 'zh-CN' })
  })

  it('已存在的字段 → 尊重 stored，不被 default 覆盖', () => {
    expect(withRuntimeDefaults(TMDB, { apiKey: 'k', language: 'en-US' })).toEqual({ apiKey: 'k', language: 'en-US' })
  })

  it('空串是「用户主动清空要英文」→ 保留空串，不回填 default', () => {
    // 空串 language 传给 TMDb 会 falsy → en-US，这是尊重用户主动清空的语义
    expect(withRuntimeDefaults(TMDB, { apiKey: 'k', language: '' })).toEqual({ apiKey: 'k', language: '' })
  })

  it('没有 default 的字段 → 不凭空出现', () => {
    expect(withRuntimeDefaults(TMDB, {})).toEqual({ language: 'zh-CN' })
  })

  it('空 fields → 原样返回 stored', () => {
    expect(withRuntimeDefaults(spec({}), { apiKey: 'k' })).toEqual({ apiKey: 'k' })
  })

  it('多个 default 字段都打底', () => {
    const s = spec({ a: { type: 'string', label: 'A', default: 'x' }, b: { type: 'string', label: 'B', default: 'y' } })
    expect(withRuntimeDefaults(s, {})).toEqual({ a: 'x', b: 'y' })
  })
})

describe('missingRequiredRuntimeFields', () => {
  const S = spec({
    apiKey: { type: 'secret', label: 'Key' },
    accountId: { type: 'string', label: 'Account', required: true },
    flag: { type: 'boolean', label: '开关', required: true },
  })

  it('没声明 runtime_config → 空集（没有可缺的）', () => {
    expect(missingRequiredRuntimeFields(undefined, {})).toEqual([])
  })

  it('没写 required 的字段空着不算缺——那一格沿用「只看 token」', () => {
    expect(missingRequiredRuntimeFields(spec({ apiKey: { type: 'secret', label: 'Key' } }), {})).toEqual([])
  })

  it('required 字段缺席 / 空串 / null 都算缺；boolean false 是一个值', () => {
    expect(missingRequiredRuntimeFields(S, {})).toEqual(['accountId', 'flag'])
    expect(missingRequiredRuntimeFields(S, { accountId: '', flag: null })).toEqual(['accountId', 'flag'])
    expect(missingRequiredRuntimeFields(S, { accountId: 'a', flag: false })).toEqual([])
  })
})
