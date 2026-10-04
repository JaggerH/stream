import { describe, it, expect } from 'vitest'
import { buildDependencyCatalog } from './export-closure.ts'
import type { PluginDescriptor } from '../plugins/types.ts'
import type { RecipePackage } from '../replay/recipe-package.ts'

const douyin: PluginDescriptor = { id: 'Douyin_TikTok_Download_API', homepage: 'https://x', sources: [{ id: 'dy-user' } as never] } as PluginDescriptor
const xhsPkg = { facility: 'xhs', author: 'alice', schemaVersion: 1, dir: '/r/xhs', sources: [{ id: 'xhs-home' } as never] } as unknown as RecipePackage

const catalog = buildDependencyCatalog({
  plugins: [douyin],
  recipePackages: [xhsPkg],
  readManifest: (id) => (id === 'dy-user' ? ({ pluginId: 'Douyin_TikTok_Download_API' } as never) : undefined),
  readEmbedded: (facility) => (facility === 'xhs' ? { facility: 'xhs', author: 'alice', packageJson: JSON.stringify({ name: '@streamapp/xhs', author: 'alice', stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 } }), recipeFiles: { 'xhs-home.recipe.json': '{}' } } : undefined),
})

describe('DependencyCatalog', () => {
  it('recipe 源 → kind recipe + 内嵌整份', () => {
    const r = catalog.classify({ plugin: 'xhs', source: 'xhs-home', params: {} })
    expect(r.kind).toBe('recipe')
    if (r.kind === 'recipe') expect(r.pkg.recipeFiles['xhs-home.recipe.json']).toBe('{}')
  })
  it('代码插件源 → kind plugin + homepage', () => {
    const r = catalog.classify({ plugin: 'Douyin_TikTok_Download_API', source: 'dy-user', params: {} })
    expect(r.kind).toBe('plugin')
    if (r.kind === 'plugin') expect(r.homepage).toBe('https://x')
  })
  it('未知源 → unknown', () => {
    expect(catalog.classify({ plugin: 'nope', source: 'zzz', params: {} }).kind).toBe('unknown')
  })
})
