import { describe, it, expect } from 'vitest'
import { cookieStr, transformRegistry } from './cookie-mapper.ts'
import type { BrowserCookie } from './types.ts'

const c = (name: string, value: string): BrowserCookie =>
  ({ name, value }) as BrowserCookie

describe('cookieStr', () => {
  it('joins cookies into a name=value; … header', () => {
    expect(cookieStr([c('a', '1'), c('b', '2')])).toBe('a=1; b=2')
  })
})

describe('transformRegistry', () => {
  it('github picks the user_session cookie value as the token', () => {
    const out = transformRegistry.github([c('user_session', 'gh'), c('other', 'o')])
    expect(out).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'gh' })
  })

  it('has exactly the one intended entry', () => {
    expect(Object.keys(transformRegistry).sort()).toEqual(['github'])
  })
})
