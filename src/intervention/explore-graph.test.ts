import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDraft, stableSelector, frontierOf, noteFrontier, recordAct, isExhausted, draftPath, readDraft, writeDraft, setStart, type InventoryItem } from './explore-graph.ts'

const rect = { x: 0, y: 0, w: 10, h: 10 }
const item = (n: number, over: Partial<InventoryItem> = {}): InventoryItem => ({ n, rect, ...over })
const base = () => newDraft({ runId: 'r1', facility: 'xhs', target: 'chrome:7', goal: '到搜索结果页' })

describe('stableSelector：能重放的才算', () => {
  it('href 优先（去掉 origin）；其次 aria-label 风格的 name；没有可用的回 undefined', () => {
    expect(stableSelector(item(1, { tag: 'a', href: 'https://www.xiaohongshu.com/search_result?keyword=x#top' }))).toBe('a[href*="/search_result?keyword=x"]')
    expect(stableSelector(item(2, { tag: 'button', name: '搜索' }))).toBe('button[aria-label="搜索"], button:is([title="搜索"])')
    expect(stableSelector(item(3, { role: 'tab', name: '推荐' }))).toBe('[role="tab"][aria-label="推荐"], [role="tab"]:is([title="推荐"])')
    expect(stableSelector(item(4, { tag: 'div' }))).toBeUndefined()
    expect(stableSelector(item(5, { tag: 'button', name: 'a"b' }))).toBe('button[aria-label="a\\"b"], button:is([title="a\\"b"])')
  })
})

