import { describe, it, expect, vi } from 'vitest'

// `cookieNames` 是 login detect 便宜的那一半：会话 cookie 一个都不在 ⇒ 一定没登录，后端据此
// 直接 decline，连 tab 都不用开。经导出的 dispatch 走真实协议路径。
//
// 硬边界：**只回名字，不回值**。理由是最小权限——登录探测只需要"会话 cookie 在不在"，那就
// 只给这一点。值有它自己的口（`cookiePull`，见 driver.cookiepull.test.ts），带范围闸。
// 下面第二个用例是这条边界的回归锁：别图省事让 cookieNames 顺手把值也捎回来。
function makeChrome(cookies: Array<{ name: string; value: string; domain: string }>) {
  return {
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
    cookies: {
      getAll: vi.fn(async ({ domain }: { domain: string }) =>
        cookies.filter((c) => c.domain === domain || c.domain === '.' + domain),
      ),
    },
    tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    tabGroups: { onRemoved: { addListener: vi.fn() } },
    debugger: { onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
    runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
  }
}

async function load(cookies: Array<{ name: string; value: string; domain: string }>) {
  vi.stubGlobal('chrome', makeChrome(cookies))
  vi.resetModules()
  return await import('./driver.ts')
}

describe('dispatch op:cookieNames', () => {
  it('returns the cookie names present for a domain', async () => {
    const { dispatch } = await load([
      { name: 'web_session', value: 'secret-abc', domain: '.xiaohongshu.com' },
      { name: 'a1', value: 'secret-def', domain: '.xiaohongshu.com' },
      { name: 'other', value: 'x', domain: '.example.com' },
    ])
    const res = await dispatch({ id: 1, op: 'cookieNames', domain: 'xiaohongshu.com' })
    expect(res.id).toBe(1)
    expect((res.result as { names: string[] }).names.sort()).toEqual(['a1', 'web_session'])
  })

  it('NEVER returns cookie values — 值有自己的口（cookiePull），这里只给名字', async () => {
    const { dispatch } = await load([
      { name: 'web_session', value: 'secret-abc', domain: '.xiaohongshu.com' },
    ])
    const res = await dispatch({ id: 2, op: 'cookieNames', domain: 'xiaohongshu.com' })
    expect(JSON.stringify(res)).not.toContain('secret-abc')
  })

  it('a domain with no cookies is an empty list, not an error', async () => {
    // 「一个都没有」正是最有信息量的答案（一定没登录），必须是正常返回而不是失败。
    const { dispatch } = await load([])
    const res = await dispatch({ id: 3, op: 'cookieNames', domain: 'xiaohongshu.com' })
    expect(res.error).toBeUndefined()
    expect((res.result as { names: string[] }).names).toEqual([])
  })
})
