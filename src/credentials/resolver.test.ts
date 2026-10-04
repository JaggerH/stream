import { describe, it, expect } from 'vitest'
import { CredentialResolver } from './resolver.ts'
import type { CredentialProvider } from './types.ts'

const nullProvider: CredentialProvider = { id: 'null', resolve: async () => null }
const cookieProvider: CredentialProvider = {
  id: 'fake-cc',
  resolve: async (auth) =>
    auth.type === 'cookie' ? { envOverrides: { BILIBILI_COOKIE_42: 'c=1' } } : null,
}

describe('CredentialResolver', () => {
  it('resolves via the first provider that returns non-null', async () => {
    const r = new CredentialResolver([nullProvider, cookieProvider])
    const env = await r.resolve({ type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'bilibili' } })
    expect(env).toEqual({ BILIBILI_COOKIE_42: 'c=1' })
  })

  it('auth none resolves to empty overrides without consulting providers', async () => {
    const r = new CredentialResolver([])
    expect(await r.resolve({ type: 'none' })).toEqual({})
  })

  it('throws naming the source need when unresolved', async () => {
    const r = new CredentialResolver([nullProvider])
    await expect(r.resolve({ type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'bilibili' } })).rejects.toThrow(
      /bilibili\.com/
    )
  })

  it('is provider-swap invariant for identical output', async () => {
    const alt: CredentialProvider = {
      id: 'alt-cc',
      resolve: async (auth) =>
        auth.type === 'cookie' ? { envOverrides: { BILIBILI_COOKIE_42: 'c=1' } } : null,
    }
    const a = await new CredentialResolver([cookieProvider]).resolve({ type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'bilibili' } })
    const b = await new CredentialResolver([alt]).resolve({ type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'bilibili' } })
    expect(a).toEqual(b)
  })
})
