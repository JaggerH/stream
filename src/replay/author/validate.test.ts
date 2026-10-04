import { describe, it, expect } from 'vitest'
import { formatReport, runValidate } from './validate.ts'
import type { Recipe, BrowserRecipe } from '../recipe.ts'
import type { RunBrowserOutcome } from '../browser-drive.ts'

const tierC: BrowserRecipe = {
  sourceId: 'juejin',
  version: 1,
  kind: 'browser',
  entryUrl: 'https://juejin.cn/',
  cookieDomain: 'juejin.cn',
  loginCheck: { loggedIn: 'body', wall: '.login-wall' },
  actions: [{ kind: 'scroll', maxTimes: 3, noProgressStop: 2 }],
  harvest: { urlPattern: 'api.juejin.cn', dedupeBy: 'id', itemsAt: 'data', targetCount: 3 },
  mapping: { title: 'title', url: 'url' },
} as unknown as BrowserRecipe

function fakes(outcome: Partial<RunBrowserOutcome>) {
  const calls: Record<string, unknown> = {}
  const result: RunBrowserOutcome = {
    outcome: 'ok',
    items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] as RunBrowserOutcome['items'],
    trace: [],
    seed: 42,
    driftReason: null,
    ...outcome,
  }
  const opts = {
    root: '/tmp/validate-test-root',
    store: { load: (id: string) => { calls.loaded = id; return tierC as Recipe } },
    runBrowser: (async (recipe: BrowserRecipe, params: Record<string, string>, launcher: unknown) => {
      calls.recipe = recipe
      calls.launcher = launcher
      return result
    }) as never,
    launch: ((o: unknown) => { calls.launchOpts = o; return { launch: async () => { throw new Error('unused') } } }) as never,
    lock: async (_root: string, facility: string) => {
      calls.locked = facility
      return { release: async () => { calls.released = true } }
    },
  }
  return { opts, calls }
}

describe('runValidate', () => {
  it('passes when outcome ok and items >= targetCount', async () => {
    const { opts, calls } = fakes({})
    const report = await runValidate('juejin', opts)
    expect(report.ok).toBe(true)
    expect(report.itemCount).toBe(3)
    expect(report.targetCount).toBe(3)
    expect(calls.loaded).toBe('juejin')
    expect(calls.locked).toBe('juejin')
    expect(calls.released).toBe(true)
  })

  it('fails on short harvest even when outcome is ok', async () => {
    const { opts } = fakes({ items: [{ title: 'a' }] as RunBrowserOutcome['items'] })
    const report = await runValidate('juejin', opts)
    expect(report.ok).toBe(false)
    expect(report.itemCount).toBe(1)
  })

  it('fails and reports drift', async () => {
    const { opts } = fakes({ outcome: 'drift', items: [], driftReason: 'selector gone' })
    const report = await runValidate('juejin', opts)
    expect(report.ok).toBe(false)
    expect(report.driftReason).toBe('selector gone')
    expect(formatReport('juejin', report)).toContain('drift=selector gone')
  })

  it('releases the facility lock when runBrowser throws', async () => {
    const { opts, calls } = fakes({})
    opts.runBrowser = (async () => { throw new Error('boom') }) as never
    await expect(runValidate('juejin', opts)).rejects.toThrow('boom')
    expect(calls.released).toBe(true)
  })

  it('rejects fetch recipes', async () => {
    const { opts } = fakes({})
    opts.store = { load: () => ({ kind: 'fetch' } as unknown as Recipe) }
    await expect(runValidate('juejin', opts)).rejects.toThrow(/only browser recipes/)
  })
})

describe('formatReport', () => {
  it('formats PASS line', () => {
    expect(formatReport('juejin', { ok: true, outcome: 'ok', itemCount: 5, targetCount: 3, seed: 7, driftReason: null }))
      .toBe('[record] validate juejin: PASS (outcome=ok items=5/3 seed=7)')
  })
})
