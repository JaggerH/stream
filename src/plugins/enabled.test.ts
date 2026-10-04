import { describe, it, expect } from 'vitest'
import { pluginEnabled } from './enabled.ts'

describe('pluginEnabled', () => {
  it('required plugins are always enabled, ignoring the override', () => {
    expect(pluginEnabled({ id: 'rsshub', required: true }, { rsshub: false })).toBe(true)
    expect(pluginEnabled({ id: 'builtin', required: true }, {})).toBe(true)
  })

  it('optional plugins default enabled when the map has no entry (opt-out)', () => {
    expect(pluginEnabled({ id: 'alist' }, undefined)).toBe(true)
    expect(pluginEnabled({ id: 'alist' }, {})).toBe(true)
    expect(pluginEnabled({ id: 'alist' }, { other: false })).toBe(true)
  })

  it('only an explicit false disables an optional plugin', () => {
    expect(pluginEnabled({ id: 'alist' }, { alist: false })).toBe(false)
    expect(pluginEnabled({ id: 'alist' }, { alist: true })).toBe(true)
  })
})
