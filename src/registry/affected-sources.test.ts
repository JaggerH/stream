import { describe, it, expect } from 'vitest'
import { Registry } from './registry.ts'
import { affectedSources, brokenDependencies } from './affected-sources.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1,
    adapter: 'replay',
    type: 'post',
    description: 'desc',
    topics: [],
    example_queries: [],
    capabilities: ['timeline'],
    auth: { type: 'none' },
    params_schema: {},
    cadence_hint_seconds: 1800,
    discoverable: true,
    ...partial,
  }
}

const HOME = '@streamapp/xhs/xhs-home'
const SEARCH = '@streamapp/xhs/xhs-search'
const DETAIL = '@streamapp/xhs/xhs-detail'

/** 活体那一族的形状：两个 feed 源共用一份 detail recipe。 */
function xhsRegistry(): Registry {
  return new Registry([
    mk({ id: HOME, uses: [DETAIL] }),
    mk({ id: SEARCH, uses: [DETAIL] }),
    mk({ id: DETAIL }),
  ])
}

describe('affectedSources (pure graph)', () => {
  it('一个源坏了，连累的是「用它的人」，不是「它用的人」', () => {
    const r = affectedSources(
      [mk({ id: 'a', uses: ['b'] }), mk({ id: 'b' })],
      (x) => (['a', 'b'].includes(x) ? x : undefined),
      'b',
    )
    expect(r.affected).toEqual(['a', 'b'])
    // 反向问一次：a 坏了 b 不受影响（b 不依赖 a）
    expect(
      affectedSources([mk({ id: 'a', uses: ['b'] }), mk({ id: 'b' })], (x) => x, 'a').affected,
    ).toEqual(['a'])
  })

  it('传递闭包：A 用 B、B 用 C，C 坏了 A 也算', () => {
    const ms = [mk({ id: 'a', uses: ['b'] }), mk({ id: 'b', uses: ['c'] }), mk({ id: 'c' })]
    expect(affectedSources(ms, (x) => x, 'c').affected).toEqual(['a', 'b', 'c'])
  })

  it('环不会把它转死', () => {
    const ms = [mk({ id: 'a', uses: ['b'] }), mk({ id: 'b', uses: ['a'] })]
    expect(affectedSources(ms, (x) => x, 'a').affected).toEqual(['a', 'b'])
  })

  it('解析不到的 uses 边照实报出来——它可能就指着这个源，是答案里的洞', () => {
    const ms = [mk({ id: 'a', uses: ['ghost'] }), mk({ id: 'b' })]
    const r = affectedSources(ms, (x) => (x === 'ghost' ? undefined : x), 'b')
    expect(r.affected).toEqual(['b'])
    expect(r.unresolved).toEqual(['a → ghost'])
  })
})

describe('Registry.affectedSources', () => {
  it('共用一份 detail 的两个 feed 源，detail 漂了一起被标出', () => {
    expect(xhsRegistry().affectedSources(DETAIL).affected).toEqual([DETAIL, HOME, SEARCH])
  })

  it('存量形状归一到全名再比对：裸名 / plugin 前缀两截形都能查到', () => {
    const r = xhsRegistry()
    // 库里的 stream 行是 {plugin_id:'xhs', source_template_id:'xhs-detail'}，
    // 经 canonicalSourceId 重组成 'xhs:xhs-detail'（Registry.get 的第 2 级剥前缀）。
    expect(r.affectedSources('xhs:xhs-detail').affected).toEqual([DETAIL, HOME, SEARCH])
    // 别人分享来的旧 bundle / 用户手打的都是裸名（第 3 级）。
    expect(r.affectedSources('xhs-detail').affected).toEqual([DETAIL, HOME, SEARCH])
    // 起点本身也归一：报的是全名，不是用户写下的那个串。
    expect(r.affectedSources('xhs-detail').id).toBe(DETAIL)
  })

  it('uses 里写的存量裸名同样归一——两端只要有一端不归一就永远对不上', () => {
    const r = new Registry([mk({ id: HOME, uses: ['xhs-detail'] }), mk({ id: DETAIL })])
    expect(r.affectedSources(DETAIL).affected).toEqual([DETAIL, HOME])
  })

  it('裸名歧义时 get 会抛——这里吞掉并计进 unresolved，一次诊断不该整个失败', () => {
    // 两个包各带一个同名局部源：byLocalName 命中两条、分不出唯一胜者 → get 抛。
    const r = new Registry([
      mk({ id: 'a/dup' }),
      mk({ id: 'b/dup' }),
      mk({ id: 'c/consumer', uses: ['dup'] }),
    ])
    const res = r.affectedSources('a/dup')
    expect(res.affected).toEqual(['a/dup'])
    expect(res.unresolved).toEqual(['c/consumer → dup'])
  })

  it('没人用它 → 只有它自己，绝不返回空（空会被读成「这个源不存在」）', () => {
    expect(xhsRegistry().affectedSources(HOME).affected).toEqual([HOME])
  })
})

describe('brokenDependencies（反着读：我依赖的东西坏了吗）', () => {
  const affectedOf = (r: Registry) => (id: string) => r.affectedSources(id)

  it('detail 坏了 → home / search 各记一条，detail 自己不记（它自己那颗点已经在说了）', () => {
    const m = brokenDependencies(affectedOf(xhsRegistry()), [DETAIL])
    expect(m.get(HOME)).toEqual([DETAIL])
    expect(m.get(SEARCH)).toEqual([DETAIL])
    expect(m.has(DETAIL)).toBe(false)
  })

  it('没有坏的源 → 空表（常态：一遍图都不用走）', () => {
    expect(brokenDependencies(affectedOf(xhsRegistry()), []).size).toBe(0)
  })

  it('传递：A 用 B、B 用 C，C 坏了 A 也记上——只报直接依赖等于报了一半', () => {
    const r = new Registry([mk({ id: 'a', uses: ['b'] }), mk({ id: 'b', uses: ['c'] }), mk({ id: 'c' })])
    expect(brokenDependencies(affectedOf(r), ['c']).get('a')).toEqual(['c'])
  })

  it('两个依赖同时坏 → 一条消费方记两条，字典序', () => {
    const r = new Registry([mk({ id: 'a', uses: ['c', 'b'] }), mk({ id: 'b' }), mk({ id: 'c' })])
    expect(brokenDependencies(affectedOf(r), ['c', 'b']).get('a')).toEqual(['b', 'c'])
  })

  it('入参吃存量形状：裸名进来，出来的是全名（否则前端拿全名一条都对不上）', () => {
    const m = brokenDependencies(affectedOf(xhsRegistry()), ['xhs-detail'])
    expect(m.get(HOME)).toEqual([DETAIL])
  })
})
