import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { activate } from './activate.ts'
import type { PluginContext } from '../../src/packages/activate.ts'
import { HOST_ENRICH_SOURCES } from '../../src/content/enrich/index.ts'
import { DETAIL_SOURCE } from './detail.ts'

const ctx = (over: Partial<PluginContext> = {}): PluginContext => ({
  backendUrl: () => undefined,
  withAwake: (_s, fn) => fn(),
  // 这个包不碰登录态：桩子抛而不是 no-op——静默的空实现会让"其实调到了"这件事看不见。
  cookieFor: async () => { throw new Error('这个包不该调 cookieFor') },
  login: async () => { throw new Error('这个包不该调 login') },
  readSource: async () => [],
  readArticle: async () => { throw new Error('这个包不该调 readArticle') },
  log: () => {},
  config: {},
  ...over,
})

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
  stream: { code: { entry: string; normalizers: string[]; enrichers: string[]; adapters?: string[] } }
}
const declared = pkg.stream.code

describe('xueqiu activate', () => {
  // 交出来的名字必须与 package.json#stream.code 申报的一致：装载器按申报名单校验，漂了就是装载期硬拒。
  it('交出的 normalizer / enricher 名与 stream.code 申报的逐一相同', () => {
    const out = activate(ctx())
    expect(declared.entry).toBe('dist/index.js')
    expect(Object.keys(out.normalizers ?? {})).toEqual(declared.normalizers)
    expect(Object.keys(out.enrichers ?? {})).toEqual(declared.enrichers)
    expect(out.adapters).toBeUndefined()
  })

  // 宿主已不再受理本站的富化：申报名撞上宿主分支会被装载器硬拒。
  it('申报的 enricher 名不在宿主自留的名单里', () => {
    for (const name of declared.enrichers) expect(HOST_ENRICH_SOURCES.has(name)).toBe(false)
  })

  // recipe 里写的 normalizer 名必须就是包交出的那个（对不上 → 静默落回默认 normalizer）；
  // feed 源要申报它打开时会调的 detail 源（meta.uses），而那正是 enricher 真去跑的那一个。
  it('xueqiu-user recipe 的 normalizer / uses 与包交出的对得上', () => {
    const recipe = JSON.parse(readFileSync(fileURLToPath(new URL('./xueqiu-user.recipe.json', import.meta.url)), 'utf8')) as {
      meta: { normalizer: string; uses?: string[] }
    }
    expect(declared.normalizers).toContain(recipe.meta.normalizer)
    expect(recipe.meta.uses).toEqual([DETAIL_SOURCE])
  })

  it('enricher 走的是 ctx.readSource（本包的 detail recipe）', async () => {
    const readSource = vi.fn(async () => [{ text: '全文' }])
    const out = activate(ctx({ readSource }))
    const e = await out.enrichers![declared.enrichers[0]!]!({ permalink: 'https://xueqiu.com/1/2' })
    expect(readSource).toHaveBeenCalledTimes(1)
    expect(e).toEqual({ article: { sourceUrl: 'https://xueqiu.com/1/2', text: '全文' } })
  })
})
