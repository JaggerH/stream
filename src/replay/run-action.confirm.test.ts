import { describe, it, expect } from 'vitest'
import type { PageDriver } from './actions.ts'
import type { ActionSpec } from './interactive-gate.ts'
import { actWithConfirm } from './run-action.ts'

// action → observe：动作做完，若声明了 expect 特征，就轮询它出现，据此给出诚实的成败。
// 这是用户点出的缺口——cdp_act(target:facility:<name>) 以前点完直接返 {status:'done'}，那只是"click 调用返回了"，
// 不是"点成功了"，判断不了；且没带 expect 时还傻等 30s。

/** 最小 driver：exists 在第 `existsAfter` 次调用起返回 true（undefined = 永远 false）。 */
function driver(existsAfter?: number): { d: PageDriver; clicks: string[] } {
  const clicks: string[] = []
  let n = 0
  const d = {
    click: async (sel: string) => { clicks.push(sel); return true },
    exists: async () => { n++; return existsAfter != null && n >= existsAfter },
    sleep: async () => {},
  } as unknown as PageDriver
  return { d, clicks }
}

const click = (a: Partial<ActionSpec>): ActionSpec => ({ kind: 'click', domain: 'a.example', selector: '#x', ...a })

describe('actWithConfirm — 动作后确认预期特征', () => {
  it('带 expect、特征出现 → confirmed', async () => {
    const { d, clicks } = driver(1)
    const r = await actWithConfirm(d, click({ expect: '.note-detail-mask' }))
    expect(r.status).toBe('confirmed')
    expect(clicks).toEqual(['#x']) // 动作确实执行了
  })

  it('带 expect、特征在 deadline 内没出现 → acted-unconfirmed（诚实，不假装 done）', async () => {
    const { d } = driver(undefined) // exists 永远 false
    const r = await actWithConfirm(d, click({ expect: '.never' }), { deadlineMs: 40, pollMs: 5 })
    expect(r.status).toBe('acted-unconfirmed')
  })

  it('特征迟到几轮才出现，也能等到 → confirmed', async () => {
    const { d } = driver(3)
    const r = await actWithConfirm(d, click({ expect: '.note-detail-mask' }), { deadlineMs: 500, pollMs: 1 })
    expect(r.status).toBe('confirmed')
  })

  it('不带 expect → done（没让确认就不假装确认，但也不再傻等）', async () => {
    const { d, clicks } = driver()
    const r = await actWithConfirm(d, click({}))
    expect(r.status).toBe('done')
    expect(clicks).toEqual(['#x'])
  })

  it('driver 报告没找到目标 → status not-found，且不再跑 expect 轮询（没命中就没必要等）', async () => {
    let existsCalls = 0
    const d = {
      click: async () => false, // 选择器没命中任何元素
      exists: async () => { existsCalls++; return true }, // 若真去轮询，这里会立刻判 confirmed——用来证明它没被调用
      sleep: async () => {},
    } as unknown as PageDriver
    const r = await actWithConfirm(d, click({ expect: '.note-detail-mask' }))
    expect(r.status).toBe('not-found')
    expect(existsCalls).toBe(0)
  })

  it('读动作（exists/look）不受影响：结果原样带回，无 expect → done', async () => {
    const d = {
      exists: async () => true,
      sleep: async () => {},
      evalJson: async () => 42,
    } as unknown as PageDriver
    expect(await actWithConfirm(d, { kind: 'exists', domain: 'a', selector: '#x' })).toEqual({ status: 'done', result: true })
    expect(await actWithConfirm(d, { kind: 'look', domain: 'a', expression: '1+1' })).toEqual({ status: 'done', result: 42 })
  })
})
