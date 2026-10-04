import { describe, it, expect } from 'vitest'
import { FeedLedger, ledgerIdsFrom } from './feed-ledger.ts'
import type { CanonicalBrowserRecipe } from './recipe.ts'

const withLedger = (idField: string) => ({ ledger: { idField } }) as Pick<CanonicalBrowserRecipe, 'ledger'>

describe('FeedLedger', () => {
  it('按 (facility, lane) 分开记，默认 lane 不串到别的 lane 上', () => {
    const ledger = new FeedLedger()
    ledger.record('xhs', ['a', 'b'])
    ledger.record('xhs', ['c'], 'detail')
    expect(ledger.ordered('xhs')).toEqual(['a', 'b'])
    expect(ledger.ordered('xhs', 'detail')).toEqual(['c'])
    expect(ledger.ordered('douyin')).toEqual([])
  })

  it('整本替换而不是追加——新一次搜索 = 页面被换成了另一批', () => {
    const ledger = new FeedLedger()
    ledger.record('xhs', ['a', 'b'])
    ledger.record('xhs', ['x', 'y'])
    expect(ledger.ordered('xhs')).toEqual(['x', 'y'])
  })

  it('记下来的是快照——调用方之后改自己那个数组，账本不跟着变', () => {
    const ledger = new FeedLedger()
    const ids = ['a']
    ledger.record('xhs', ids)
    ids.push('b')
    expect(ledger.ordered('xhs')).toEqual(['a'])
  })

  it('关掉 facility → 它名下所有 lane 的账本一起丢（标签没了，账本就是废纸）', () => {
    const ledger = new FeedLedger()
    ledger.record('xhs', ['a'])
    ledger.record('xhs', ['b'], 'detail')
    ledger.record('douyin', ['z'])
    ledger.clearFacility('xhs')
    expect(ledger.ordered('xhs')).toEqual([])
    expect(ledger.ordered('xhs', 'detail')).toEqual([])
    expect(ledger.ordered('douyin')).toEqual(['z'])
  })

  it('回收单条 lane 只丢那一条', () => {
    const ledger = new FeedLedger()
    ledger.record('xhs', ['a'])
    ledger.record('xhs', ['b'], 'detail')
    ledger.clearLane('xhs', 'detail')
    expect(ledger.ordered('xhs')).toEqual(['a'])
    expect(ledger.ordered('xhs', 'detail')).toEqual([])
  })
})

describe('ledgerIdsFrom', () => {
  it('按产出顺序抠出 idField —— 顺序就是坐标系', () => {
    const items = [{ noteId: 'n1' }, { noteId: 'n2' }, { noteId: 'n3' }]
    expect(ledgerIdsFrom(withLedger('noteId'), items)).toEqual(['n1', 'n2', 'n3'])
  })

  it('没声明 ledger → null（"这份 recipe 不建账本" ≠ "这次没产出"，后者才该清空）', () => {
    expect(ledgerIdsFrom({}, [{ noteId: 'n1' }])).toBeNull()
  })

  it('声明了但这次一条都没采到 → 空数组（清空账本，别留着旧页面的 id）', () => {
    expect(ledgerIdsFrom(withLedger('noteId'), [])).toEqual([])
  })

  it('缺 id 的条目跳过而不是补空串——空串会把后面每一条的索引都推错一格', () => {
    const items = [{ noteId: 'n1' }, { title: '没有 id' }, { noteId: '' }, { noteId: 'n2' }]
    expect(ledgerIdsFrom(withLedger('noteId'), items)).toEqual(['n1', 'n2'])
  })

  it('非字符串 id 也收（数字 id 的站点），统一成字符串', () => {
    expect(ledgerIdsFrom(withLedger('id'), [{ id: 42 }])).toEqual(['42'])
  })
})
