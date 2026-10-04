import { describe, it, expect } from 'vitest'
import { fillPlaceholders, ownerPackageOf, projectItem, type ItemOwnerPackage, type ItemProjectionSource, type ItemSourceEntry } from './item-projection.ts'

const demo: ItemOwnerPackage = {
  facility: 'demo',
  label: '演示站',
  homepage: 'https://www.demo.example/',
  rsshubNamespaces: ['demons'],
  item: {
    authorEnrich: { enricher: 'demo-user', params: { name: '{author}' } },
    actions: [
      { id: 'like', icon: 'heart', label: '点赞', recipe: '@acme/demo/demo-like', params: { postId: '{content.enrich.params.postId}' }, toggle: ['like', 'unlike'] },
    ],
  },
}
const other: ItemOwnerPackage = { facility: 'other', label: '别家' }

const entries: Record<string, ItemSourceEntry> = {
  '@acme/demo/demo-home': { id: '@acme/demo/demo-home', title: '首页推荐', facility: { key: 'demo', label: '演示站' } },
  'rsshub:demons/hot': { id: 'rsshub:demons/hot', title: '热门', facility: { key: 'demons', label: '演示站' } },
  '@x/other/other-feed': { id: '@x/other/other-feed', title: '别家 · 动态', facility: { key: 'other', label: '别家' } },
}
const src: ItemProjectionSource = {
  packages: [demo, other],
  // 模拟 Registry.get 的裸名 / 前缀解析：`demo-home` 也能查到全名那条。
  lookup: (id) => entries[id] ?? Object.values(entries).find((e) => e.id.endsWith(`/${id}`)),
}

const noteItem = {
  source_id: '@acme/demo/demo-home',
  author: '某人',
  content: { enrich: { source: 'demo-detail', params: { postId: 'p1' } } },
}

describe('ownerPackageOf', () => {
  it('目录路由按命名空间认领归属', () => {
    expect(ownerPackageOf(entries['rsshub:demons/hot'], src.packages)).toBe(demo)
  })
  it('包的源按 facility 归属', () => {
    expect(ownerPackageOf(entries['@x/other/other-feed'], src.packages)).toBe(other)
  })
  it('谁都不认领 → undefined', () => {
    expect(ownerPackageOf({ id: 'rsshub:nobody/x', facility: { key: 'nobody' } }, src.packages)).toBeUndefined()
  })
})

describe('fillPlaceholders', () => {
  it('点路径取值，数字转串，字面量原样', () => {
    expect(fillPlaceholders({ a: '{x.y}', b: 'n={n}', c: 'lit' }, { x: { y: 'v' }, n: 3 })).toEqual({ a: 'v', b: 'n=3', c: 'lit' })
  })
  it('任何一个取不到 → null', () => {
    expect(fillPlaceholders({ a: '{x.y}', b: '{missing}' }, { x: { y: 'v' } })).toBeNull()
    expect(fillPlaceholders({ a: '{x}' }, { x: '' })).toBeNull()
    expect(fillPlaceholders({ a: '{x}' }, { x: { deep: 1 } })).toBeNull()
  })
})

describe('projectItem', () => {
  it('本包条目：动作带代入后的参数、作者现取入口、源名、站点', () => {
    const out = projectItem(noteItem, src)
    expect(out.actions).toEqual([
      { id: 'like', icon: 'heart', label: '点赞', recipe: '@acme/demo/demo-like', params: { postId: 'p1' }, toggle: ['like', 'unlike'] },
    ])
    expect(out.author_enrich).toEqual({ source: 'demo-user', params: { name: '某人' } })
    expect(out.source_label).toBe('演示站 · 首页推荐')
    expect(out.source_site).toEqual({ name: '演示站', domain: 'demo.example' })
  })

  it('裸名的存量 source_id 也归到本包', () => {
    expect(projectItem({ ...noteItem, source_id: 'demo-home' }, src).actions).toHaveLength(1)
  })

  it('目录路由（命名空间认领）的条目同样吃本包声明', () => {
    const out = projectItem({ source_id: 'rsshub:demons/hot', author: 'UP' }, src)
    expect(out.author_enrich).toEqual({ source: 'demo-user', params: { name: 'UP' } })
    expect(out.actions).toBeUndefined()   // 没有 content.enrich → 动作参数取不到 → 整条不出
  })

  it('别家条目没有本包的声明', () => {
    const out = projectItem({ ...noteItem, source_id: '@x/other/other-feed' }, src)
    expect(out.actions).toBeUndefined()
    expect(out.author_enrich).toBeUndefined()
    expect(out.source_label).toBe('别家 · 动态')
    expect(out.source_site).toBeUndefined()   // 别家没写 homepage
  })

  it('占位符取不到 → 那个动作整条不出', () => {
    expect(projectItem({ ...noteItem, content: {} }, src).actions).toBeUndefined()
  })

  it('已有头像或没有作者 → 不出 author_enrich', () => {
    expect(projectItem({ ...noteItem, author_avatar: 'https://a/b.jpg' }, src).author_enrich).toBeUndefined()
    expect(projectItem({ ...noteItem, author: undefined }, src).author_enrich).toBeUndefined()
  })

  it('没有 source_id 或源目录查不到 → 原样返回', () => {
    const bare = { author: 'x' }
    expect(projectItem(bare, src)).toBe(bare)
    const unknown = { source_id: 'nope' }
    expect(projectItem(unknown, src)).toBe(unknown)
  })
})
