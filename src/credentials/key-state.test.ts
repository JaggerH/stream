import { describe, it, expect } from 'vitest'
import { keyRefOf, keyStateOf } from './key-state.ts'
import type { RuntimeConfigSpec } from '../manifest/types.ts'

const shared: RuntimeConfigSpec = { ref: 'tmdb', fields: { apiKey: { type: 'secret', label: 'k' }, language: { type: 'string', label: 'l' } } }
const perInstance: RuntimeConfigSpec = { ref: 'llm-openai', perInstance: true, fields: { apiKey: { type: 'secret', label: 'k' } } }
const noSecret: RuntimeConfigSpec = { ref: 'x', fields: { language: { type: 'string', label: 'l' } } }

describe('keyRefOf', () => {
  it('普通源取 manifest 的 ref——整源共享一份 key', () => {
    expect(keyRefOf(shared, { tokenName: 'llm:kimi' })).toBe('tmdb')
  })
  it('perInstance 源取成员 params.tokenName 原样——它就是完整 ref,不拼 <ref>:<实例名>', () => {
    expect(keyRefOf(perInstance, { baseUrl: 'https://k/v1', tokenName: 'llm:kimi' })).toBe('llm:kimi')
  })
  it('perInstance 源缺 tokenName → null(没有可取的层)', () => {
    expect(keyRefOf(perInstance, { connectionId: 'default' })).toBeNull()
    expect(keyRefOf(perInstance, undefined)).toBeNull()
    expect(keyRefOf(perInstance, { tokenName: '' })).toBeNull()
  })
})

describe('keyStateOf', () => {
  const layer = (ref: string) => (ref === 'llm:kimi' ? 'stored' as const : ref === 'tmdb' ? 'env' as const : null)

  it('没声明 secret 字段的源不带 keyState（null）', () => {
    expect(keyStateOf(noSecret, {}, layer)).toBeNull()
    expect(keyStateOf(undefined, {}, layer)).toBeNull()
  })
  it('普通源报 manifest ref 那一层', () => {
    expect(keyStateOf(shared, {}, layer)).toBe('env')
  })
  it('perInstance 源按成员自己的 tokenName 报层——不再对每个实例恒 missing', () => {
    expect(keyStateOf(perInstance, { tokenName: 'llm:kimi' }, layer)).toBe('stored')
    expect(keyStateOf(perInstance, { tokenName: 'llm:nokey' }, layer)).toBe('missing')
  })
  it('perInstance 源缺 tokenName(legacy/占位形状,key 不归 TokenProvider 管) → null,不带徽章', () => {
    expect(keyStateOf(perInstance, { connectionId: 'default' }, layer)).toBeNull()
    expect(keyStateOf(perInstance, undefined, layer)).toBeNull()
  })
  it('perInstance 源带 tokenName 但查不到 key → 仍是 missing,不能一起被弄哑', () => {
    expect(keyStateOf(perInstance, { tokenName: 'llm:nokey' }, layer)).toBe('missing')
  })
  it('perInstance 源带 tokenName 且查得到 key → stored', () => {
    expect(keyStateOf(perInstance, { tokenName: 'llm:kimi' }, layer)).toBe('stored')
  })
})
