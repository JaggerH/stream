import { describe, it, expect } from 'vitest'
import { LoginProviderRegistry, type LoginProvider } from './login-provider.ts'

describe('LoginProviderRegistry', () => {
  it('dispatches by method', () => {
    const qr: LoginProvider = { method: 'qr', async begin() {} }
    const reg = new LoginProviderRegistry()
    reg.register(qr)
    expect(reg.get('qr')).toBe(qr)
    expect(reg.get('phone-rr')).toBeUndefined()
  })
})
