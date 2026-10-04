import { describe, expect, it, beforeEach } from 'vitest'
import { api, LOCAL, applyBackend } from './api.ts'

describe('connection base + wsUrl', () => {
  beforeEach(() => {
    LOCAL.baseUrl = ''
    LOCAL.wsBase = undefined
  })

  it('web default: relative baseUrl, ws derived from it', () => {
    expect(api.wsUrl(LOCAL)).toBe('/ws') // '' → scheme-swap noop + '/ws'
  })

  it('applyBackend sets streamapi httpBase + explicit wsBase', () => {
    applyBackend('http://streamapi.localhost', 'ws://127.0.0.1:8900')
    expect(LOCAL.baseUrl).toBe('http://streamapi.localhost')
    expect(api.wsUrl(LOCAL)).toBe('ws://127.0.0.1:8900/ws')
  })

  it('wsUrl falls back to baseUrl scheme-swap when wsBase unset', () => {
    LOCAL.baseUrl = 'http://127.0.0.1:4555'
    expect(api.wsUrl(LOCAL)).toBe('ws://127.0.0.1:4555/ws')
  })
})
