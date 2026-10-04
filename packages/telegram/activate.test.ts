import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { activate } from './activate.ts'
import type { PluginContext } from '../../src/packages/activate.ts'

// 这个包什么宿主能力都不用：每一格桩子都抛——静默的空实现会让"其实调到了"这件事看不见。
const refuse = (what: string) => () => { throw new Error(`这个包不该调 ${what}`) }
const ctx: PluginContext = {
  backendUrl: refuse('backendUrl'),
  withAwake: refuse('withAwake'),
  cookieFor: refuse('cookieFor'),
  login: refuse('login'),
  readSource: refuse('readSource'),
  readArticle: refuse('readArticle'),
  log: () => {},
  config: {},
}

const declared = (JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
  stream: { code: { entry: string; normalizers: string[] } }
}).stream.code

describe('telegram activate', () => {
  it('只交出一个 normalizer，名字与 stream.code 申报的相同', () => {
    const out = activate(ctx)
    expect(declared.entry).toBe('dist/index.js')
    expect(Object.keys(out.normalizers ?? {})).toEqual(declared.normalizers)
    expect(out.adapters).toBeUndefined()
    expect(out.enrichers).toBeUndefined()
  })

  // recipe 里写的 normalizer 名必须就是包交出的那个：对不上，manifest 静默落回默认 normalizer。
  it('telegram-search recipe 的 meta.normalizer 指着本包交出的名字', () => {
    const recipe = JSON.parse(readFileSync(fileURLToPath(new URL('./telegram-search.recipe.json', import.meta.url)), 'utf8')) as {
      meta: { normalizer: string }
    }
    expect(declared.normalizers).toContain(recipe.meta.normalizer)
  })
})
