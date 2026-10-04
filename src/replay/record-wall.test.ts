import { describe, it, expect, vi } from 'vitest'
import { runBrowserRecipe } from './browser-drive.ts'
import { type PageDriver } from './actions.ts'
import type { BrowserRecipe, LoginCheck } from './recipe.ts'
import type { ReplayLauncher } from './browser-fetch.ts'
import { runValidate } from './author/validate.ts'

const loginCheck: LoginCheck = { loggedIn: '.me', wall: '.login-wall' }

function baseDriver(exists: PageDriver['exists'], extra: Partial<PageDriver> = {}): PageDriver {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    scrollOnce: vi.fn().mockResolvedValue(undefined),
    openItem: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(true),
    back: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    exists,
    readItems: vi.fn().mockResolvedValue([{ noteId: '1', title: 't' }, { noteId: '2', title: 't2' }, { noteId: '3', title: 't3' }]),
    moveMouse: vi.fn().mockResolvedValue(undefined),
    ...extra,
  }
}

const domRecipe: BrowserRecipe = {
  version: 1, kind: 'browser', sourceId: 'rec', cookieDomain: 'example.com',
  entryUrl: 'https://example.com/feed', loginCheck,
  actions: [{ kind: 'scroll', dwell_s: [0, 0], maxTimes: 10, noProgressStop: 3 }],
  harvest: { mode: 'dom', itemSelector: '.card', fields: { noteId: { attr: 'data-id' }, title: { selector: '.t' } }, dedupeBy: 'noteId', targetCount: 3 },
}

function launcherOf(): ReplayLauncher {
  return { launch: vi.fn().mockResolvedValue({ page: {} as any, rawPage: {}, close: vi.fn().mockResolvedValue(undefined) }) }
}

describe('record-mode wall handling — pause / prompt / resume', () => {
  it('wall at entry → onWall resumes after login → harvest proceeds (not needsLogin), prompted once', async () => {
    let loggedIn = false
    const driver = baseDriver(vi.fn().mockImplementation(async (sel: string) => {
      if (sel === '.login-wall') return !loggedIn
      if (sel === '.me') return loggedIn
      return false
    }))
    const onWall = vi.fn().mockImplementation(async () => { loggedIn = true; return 'resume' as const })

    const outcome = await runBrowserRecipe(domRecipe, {}, launcherOf(), 1, () => driver, { onWall })

    expect(onWall).toHaveBeenCalledTimes(1)
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items.length).toBe(3)
  })

  it('wall at entry → onWall resumes but still walled → needsLogin, prompted once', async () => {
    const driver = baseDriver(vi.fn().mockImplementation(async (sel: string) => sel === '.login-wall'))
    const onWall = vi.fn().mockResolvedValue('resume' as const) // operator did not actually log in

    const outcome = await runBrowserRecipe(domRecipe, {}, launcherOf(), 1, () => driver, { onWall })

    expect(onWall).toHaveBeenCalledTimes(1)
    expect(outcome.outcome).toBe('needsLogin')
  })

  it('wall at entry → onWall aborts → needsLogin', async () => {
    const driver = baseDriver(vi.fn().mockImplementation(async (sel: string) => sel === '.login-wall'))
    const onWall = vi.fn().mockResolvedValue('abort' as const)

    const outcome = await runBrowserRecipe(domRecipe, {}, launcherOf(), 1, () => driver, { onWall })

    expect(outcome.outcome).toBe('needsLogin')
  })

  it('wall appears mid-run → onWall resumes → scrolling continues (not needsLogin), prompted once', async () => {
    // logged in at entry; wall pops on the 2nd scroll tick; operator clears it on prompt
    let walled = false
    let ticks = 0
    const driver = baseDriver(
      vi.fn().mockImplementation(async (sel: string) => {
        if (sel === '.login-wall') return walled
        if (sel === '.me') return !walled
        return false
      }),
      {
        scrollOnce: vi.fn().mockImplementation(async () => { if (++ticks === 2) walled = true }),
        // never enough unique cards to hit targetCount from readItems default (3 unique) —
        // so the run continues scrolling and the mid-run wall is exercised
        readItems: vi.fn().mockResolvedValue([{ noteId: '1', title: 't' }]),
      },
    )
    const onWall = vi.fn().mockImplementation(async () => { walled = false; return 'resume' as const })

    const outcome = await runBrowserRecipe(domRecipe, {}, launcherOf(), 1, () => driver, { onWall })

    expect(onWall).toHaveBeenCalledTimes(1)
    expect(outcome.outcome).not.toBe('needsLogin') // resumed, did not abort to needsLogin
  })

  it('replay mode (no onWall) → wall at entry is needsLogin (unchanged)', async () => {
    const driver = baseDriver(vi.fn().mockImplementation(async (sel: string) => sel === '.login-wall'))
    const outcome = await runBrowserRecipe(domRecipe, {}, launcherOf(), 1, () => driver)
    expect(outcome.outcome).toBe('needsLogin')
  })
})

describe('runValidate threads onWall into runBrowserRecipe (record driver)', () => {
  it('passes the DI onWall through as the 6th arg', async () => {
    const onWall = vi.fn().mockResolvedValue('resume' as const)
    const runBrowser = vi.fn().mockResolvedValue({ outcome: 'ok', items: [1, 2, 3], trace: [], seed: 1, driftReason: null })
    const recipe: BrowserRecipe = domRecipe
    await runValidate('rec', {
      store: { load: () => recipe },
      runBrowser: runBrowser as any,
      launch: (() => ({ launch: vi.fn() })) as any,
      lock: async () => ({ release: async () => undefined }),
      onWall,
    })
    const passedHooks = runBrowser.mock.calls[0][5]
    expect(passedHooks.onWall).toBe(onWall)
  })
})
