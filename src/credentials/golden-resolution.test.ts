import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CookieProvider, setPackageCookieEnvSource, type CookieSource } from './cookie-provider.ts'
import type { AuthSpec } from '../manifest/types.ts'
import type { BrowserCookie } from '../types.ts'

/**
 * GOLDEN REGRESSION GATE.
 *
 * The frozen baseline is the env override the retired per-domain `MAPPING` produced
 * for representative cookies. Post-refactor, `resolve()` is inject-driven — but for
 * every domain the retired table knew, the env override MUST be byte-identical.
 * A drift here means a working login source silently changed its env var.
 */

const c = (name: string, value: string): BrowserCookie =>
  ({ name, value }) as BrowserCookie

function source(byDomain: Record<string, BrowserCookie[]>): CookieSource {
  return { fetch: async () => byDomain }
}

interface Case {
  label: string
  domain: string
  cookies: BrowserCookie[]
  auth: AuthSpec
  expected: Record<string, string>
}

const CASES: Case[] = [
  // bilibili 不再是宿主手写的 transform——它现在由 @streamapp/bilibili 包自己声明
  // `stream.rsshubCookieEnv: 'BILIBILI_COOKIE_{DedeUserID}'`，CookieProvider 先查包模板
  // 再落 transformRegistry（见下面的 beforeEach）。这条用例仍然锁的是那个字节相同的输出，
  // 只是产出它的机制搬了地方。
  {
    label: 'bilibili (package template → per-DedeUserID key)',
    domain: 'bilibili.com',
    cookies: [c('DedeUserID', '123'), c('SESSDATA', 'abc')],
    auth: { type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'bilibili' } },
    expected: { BILIBILI_COOKIE_123: 'DedeUserID=123; SESSDATA=abc' },
  },
  {
    label: 'weibo (env)',
    domain: 'weibo.com',
    cookies: [c('SUB', 'xyz')],
    auth: { type: 'cookie', domain: 'weibo.com', inject: { kind: 'env', name: 'WEIBO_COOKIES' } },
    expected: { WEIBO_COOKIES: 'SUB=xyz' },
  },
  {
    label: 'zhihu (env)',
    domain: 'zhihu.com',
    cookies: [c('z_c0', 'tok')],
    auth: { type: 'cookie', domain: 'zhihu.com', inject: { kind: 'env', name: 'ZHIHU_COOKIES' } },
    expected: { ZHIHU_COOKIES: 'z_c0=tok' },
  },
  {
    label: 'xiaohongshu (env)',
    domain: 'xiaohongshu.com',
    cookies: [c('web_session', 's')],
    auth: { type: 'cookie', domain: 'xiaohongshu.com', inject: { kind: 'env', name: 'XIAOHONGSHU_COOKIE' } },
    expected: { XIAOHONGSHU_COOKIE: 'web_session=s' },
  },
  {
    label: 'twitter.com (env → TWITTER_COOKIE)',
    domain: 'twitter.com',
    cookies: [c('auth_token', 't')],
    auth: { type: 'cookie', domain: 'twitter.com', inject: { kind: 'env', name: 'TWITTER_COOKIE' } },
    expected: { TWITTER_COOKIE: 'auth_token=t' },
  },
  {
    label: 'x.com (env → TWITTER_COOKIE)',
    domain: 'x.com',
    cookies: [c('auth_token', 't')],
    auth: { type: 'cookie', domain: 'x.com', inject: { kind: 'env', name: 'TWITTER_COOKIE' } },
    expected: { TWITTER_COOKIE: 'auth_token=t' },
  },
  {
    label: 'douyin (env, native)',
    domain: 'douyin.com',
    cookies: [c('sessionid', 'd')],
    auth: { type: 'cookie', domain: 'douyin.com', inject: { kind: 'env', name: 'DOUYIN_COOKIE' } },
    expected: { DOUYIN_COOKIE: 'sessionid=d' },
  },
  {
    label: 'github (transform → user_session value as token)',
    domain: 'github.com',
    cookies: [c('user_session', 'gh'), c('other', 'o')],
    auth: { type: 'cookie', domain: 'github.com', inject: { kind: 'transform', ref: 'github' } },
    expected: { GITHUB_PERSONAL_ACCESS_TOKEN: 'gh' },
  },
]

describe('golden credential resolution (byte-identical to retired MAPPING)', () => {
  beforeEach(() => {
    setPackageCookieEnvSource(() => new Map([['bilibili', 'BILIBILI_COOKIE_{DedeUserID}']]))
  })
  afterEach(() => setPackageCookieEnvSource(() => new Map()))

  for (const tc of CASES) {
    it(tc.label, async () => {
      const p = new CookieProvider(source({ [tc.domain]: tc.cookies }))
      const r = await p.resolve(tc.auth)
      expect(r).not.toBeNull()
      expect(r!.envOverrides).toEqual(tc.expected)
    })
  }
})
