import { describe, expect, it } from 'vitest'
import type { BrowserRecipe } from './recipe.ts'
import { canonicalizeBrowserRecipe } from './recipe-canonical.ts'

const base = {
  version: 1,
  kind: 'browser' as const,
  sourceId: 'feed',
  cookieDomain: 'example.com',
  entryUrl: 'https://example.com/',
  loginCheck: { loggedIn: '.me', wall: '.wall' },
  actions: [{ kind: 'scroll' as const, dwell_s: [1, 2] as [number, number], maxTimes: 2, noProgressStop: 1 }],
}

describe('canonicalizeBrowserRecipe', () => {
  it('turns an xhr harvest into a bounded network observer without changing output mapping', () => {
    const recipe: BrowserRecipe = {
      ...base,
      harvest: {
        urlPattern: '*/feed*', itemsAt: 'data.items', dedupeBy: 'id', targetCount: 20,
        mapping: { guid: 'id' }, assert: [{ path: 'data.items', desc: 'items' }],
      },
    }
    const got = canonicalizeBrowserRecipe(recipe)
    expect(got.session).toEqual({ facility: 'example.com', lifecycle: 'one-shot', visibility: 'unattended' })
    expect(got.observers).toEqual([{ kind: 'network', urlPattern: '*/feed*', windowMs: 30_000, maxBodyBytes: 2_097_152 }])
    expect(got.output).toMatchObject({ itemsAt: 'data.items', dedupeBy: 'id', targetCount: 20, mapping: { guid: 'id' } })
  })

  it('turns eval harvest into an executable evaluate step, never a fake observer', () => {
    const recipe: BrowserRecipe = {
      ...base,
      actions: [],
      harvest: {
        mode: 'eval', call: 'async()=>({items:[],cursor:""})', itemsAt: 'items', cursorField: 'cursor',
        dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' }, pageSize: 1, maxPages: 2,
      },
    }
    const got = canonicalizeBrowserRecipe(recipe)
    expect(got.observers).toEqual([])
    expect(got.steps).toEqual([expect.objectContaining({ kind: 'evaluate', itemsAt: 'items', cursorField: 'cursor', pageSize: 1, maxPages: 2 })])
  })

  it('uses manifest facility identity instead of deriving it from transport details', () => {
    const recipe: BrowserRecipe = {
      ...base,
      meta: { facility: { key: 'xhs', label: '小红书' } },
      harvest: { mode: 'state', statePath: '__STATE__.items', dedupeBy: 'id', targetCount: 2, mapping: { guid: 'id' } },
    }
    expect(canonicalizeBrowserRecipe(recipe).session.facility).toBe('xhs')
  })
})
