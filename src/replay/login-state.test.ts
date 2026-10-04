import { describe, it, expect, vi } from 'vitest'
import { detectLoginState, type PageDriver } from './actions.ts'
import { runBrowserRecipe } from './browser-drive.ts'
import type { BrowserRecipe, LoginCheck } from './recipe.ts'
import type { ReplayLauncher } from './browser-fetch.ts'

const loginCheck: LoginCheck = { loggedIn: '.me', wall: '.login-wall' }

/** A PageDriver stub where selector presence is a fixed set. */
function stubDriver(present: Set<string>, extra: Partial<PageDriver> = {}): PageDriver {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    scrollOnce: vi.fn().mockResolvedValue(undefined),
    openItem: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(true),
    back: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation(async (sel: string) => present.has(sel)),
    moveMouse: vi.fn().mockResolvedValue(undefined),
    ...extra,
  }
}

describe('detectLoginState — three-state classification', () => {
  it('两个判据都不在 → 再看一眼才定案（弹窗还没画出来是常态，不是"这页没有登录"）', async () => {
    // 活体：探针里出现过 `login 3ms` —— 页面刚导航完、登录弹窗还没渲染，两个选择器都不命中，
    // 判成 UNKNOWN 让 recipe 照常往下跑，在一个只有登录墙的页面上白滚二十轮。
    let round = 0
    const d = stubDriver(new Set(), {
      exists: vi.fn().mockImplementation(async (sel: string) => round > 0 && sel === '.login-wall'),
      sleep: vi.fn().mockImplementation(async () => { round++ }),
    })
    expect(await detectLoginState(d, loginCheck)).toBe('WALLED')
    expect(d.sleep).toHaveBeenCalledTimes(1)
  })

  it('第一眼就有结论 → 一次都不等（健康路径不该为这个竞态付钱）', async () => {
    const d = stubDriver(new Set(['.me']))
    expect(await detectLoginState(d, loginCheck)).toBe('LOGGED_IN')
    expect(d.sleep).not.toHaveBeenCalled()
  })

  it('再看一眼还是判不出来 → 仍然 UNKNOWN，不硬凑一个结论', async () => {
    const d = stubDriver(new Set())
    expect(await detectLoginState(d, loginCheck)).toBe('UNKNOWN')
    expect(d.sleep).toHaveBeenCalledTimes(1)
  })

  it('loggedIn present, wall absent → LOGGED_IN', async () => {
    expect(await detectLoginState(stubDriver(new Set(['.me'])), loginCheck)).toBe('LOGGED_IN')
  })
  it('wall present → WALLED (even if loggedIn also present — wall wins)', async () => {
    expect(await detectLoginState(stubDriver(new Set(['.login-wall'])), loginCheck)).toBe('WALLED')
    expect(await detectLoginState(stubDriver(new Set(['.me', '.login-wall'])), loginCheck)).toBe('WALLED')
  })
  it('neither present → UNKNOWN', async () => {
    expect(await detectLoginState(stubDriver(new Set()), loginCheck)).toBe('UNKNOWN')
  })
})

const domRecipe: BrowserRecipe = {
  version: 1,
  kind: 'browser',
  sourceId: 'wall-test',
  cookieDomain: 'example.com',
  entryUrl: 'https://example.com/feed',
  loginCheck,
  actions: [{ kind: 'scroll', dwell_s: [0, 0], maxTimes: 10, noProgressStop: 3 }],
  harvest: {
    mode: 'dom',
    itemSelector: '.card',
    fields: { noteId: { attr: 'data-id' }, title: { selector: '.t' } },
    dedupeBy: 'noteId',
    targetCount: 5,
  },
}

function launcherOf(): { launcher: ReplayLauncher; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn().mockResolvedValue(undefined)
  const launcher: ReplayLauncher = {
    launch: vi.fn().mockResolvedValue({ page: {} as any, rawPage: {}, close }),
  }
  return { launcher, close }
}

describe('runBrowserRecipe — login wall aborts to needsLogin, never drift', () => {
  it('wall at entry → needsLogin, actions never run', async () => {
    const { launcher } = launcherOf()
    const driver = stubDriver(new Set(['.login-wall'])) // walled from the start
    const outcome = await runBrowserRecipe(domRecipe, {}, launcher, 1, () => driver)
    expect(outcome.outcome).toBe('needsLogin')
    expect(driver.scrollOnce).not.toHaveBeenCalled()
  })

  it('UNKNOWN at entry (neither signal, e.g. slow hydration) is NOT walled — actions run, resolves as drift not a false needsLogin', async () => {
    const { launcher } = launcherOf()
    const driver = stubDriver(new Set()) // neither signal → UNKNOWN
    const outcome = await runBrowserRecipe(domRecipe, {}, launcher, 1, () => driver)
    // A logged-in session whose signal hasn't painted must not be bounced to login;
    // only a positive wall short-circuits. With no cards it honestly resolves as drift.
    expect(driver.scrollOnce).toHaveBeenCalled()
    expect(outcome.outcome).toBe('drift')
  })

  it('wall appears mid-run → aborts scrolling, needsLogin (not drift)', async () => {
    const { launcher } = launcherOf()
    // logged in at entry; the wall pops up on the 2nd scroll tick and never yields cards
    let walled = false
    let ticks = 0
    const driver = stubDriver(new Set(['.me']), {
      exists: vi.fn().mockImplementation(async (sel: string) => {
        if (sel === '.login-wall') return walled
        if (sel === '.me') return !walled
        return false
      }),
      scrollOnce: vi.fn().mockImplementation(async () => { if (++ticks >= 2) walled = true }),
      readItems: vi.fn().mockResolvedValue([]),
    })
    const outcome = await runBrowserRecipe(domRecipe, {}, launcher, 1, () => driver)
    expect(outcome.outcome).toBe('needsLogin')
    expect(outcome.driftReason).toBeNull()
    // aborted early — did not grind to maxTimes (10)
    expect((driver.scrollOnce as any).mock.calls.length).toBeLessThan(10)
  })

  it('stays logged in but no cards → drift (wall check passes, so it is genuine drift)', async () => {
    const { launcher } = launcherOf()
    const driver = stubDriver(new Set(['.me']), { readItems: vi.fn().mockResolvedValue([]) })
    const outcome = await runBrowserRecipe(domRecipe, {}, launcher, 1, () => driver)
    expect(outcome.outcome).toBe('drift')
    expect(outcome.driftReason).toBe('no cards matched itemSelector')
  })
})
