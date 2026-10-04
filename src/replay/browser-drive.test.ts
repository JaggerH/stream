import { describe, it, expect, vi } from 'vitest'
import { runBrowserRecipe } from './browser-drive.ts'
import type { BrowserRecipe } from './recipe.ts'
import type { ReplayLauncher } from './browser-fetch.ts'
import { FeatureDriftError, type PageDriver } from './actions.ts'

const mockRecipe: BrowserRecipe = {
  version: 1,
  kind: 'browser',
  sourceId: 'test-source',
  cookieDomain: 'example.com',
  entryUrl: 'https://example.com/feed',
  loginCheck: { loggedIn: '.logged-in', wall: '.login-wall' },
  actions: [
    { kind: 'goto', url: 'https://example.com/feed' }
  ],
  harvest: {
    urlPattern: '*/feed*',
    dedupeBy: 'id',
    itemsAt: 'data',
    targetCount: 2,
    mapping: { title: 'name' },
    assert: []
  }
}

class FakePage {
  listeners: Record<string, Function[]> = {}
  on(event: string, callback: Function) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(callback)
  }
  off(event: string, callback: Function) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback)
    }
  }
  emit(event: string, ...args: any[]) {
    if (this.listeners[event]) {
      for (const cb of this.listeners[event]) {
        cb(...args)
      }
    }
  }
}

