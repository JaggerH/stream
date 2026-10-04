import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it, vi } from 'vitest'
import { validateRecipe } from '../recipe-store.ts'
import { renderRecipeDraftYaml, runTranslate, translateHistory } from './translate.ts'

const HISTORY = {
  history: [
    {
      model_output: { action: [{ navigate: { url: 'https://juejin.cn/' } }] },
      state: {},
    },
    {
      model_output: { action: [{ click_element_by_index: { index: 2 } }] },
      state: { interacted_element: { css_selector: '.feed-card', role: 'link', text: '第三篇文章' } },
    },
    {
      model_output: { action: [{ input_text: { text: 'TypeScript' } }, { search: {} }] },
      state: {
        interacted_element: [
          { css_selector: 'input.search-input', role: 'textbox' },
          { css_selector: 'input.search-input', role: 'textbox' },
        ],
      },
    },
    {
      model_output: { action: [{ scroll: {} }] },
      state: {},
    },
  ],
}

const XHR = [
  {
    url: 'https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed?aid=2608',
    type: 'xhr',
  },
]

describe('translateHistory', () => {
  it('translates browser-use history into a schema-valid Tier-C draft', () => {
    const { recipe, untranslated } = translateHistory(HISTORY, XHR)

    expect(recipe.sourceId).toBe('juejin')
    expect(recipe.cookieDomain).toBe('juejin.cn')
    expect(recipe.entryUrl).toBe('https://juejin.cn/')
    expect(recipe.harvest.urlPattern).toBe('*/recommend_api/v1/article/recommend_all_feed*')
    expect(recipe.harvest.dedupeBy).toBe('article_id')
    expect(recipe.harvest.itemsAt).toBe('data')
    expect(recipe.actions.map((a) => a.kind)).toEqual(['goto', 'type', 'submit', 'scroll'])
    expect(untranslated).toContain('step 1.0: click_element_by_index: dropped ordinal click as replay-unstable')
    expect(() => validateRecipe(recipe.sourceId, recipe)).not.toThrow()
  })

  it('records unknown actions in the UNTRANSLATED comment block', () => {
    const { recipe, untranslated } = translateHistory({
      history: [
        {
          model_output: { action: [{ navigate: { url: 'https://juejin.cn/' } }, { drag: { x: 1 } }] },
          state: {},
        },
      ],
    }, XHR)
    const yaml = renderRecipeDraftYaml(recipe, untranslated)

    expect(untranslated).toContain('step 0.1: drag: no deterministic recipe action mapping')
    expect(yaml).toContain('# UNTRANSLATED:')
    expect(yaml).toContain('# - step 0.1: drag: no deterministic recipe action mapping')
    expect(parseYaml(yaml)).toMatchObject({ kind: 'browser', sourceId: 'juejin' })
  })

  it('fails soft when XHR samples are missing', () => {
    const { recipe, untranslated } = translateHistory(HISTORY)

    expect(recipe.harvest.urlPattern).toBe('TODO: add matched XHR urlPattern')
    expect(recipe.harvest.itemsAt).toBe('TODO.items')
    expect(untranslated).toContain('XHR: missing samples; harvest urlPattern/itemsAt/dedupeBy left as TODO')
    expect(() => validateRecipe(recipe.sourceId, recipe)).not.toThrow()
  })

  it('fails loud at schema validation before writing an invalid draft', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-translate-'))
    const facilityDir = join(root, 'data', 'browser-profiles', 'empty')
    await import('node:fs/promises').then((fs) => fs.mkdir(facilityDir, { recursive: true }))
    writeFileSync(join(facilityDir, 'explore-20260706T010203Z.json'), JSON.stringify({ history: [] }))

    await expect(runTranslate('empty', { root })).rejects.toThrow(/browser-recipe requires non-empty actions array/)
  })

  it('writes a validated YAML draft next to the selected history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-06T01:02:03Z'))
    try {
      const root = mkdtempSync(join(tmpdir(), 'stream-translate-'))
      const facilityDir = join(root, 'data', 'browser-profiles', 'juejin')
      await import('node:fs/promises').then((fs) => fs.mkdir(facilityDir, { recursive: true }))
      const historyPath = join(facilityDir, 'explore-20260706T010203Z.json')
      writeFileSync(historyPath, JSON.stringify(HISTORY))
      writeFileSync(`${historyPath}.xhr.json`, JSON.stringify(XHR))

      const out = await runTranslate('juejin', { root, historyPath })

      expect(out).toBe(join(facilityDir, 'recipe-draft-20260706T010203Z.yaml'))
      const written = readFileSync(out, 'utf-8')
      expect(written).toContain('# - step 1.0: click_element_by_index: dropped ordinal click as replay-unstable')
      expect(parseYaml(written)).toMatchObject({ kind: 'browser', harvest: { urlPattern: '*/recommend_api/v1/article/recommend_all_feed*' } })
    } finally {
      vi.useRealTimers()
    }
  })
})
