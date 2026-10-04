import { describe, it, expect } from 'vitest'
import type { AuthSpec, SessionAuthSpec } from './types.ts'
import { isSessionAuth } from './types.ts'

describe('AuthSpec session variant', () => {
  it('narrows a session auth and carries login method + selectors', () => {
    const spec: AuthSpec = { type: 'session', facility: 'xhs', login: 'qr', loginUrl: 'https://www.xiaohongshu.com/explore', qrSelector: '.qrcode-img' }
    expect(isSessionAuth(spec)).toBe(true)
    if (isSessionAuth(spec)) {
      const s: SessionAuthSpec = spec
      expect(s.facility).toBe('xhs')
      expect(s.login).toBe('qr')
    }
  })
  it('rejects a non-session auth', () => {
    expect(isSessionAuth({ type: 'none' })).toBe(false)
  })
})