describe('runBrowserRecipe unit tests', () => {
  it('① response matching urlPattern is read on arrival and fed to accumulator (items appear in outcome)', async () => {
    const fakePage = new FakePage()
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    const launcher: ReplayLauncher = {
      launch: vi.fn().mockResolvedValue({
        page: {} as any,
        rawPage: fakePage,
        close: closeSpy
      })
    }

    const mockDriver = {
      goto: vi.fn().mockResolvedValue(undefined),
      scrollOnce: vi.fn().mockResolvedValue(undefined),
      openItem: vi.fn().mockResolvedValue(undefined),
      back: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      submit: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (sel) => sel === '.logged-in')
    }

    // Trigger response event during driver.goto call
    mockDriver.goto.mockImplementation(async () => {
      fakePage.emit('response', {
        url: () => 'https://example.com/feed/data',
        json: async () => ({
          data: [
            { id: '1', name: 'item1' },
            { id: '2', name: 'item2' }
          ]
        })
      })
    })

    const outcome = await runBrowserRecipe(
      mockRecipe,
      {},
      launcher,
      12345,
      () => mockDriver as any
    )

    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([
      { title: 'item1' },
      { title: 'item2' }
    ])
    expect(outcome.seed).toBe(12345)
    expect(closeSpy).toHaveBeenCalled()
  })

  it('② a wall at entry → needsLogin without running actions', async () => {
    const fakePage = new FakePage()
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    const launcher: ReplayLauncher = {
      launch: vi.fn().mockResolvedValue({
        page: {} as any,
        rawPage: fakePage,
        close: closeSpy
      })
    }

    // Walled from the start (loggedIn signal absent, wall present). Only a positive
    // wall short-circuits at entry — UNKNOWN would proceed (see test ③).
    const mockDriver = {
      goto: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (sel: string) => sel === '.login-wall')
    }

    const outcome = await runBrowserRecipe(
      mockRecipe,
      {},
      launcher,
      undefined,
      () => mockDriver as any
    )

    expect(outcome.outcome).toBe('needsLogin')
    expect(mockDriver.goto).not.toHaveBeenCalled()
    expect(closeSpy).toHaveBeenCalled()
  })

  it('③ zero matched responses → drift; a vanished loggedIn signal WITHOUT a wall stays drift (only a wall → needsLogin)', async () => {
    const fakePage = new FakePage()
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    const launcher: ReplayLauncher = {
      launch: vi.fn().mockResolvedValue({
        page: {} as any,
        rawPage: fakePage,
        close: closeSpy
      })
    }

    // Logged in at entry; by the before-drift recheck the loggedIn signal is gone but
    // no wall is present (UNKNOWN). This must stay drift — reclassifying UNKNOWN as
    // needsLogin would mask genuine drift and skip quarantine. Only a positive wall
    // overrides drift (covered by the entry-wall and mid-run-wall tests).
    let loggedInQueries = 0
    const mockDriver = {
      goto: vi.fn().mockResolvedValue(undefined),
      // detectLoginState 判不出来时会再看一眼（弹窗还没画出来是常态），所以桩必须有 sleep。
      sleep: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (sel: string) => {
        if (sel === '.login-wall') return false
        if (sel === '.logged-in') { loggedInQueries++; return loggedInQueries === 1 }
        return false
      })
    }

    const outcome = await runBrowserRecipe(
      mockRecipe,
      {},
      launcher,
      undefined,
      () => mockDriver as any
    )

    expect(outcome.outcome).toBe('drift')
    expect(outcome.driftReason).toBe('no response matched urlPattern')
    expect(closeSpy).toHaveBeenCalled()

    // Stays logged in (wall absent) → also drift, same reason.
    loggedInQueries = 0
    mockDriver.exists = vi.fn().mockImplementation(async (sel: string) => sel === '.logged-in')

    const outcomeDrift = await runBrowserRecipe(
      mockRecipe,
      {},
      launcher,
      undefined,
      () => mockDriver as any
    )
    expect(outcomeDrift.outcome).toBe('drift')
    expect(outcomeDrift.driftReason).toBe('no response matched urlPattern')
  })

  it('④ FeatureDriftError from an action → drift', async () => {
    const fakePage = new FakePage()
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    const launcher: ReplayLauncher = {
      launch: vi.fn().mockResolvedValue({
        page: {} as any,
        rawPage: fakePage,
        close: closeSpy
      })
    }

    const mockDriver = {
      goto: vi.fn().mockImplementation(() => {
        throw new FeatureDriftError(0, { selector: '.missing-btn' })
      }),
      exists: vi.fn().mockImplementation(async (sel: string) => sel === '.logged-in')
    }

    const outcome = await runBrowserRecipe(
      mockRecipe,
      {},
      launcher,
      undefined,
      () => mockDriver as any
    )

    expect(outcome.outcome).toBe('drift')
    expect(outcome.driftReason).toContain('Feature drift at step 0')
    expect(closeSpy).toHaveBeenCalled()
  })

  const domRecipe: BrowserRecipe = {
    version: 1,
    kind: 'browser',
    sourceId: 'dom-source',
    cookieDomain: 'example.com',
    entryUrl: 'https://example.com/feed',
    loginCheck: { loggedIn: '.logged-in', wall: '.login-wall' },
    actions: [{ kind: 'scroll', dwell_s: [0, 0], maxTimes: 10, noProgressStop: 3 }],
    harvest: {
      mode: 'dom',
      itemSelector: '.card',
      fields: { noteId: { attr: 'data-id' }, title: { selector: '.t' } },
      dedupeBy: 'noteId',
      targetCount: 3,
    },
  }

  it('⑥ DOM harvest: cards pulled per scroll tick, deduped across recycled nodes, stops at targetCount', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    const launcher: ReplayLauncher = {
      launch: vi.fn().mockResolvedValue({ page: {} as any, rawPage: new FakePage(), close: closeSpy }),
    }
    // initial tick + per-scroll ticks; virtualized list recycles nodes
    const batches = [
      [{ noteId: '1', title: 't1' }],
      [{ noteId: '1', title: 't1' }, { noteId: '2', title: 't2' }],
      [{ noteId: '2', title: 't2' }, { noteId: '3', title: 't3' }],
    ]
    let call = 0
    const mockDriver = {
      goto: vi.fn().mockResolvedValue(undefined),
      scrollOnce: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (sel: string) => sel === '.logged-in'),
      readItems: vi.fn().mockImplementation(async () => batches[Math.min(call++, batches.length - 1)]),
    }

    const outcome = await runBrowserRecipe(domRecipe, {}, launcher, 111, () => mockDriver as any)

    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([
      { noteId: '1', title: 't1' },
      { noteId: '2', title: 't2' },
      { noteId: '3', title: 't3' },
    ])
    expect(mockDriver.readItems).toHaveBeenCalledWith('.card', domRecipe.harvest.mode === 'dom' ? (domRecipe.harvest as any).fields : {})
  })

  it('⑦ DOM harvest: itemSelector never matches → drift "no cards matched itemSelector"', async () => {
    const launcher: ReplayLauncher = {
      launch: vi.fn().mockResolvedValue({ page: {} as any, rawPage: new FakePage(), close: vi.fn().mockResolvedValue(undefined) }),
    }
    const mockDriver = {
      goto: vi.fn().mockResolvedValue(undefined),
      scrollOnce: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (sel: string) => sel === '.logged-in'),
      readItems: vi.fn().mockResolvedValue([]),
    }

    const outcome = await runBrowserRecipe(domRecipe, {}, launcher, 222, () => mockDriver as any)

    expect(outcome.outcome).toBe('drift')
    expect(outcome.driftReason).toBe('no cards matched itemSelector')
  })

  it('⑤ same seed → same outcome.seed echoed', async () => {
    const fakePage = new FakePage()
    const launcher: ReplayLauncher = {
      launch: vi.fn().mockResolvedValue({
        page: {} as any,
        rawPage: fakePage,
        close: vi.fn()
      })
    }
    const mockDriver = {
      goto: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (sel: string) => sel === '.logged-in')
    }

    const outcome = await runBrowserRecipe(
      mockRecipe,
      {},
      launcher,
      98765,
      () => mockDriver as any
    )
    expect(outcome.seed).toBe(98765)
  })
})