describe('frontierOf / recordAct / isExhausted', () => {
  const items = [item(1, { tag: 'a', href: '/explore' }), item(2, { tag: 'button', name: '搜索' }), item(3, { tag: 'div' }), item(4, { tag: 'a', href: '/me' })]
  it('没选择器的不进；已点过、被拉黑的不进；remaining 记的是这次剩几条', () => {
    let d = base()
    d.states.push({ id: 'xhs/home', features: [{ kind: 'url', pattern: 'https://www.xiaohongshu.com/explore*' }] })
    d.visited['xhs/home'] = ['a[href*="/explore"]']
    d.blocked['xhs/home'] = ['a[href*="/me"]']
    const f = frontierOf(d, 'xhs/home', items)
    expect(f.map((x) => x.ref)).toEqual([2])
    d = noteFrontier(d, 'xhs/home', f)
    expect(d.remaining['xhs/home']).toBe(1)
    expect(isExhausted(d)).toBe(false)
  })
  it('recordAct：noop 只记 visited；reversible 落正反两条边；one-way 只落正边且 depth 记上', () => {
    let d = base()
    d.states.push({ id: 'xhs/home', features: [{ kind: 'url', pattern: 'a*' }] }, { id: 'xhs/search', features: [{ kind: 'url', pattern: 'b*' }] })
    const via = { ref: 2, tag: 'button', name: '搜索', rect, selector: 'button[aria-label="搜索"]' }
    d = recordAct(d, { from: 'xhs/home', to: undefined, via, effect: 'noop' })
    expect(d.transitions).toHaveLength(0)
    expect(d.visited['xhs/home']).toEqual(['button[aria-label="搜索"]'])
    d = recordAct(d, { from: 'xhs/home', to: 'xhs/search', via, effect: 'reversible', backSteps: [{ do: 'back' }] })
    expect(d.transitions.map((t) => [t.from, t.to, t.effect])).toEqual([['xhs/home', 'xhs/search', 'reversible'], ['xhs/search', 'xhs/home', 'reversible']])
    expect(d.transitions[0]!.steps).toEqual([{ do: 'click', selector: 'button[aria-label="搜索"]' }])
    expect(d.transitions[1]!.steps).toEqual([{ do: 'back' }])
    expect(d.depth['xhs/search']).toBe(1)
    d = recordAct(d, { from: 'xhs/search', to: 'xhs/note', via: { ...via, selector: 'a[href*="/n/1"]' }, effect: 'one-way' })
    expect(d.transitions.filter((t) => t.from === 'xhs/note')).toHaveLength(0)
    expect(d.depth['xhs/note']).toBe(2)
  })
  it('isExhausted：每个已知状态 remaining 都是 0（或 frozen / irrelevant / one-way 下游）且没有没列过的状态', () => {
    let d = base()
    d.states.push({ id: 'xhs/home', features: [{ kind: 'url', pattern: 'a*' }] })
    expect(isExhausted(d)).toBe(false)          // home 还没列过
    d = noteFrontier(d, 'xhs/home', [])
    expect(isExhausted(d)).toBe(true)
    d.states.push({ id: 'xhs/x', features: [{ kind: 'url', pattern: 'x*' }] })
    d.irrelevant.push('xhs/x')
    expect(isExhausted(d)).toBe(true)
  })
  it('recordAct：reversible 却没给 backSteps → 没有回路不算可逆，正边降级记成 one-way', () => {
    let d = base()
    d.states.push({ id: 'xhs/home', features: [{ kind: 'url', pattern: 'a*' }] }, { id: 'xhs/search', features: [{ kind: 'url', pattern: 'b*' }] })
    const via = { ref: 2, tag: 'button', name: '搜索', rect, selector: 'button[aria-label="搜索"]' }
    d = recordAct(d, { from: 'xhs/home', to: 'xhs/search', via, effect: 'reversible' })
    expect(d.transitions).toEqual([{ from: 'xhs/home', to: 'xhs/search', steps: [{ do: 'click', selector: via.selector }], effect: 'one-way', via }])
  })
  it('isExhausted：已探过（作为 from 出现过）的状态不因 one-way 入边被跳过', () => {
    let d = base()
    d.states.push({ id: 'xhs/home', features: [{ kind: 'url', pattern: 'a*' }] }, { id: 'xhs/note', features: [{ kind: 'url', pattern: 'n*' }] })
    const viaSearch = { ref: 1, tag: 'a', href: '/n/1', rect, selector: 'a[href*="/n/1"]' }
    d = recordAct(d, { from: 'xhs/home', to: 'xhs/note', via: viaSearch, effect: 'one-way' })  // home 探过（作为 from 出现），且是 one-way 起点不是目的地
    const viaBack = { ref: 2, tag: 'a', href: '/explore', rect, selector: 'a[href*="/explore"]' }
    d = recordAct(d, { from: 'xhs/note', to: 'xhs/home', via: viaBack, effect: 'one-way' })     // note 落回 home 的 one-way 边，home 没有 reversible 入边
    d.remaining['xhs/home'] = 2
    d.remaining['xhs/note'] = 0
    expect(isExhausted(d)).toBe(false)   // home 曾作为 from 出现过，不能因这条 one-way 入边被判成"不该展开"
  })
  it('setStart：起点即使没有任何边、remaining>0 也不 exhausted；one-way 边落到起点不会把它跳过', () => {
    let d = base()
    d = setStart(d, 'xhs/home')
    d.states.push({ id: 'xhs/home', features: [{ kind: 'url', pattern: 'a*' }] })
    d.remaining['xhs/home'] = 3
    expect(isExhausted(d)).toBe(false)
    d.states.push({ id: 'xhs/note', features: [{ kind: 'url', pattern: 'n*' }] })
    const via = { ref: 1, tag: 'a', href: '/back', rect, selector: 'a[href*="/back"]' }
    d = recordAct(d, { from: 'xhs/note', to: 'xhs/home', via, effect: 'one-way' })
    expect(isExhausted(d)).toBe(false)   // 起点不因这条 one-way 入边被排除在收敛判据之外
  })
})

describe('草稿读写', () => {
  it('原子写、读回同一份；读不到回 undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'draft-'))
    const p = draftPath(dir, 'xhs', 'r1')
    expect(p.endsWith('xhs.explore-r1.json')).toBe(true)
    expect(readDraft(p)).toBeUndefined()
    const d = base()
    writeDraft(p, d)
    expect(readDraft(p)).toEqual(d)
  })
})
