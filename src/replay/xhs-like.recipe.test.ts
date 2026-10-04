import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RecipeRunner } from './recipe-runner.ts'
import type { PageDriver } from './actions.ts'
import type { CanonicalBrowserRecipe } from './recipe.ts'

// The on-disk互动 recipe (点赞/收藏). Loading the real file guards against JSON breakage and
// pins the recon-confirmed constants (each action's endpoint fn + body key) into a test —
// those body keys differ per action and were measured live, not guessed (spec 2026-07-18 §7.1).
const recipe = JSON.parse(
  readFileSync(new URL('../../packages/xhs/xhs-like.recipe.json', import.meta.url), 'utf-8'),
) as CanonicalBrowserRecipe

function fakeDriver(overrides: Partial<PageDriver> = {}): PageDriver {
  return {
    exists: async (selector) => selector === '.main-container .user', // loginCheck.loggedIn
    readItems: async () => [],
    goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
    type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {},
    ...overrides,
  }
}

describe('xhs-like recipe', () => {
  it('is a canonical single-evaluate recipe with a targetCount-1 output', () => {
    expect(recipe.sourceId).toBe('xhs-like')
    expect(recipe.steps).toHaveLength(1)
    expect(recipe.steps[0].kind).toBe('evaluate')
    expect(recipe.output.targetCount).toBe(1)
    expect(recipe.output.mapping).toMatchObject({ noteId: 'noteId', action: 'action', ok: 'ok' })
  })

  it('pins the recon-confirmed endpoint fns and per-action body keys in the call body', () => {
    const call = (recipe.steps[0] as { call: string }).call
    // fn names — keyed off semantic strings so the call survives re-minification (never a module id)
    expect(call).toContain('postApiSnsWebV1NoteLike')
    expect(call).toContain('postApiSnsWebV1NoteDislike')
    expect(call).toContain('postApiSnsWebV1NoteCollect')
    expect(call).toContain('postApiSnsWebV1NoteUncollect')
    // body keys differ per action (measured live) — like/unlike=note_oid, collect=note_id, uncollect=note_ids
    expect(call).toContain('note_oid')
    expect(call).toContain('note_id')
    expect(call).toContain('note_ids')
    expect(call).not.toContain('25717') // the module id must NOT be hardcoded
  })

  it('maps the in-page evaluate result through output → {noteId, action, ok}', async () => {
    // the call returns { items: [{ noteId, action, ok }] }; evalJson replays that body.
    const evalJson = async () => ({ items: [{ noteId: 'n1', action: 'like', ok: true }] })
    const outcome = await new RecipeRunner().run(recipe, { noteId: 'n1', action: 'like' }, fakeDriver({ evalJson }))
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([{ noteId: 'n1', action: 'like', ok: true }])
  })

  it('surfaces an in-page throw (business/risk-control error) as a failed run, not an empty ok', async () => {
    // a rejected interaction (e.g. "该笔记暂不支持收藏") must fail the run so the endpoint/frontend rolls back.
    const evalJson = async () => { throw new Error('该笔记暂不支持收藏') }
    const outcome = await new RecipeRunner().run(recipe, { noteId: 'n1', action: 'collect' }, fakeDriver({ evalJson }))
    expect(outcome.outcome).not.toBe('ok')
  })
})