describe('runBrowserRecipe — state harvest (SSR read)', () => {
  const stateRecipe: BrowserRecipe = {
    version: 2,
    kind: 'browser',
    sourceId: 'xhs-home',
    cookieDomain: 'xiaohongshu.com',
    entryUrl: 'https://www.xiaohongshu.com/explore',
    loginCheck: { loggedIn: '.logged-in', wall: '.login-wall' },
    actions: [],
    harvest: {
      mode: 'state',
      statePath: '__INITIAL_STATE__.feed.feeds',
      dedupeBy: 'id',
      targetCount: 40,
      mapping: {
        note_id: 'id',
        title: 'noteCard.displayTitle',
        note_type: 'noteCard.type',
        cover: 'noteCard.cover.urlDefault',
        link: 'https://www.xiaohongshu.com/explore/{id}?xsec_token={xsecToken}',
      },
      assert: [{ path: 'items', desc: 'feeds present' }],
    },
  }

  const feeds = [
    { id: 'n1', xsecToken: 'T1', noteCard: { type: 'normal', displayTitle: 'photo', cover: { urlDefault: 'http://c/1.jpg' } } },
    { id: 'n2', xsecToken: 'T2', noteCard: { type: 'video', displayTitle: 'vid', cover: { urlDefault: 'http://c/2.jpg' } } },
  ]

  function driverWithState(state: unknown) {
    return {
      goto: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (sel: string) => sel === '.logged-in'),
      readState: vi.fn().mockResolvedValue(state),
    } as unknown as PageDriver
  }

  const launcherOf = () => ({
    launch: vi.fn().mockResolvedValue({ page: {} as any, rawPage: new FakePage(), close: vi.fn().mockResolvedValue(undefined) }),
  }) as ReplayLauncher

  it('reads the SSR array once (no scroll) and maps every note, composing the link', async () => {
    const driver = driverWithState(feeds)
    const outcome = await runBrowserRecipe(stateRecipe, {}, launcherOf(), 1, () => driver)
    expect(outcome.outcome).toBe('ok')
    expect(driver.readState).toHaveBeenCalledWith('__INITIAL_STATE__.feed.feeds')
    expect(driver.readState).toHaveBeenCalledTimes(1) // one-shot; state mode never scrolls
    expect(outcome.items).toEqual([
      { note_id: 'n1', title: 'photo', note_type: 'normal', cover: 'http://c/1.jpg', link: 'https://www.xiaohongshu.com/explore/n1?xsec_token=T1' },
      { note_id: 'n2', title: 'vid', note_type: 'video', cover: 'http://c/2.jpg', link: 'https://www.xiaohongshu.com/explore/n2?xsec_token=T2' },
    ])
  })

  it('a non-array state (shape moved / logged-out shell) trips drift, not a silent empty harvest', async () => {
    const outcome = await runBrowserRecipe(stateRecipe, {}, launcherOf(), 1, () => driverWithState(undefined))
    expect(outcome.outcome).toBe('drift')
    expect(outcome.items).toEqual([])
  })
})

