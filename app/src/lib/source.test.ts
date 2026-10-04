import { describe, expect, it } from 'vitest'
import { fillAndValidateParams } from './source.ts'
import type { ParamSpec } from './types.ts'

const spec = (p: Partial<ParamSpec>): ParamSpec => ({ ...p })

describe('fillAndValidateParams', () => {
  it('fills defaults for empty optional params', () => {
    const r = fillAndValidateParams({ mode: spec({ default: 'hot' }) }, {})
    expect(r).toEqual({ ok: true, params: { mode: 'hot' } })
  })

  it('keeps user value over default', () => {
    const r = fillAndValidateParams({ mode: spec({ default: 'hot' }) }, { mode: 'new' })
    expect(r).toEqual({ ok: true, params: { mode: 'new' } })
  })

  it('reports the first missing required param', () => {
    const r = fillAndValidateParams({ uid: spec({ required: true }) }, { uid: '  ' })
    expect(r).toEqual({ ok: false, missing: 'uid' })
  })

  it('passes when all required present', () => {
    const r = fillAndValidateParams({ uid: spec({ required: true }) }, { uid: '42' })
    expect(r).toEqual({ ok: true, params: { uid: '42' } })
  })
})
