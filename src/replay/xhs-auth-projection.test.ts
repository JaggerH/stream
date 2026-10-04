import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { recipeToManifest } from './recipe-manifest.ts'
import { isSessionAuth } from '../manifest/types.ts'

describe('xhs recipes declare session/qr auth', () => {
  for (const id of ['xhs-home', 'xhs-search', 'xhs-detail']) {
    it(`projects ${id} to a session-auth manifest`, () => {
      const recipe = JSON.parse(readFileSync(`packages/xhs/${id}.recipe.json`, 'utf8'))
      const m = recipeToManifest(recipe, 'xhs', '@streamapp/xhs')
      expect(isSessionAuth(m.auth)).toBe(true)
      if (isSessionAuth(m.auth) && m.auth.login === 'qr') {
        expect(m.auth.facility).toBe('xhs')
        expect(m.auth.loginUrl.length).toBeGreaterThan(0)
        expect(m.auth.qrSelector.length).toBeGreaterThan(0)
      } else {
        throw new Error('xhs recipes must project to session/qr auth')
      }
    })
  }
})