describe('runBrowserRecipe — eval harvest (in-page signed request client)', () => {
  const evalRecipe: BrowserRecipe = {
    version: 1,
    kind: 'browser',
    sourceId: 'eval-compat-feed',
    cookieDomain: 'xiaohongshu.com',
    entryUrl: 'https://www.xiaohongshu.com/explore',
    loginCheck: { loggedIn: '.logged-in', wall: '.login-wall' },
    actions: [],
    harvest: {
      mode: 'eval',
      call: 'async (c, n) => ({ items: [], cursor: "" })',
      itemsAt: 'items',
      cursorField: 'cursor',
      dedupeBy: 'id', // raw-item path, NOT a mapped output name
      targetCount: 3,
      pageSize: 2,
      maxPages: 10,
      mapping: {
        note_id: 'id',
        title: 'noteCard.displayTitle',
        note_type: 'noteCard.type',
        cover: 'noteCard.cover.urlDefault',
        link: 'https://www.xiaohongshu.com/explore/{id}?xsec_token={xsecToken}',
      },
    },
  }

  const note = (id: string) => ({
    id,
    xsecToken: 'T' + id,
    noteCard: { type: 'normal', displayTitle: 'title-' + id, cover: { urlDefault: 'http://c/' + id } },
  })

  // fake driver whose evalJson replays queued page bodies (an Error entry throws in-page)
  function driverWithPages(pages: unknown[]) {
    const exprs: string[] = []
    let i = 0
    const evalJson = vi.fn().mockImplementation(async (expr: string) => {
      exprs.push(expr)
      const p = pages[Math.min(i, pages.length - 1)]
      i++
      if (p instanceof Error) throw p
      return p
    })
    const driver = {
      goto: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation(async (sel: string) => sel === '.logged-in'),
      evalJson,
    } as unknown as PageDriver
    return { driver, exprs, calls: () => i }
  }

  const launcherOf = () => ({
    launch: vi.fn().mockResolvedValue({ page: {} as any, rawPage: new FakePage(), close: vi.fn().mockResolvedValue(undefined) }),
  }) as ReplayLauncher

  it('pages via the returned cursor, dedupes across pages, maps items, stops at targetCount', async () => {
    const { driver, exprs, calls } = driverWithPages([
      { items: [note('n1'), note('n2')], cursor: 'c1' },
      { items: [note('n2'), note('n3')], cursor: 'c2' }, // n2 repeats
    ])
    const outcome = await runBrowserRecipe(evalRecipe, {}, launcherOf(), 1, () => driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls()).toBe(2) // targetCount 3 reached after page 2 — no third call
    // first page threads the empty cursor, second threads what page 1 returned; the 3rd arg is
    // the recipe run params (empty here) — a detail eval reads noteId/xsec_token from it.
    expect(exprs[0]).toContain('("",2,{})')
    expect(exprs[1]).toContain('("c1",2,{})')
    expect(outcome.items).toEqual([
      { note_id: 'n1', title: 'title-n1', note_type: 'normal', cover: 'http://c/n1', link: 'https://www.xiaohongshu.com/explore/n1?xsec_token=Tn1' },
      { note_id: 'n2', title: 'title-n2', note_type: 'normal', cover: 'http://c/n2', link: 'https://www.xiaohongshu.com/explore/n2?xsec_token=Tn2' },
      { note_id: 'n3', title: 'title-n3', note_type: 'normal', cover: 'http://c/n3', link: 'https://www.xiaohongshu.com/explore/n3?xsec_token=Tn3' },
    ])
  })

  it('an in-page throw (e.g. xhs 300011 风控) with nothing harvested trips drift, never a silent empty ok', async () => {
    const { driver } = driverWithPages([new Error('xhs api code 300011 账号异常')])
    const outcome = await runBrowserRecipe(evalRecipe, {}, launcherOf(), 1, () => driver)
    expect(outcome.outcome).toBe('drift')
    expect(outcome.driftReason).toContain('300011')
    expect(outcome.items).toEqual([])
  })

  it('an in-page throw AFTER a partial harvest hands back the partial as ok (not drift)', async () => {
    const { driver } = driverWithPages([
      { items: [note('n1')], cursor: 'c1' },
      new Error('boom mid-run'),
    ])
    const outcome = await runBrowserRecipe({ ...evalRecipe, harvest: { ...evalRecipe.harvest, targetCount: 5 } }, {}, launcherOf(), 1, () => driver)
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items.map((i: any) => i.note_id)).toEqual(['n1'])
  })

  it('stops after two consecutive fresh-0 pages (a repeating recommendation stream never reaches targetCount)', async () => {
    const { driver, calls } = driverWithPages([
      { items: [note('n1')], cursor: 'c1' },
      { items: [note('n1')], cursor: 'c2' }, // dup → fresh 0
      { items: [note('n1')], cursor: 'c3' }, // dup → fresh 0 → stop
      { items: [note('n9')], cursor: 'c4' }, // must never be reached
    ])
    const outcome = await runBrowserRecipe({ ...evalRecipe, harvest: { ...evalRecipe.harvest, targetCount: 5 } }, {}, launcherOf(), 1, () => driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls()).toBe(3)
    expect(outcome.items.map((i: any) => i.note_id)).toEqual(['n1'])
  })
})
