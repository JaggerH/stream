import { describe, it, expect } from 'vitest'
import type { Recipe, BrowserRecipe } from './recipe.ts'

describe('recipe kind union', () => {
  it('narrows on kind', () => {
    const c: BrowserRecipe = {
      version: 1, kind: 'browser', sourceId: 's', cookieDomain: 'x.com',
      entryUrl: 'https://x.com/', loginCheck: { loggedIn: '.me', wall: '.login-wall' },
      actions: [{ kind: 'goto', url: 'https://x.com/' }],
      harvest: { urlPattern: '*/feed*', dedupeBy: 'id', itemsAt: 'data', targetCount: 100, mapping: {}, assert: [] },
    }
    const r: Recipe = c
    expect(r.kind === 'browser' && r.actions.length).toBe(1)
  })
})
