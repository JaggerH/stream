import { describe, it, expect } from 'vitest'
import { parseStreamDescriptor } from './descriptor.ts'

/** 一份最小的、合法的带 `item` 声明的包——每条红例只改其中一格。 */
function pkg(item: unknown, extra: { name?: string | null; enrichers?: string[] } = {}) {
  const name = extra.name === null ? undefined : (extra.name ?? '@acme/demo')
  return {
    ...(name ? { name } : {}),
    stream: {
      id: 'demo',
      facility: 'demo',
      code: { entry: 'dist/index.js', enrichers: extra.enrichers ?? ['demo-user'] },
      item,
    },
  }
}

const like = {
  id: 'like', icon: 'heart', label: '点赞', recipe: '@acme/demo/demo-like',
  params: { postId: '{content.enrich.params.postId}' }, toggle: ['like', 'unlike'],
}

describe('stream.item 声明', () => {
  it('合法的声明原样带出', () => {
    const d = parseStreamDescriptor(pkg({
      authorEnrich: { enricher: 'demo-user', params: { name: '{author}' } },
      actions: [like],
    }), 'demo')
    expect(d.item).toEqual({
      authorEnrich: { enricher: 'demo-user', params: { name: '{author}' } },
      actions: [like],
    })
  })

  it('没写 item → 描述符里没有这一格', () => {
    expect('item' in parseStreamDescriptor(pkg(undefined), 'demo')).toBe(false)
  })

  it('recipe 不是本包的全名 → 拒（一个包不能把按钮挂到别家的动作上）', () => {
    expect(() => parseStreamDescriptor(pkg({ actions: [{ ...like, recipe: '@other/pkg/demo-like' }] }), 'demo'))
      .toThrow(/item\.actions\[0\]\.recipe/)
    expect(() => parseStreamDescriptor(pkg({ actions: [{ ...like, recipe: 'demo-like' }] }), 'demo'))
      .toThrow(/全名/)
  })

  it('包没有 npm 名却声明 actions → 拒（归属无从核对）', () => {
    expect(() => parseStreamDescriptor(pkg({ actions: [like] }, { name: null }), 'demo')).toThrow(/npm 名/)
  })

  it('icon 不在宿主词表 → 拒', () => {
    expect(() => parseStreamDescriptor(pkg({ actions: [{ ...like, icon: 'rocket' }] }), 'demo')).toThrow(/icon/)
  })

  it('toggle 不是恰两个非空值 → 拒', () => {
    expect(() => parseStreamDescriptor(pkg({ actions: [{ ...like, toggle: ['like'] }] }), 'demo')).toThrow(/toggle/)
    expect(() => parseStreamDescriptor(pkg({ actions: [{ ...like, toggle: ['like', 'unlike', 'x'] }] }), 'demo')).toThrow(/toggle/)
    expect(() => parseStreamDescriptor(pkg({ actions: [{ ...like, toggle: ['like', ''] }] }), 'demo')).toThrow(/toggle/)
  })

  it('同一个包里动作 id 重复 → 拒', () => {
    expect(() => parseStreamDescriptor(pkg({ actions: [like, { ...like, icon: 'bookmark' }] }), 'demo')).toThrow(/重复/)
  })

  it('params 里占位符之外写了表达式 → 拒（只认 {点路径}）', () => {
    expect(() => parseStreamDescriptor(pkg({ actions: [{ ...like, params: { postId: '{a || b}' } }] }), 'demo')).toThrow(/占位符/)
  })

  it('authorEnrich 的 enricher 不是本包申报的 → 拒', () => {
    expect(() => parseStreamDescriptor(pkg({ authorEnrich: { enricher: 'someone-else', params: { name: '{author}' } } }), 'demo'))
      .toThrow(/code\.enrichers/)
  })
})
