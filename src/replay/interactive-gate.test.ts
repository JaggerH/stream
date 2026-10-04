import { describe, it, expect } from 'vitest'
import { classifyAction, needsConfirmation, type ActionSpec, type LaneAction } from './interactive-gate.ts'

// 用户拍板的规则：默认 act-without-asking（AI 自主推进），**只有高危动作**停下来等确认。
// 高危 = 提交/发送类、删除/不可逆、跨站导航、触碰凭据/账号设置。
// 非高危 = 同站导航、点击非提交按钮、滚动、读取、未提交的填字段。

const at = (a: Partial<LaneAction>): LaneAction => ({ kind: 'click', tabId: 1, domain: 'a.example', ...a })

describe('classifyAction — 高危判据', () => {
  it('表单提交是高危', () => {
    expect(classifyAction(at({ kind: 'submit' })).risk).toBe('high')
  })

  it('发送/发帖/发邮件类是高危', () => {
    expect(classifyAction(at({ kind: 'click', intent: 'send' })).risk).toBe('high')
    expect(classifyAction(at({ kind: 'click', intent: 'publish' })).risk).toBe('high')
  })

  it('下单/支付是高危', () => {
    expect(classifyAction(at({ kind: 'click', intent: 'purchase' })).risk).toBe('high')
  })

  it('删除/不可逆变更是高危', () => {
    expect(classifyAction(at({ kind: 'click', intent: 'delete' })).risk).toBe('high')
  })

  it('跨站导航是高危（目标域名 ≠ 当前域名）', () => {
    expect(classifyAction(at({ kind: 'goto', domain: 'a.example', targetUrl: 'https://other.example/x' })).risk).toBe(
      'high',
    )
  })

  it('同站导航不是高危', () => {
    expect(classifyAction(at({ kind: 'goto', domain: 'a.example', targetUrl: 'https://a.example/other' })).risk).toBe(
      'low',
    )
  })

  it('子域视作跨站（evil.a.example ≠ a.example）—— 与逐动作域名校验同源', () => {
    expect(classifyAction(at({ kind: 'goto', domain: 'a.example', targetUrl: 'https://evil.a.example/x' })).risk).toBe(
      'high',
    )
  })

  it('触碰凭据/账号设置是高危', () => {
    expect(classifyAction(at({ kind: 'type', intent: 'credential' })).risk).toBe('high')
  })

  it('普通点击（非提交）不是高危', () => {
    expect(classifyAction(at({ kind: 'click' })).risk).toBe('low')
  })

  it('滚动 / 读取 / exists 不是高危', () => {
    expect(classifyAction(at({ kind: 'scroll' })).risk).toBe('low')
    expect(classifyAction(at({ kind: 'look' })).risk).toBe('low')
    expect(classifyAction(at({ kind: 'exists' })).risk).toBe('low')
  })

  it('未提交的填字段不是高危（提交那一下才是）', () => {
    expect(classifyAction(at({ kind: 'type' })).risk).toBe('low')
  })

  it('高危分类要给出人能读懂的理由', () => {
    const c = classifyAction(at({ kind: 'submit' }))
    expect(c.reason).toBeTruthy()
    expect(typeof c.reason).toBe('string')
  })
})

// ── back 不是跨站导航 ──
// 高危清单里的"跨站导航"防的是**AI 被带到一个新的、意料之外的地方**。back 定义上就是回到
// 这个 tab 刚刚待过的页面——用户和 AI 都已经看过它了，不是新去处，所以不该拦。
//
// 而且拦它有实际害处：搜索流程本质就是跨站的（Google → 结果 → back → 下一个结果），
// 每次 back 都问一遍，会把最常用的动作变成一连串确认；人被问多了就条件反射地点"是"，
// 那道门在真正危险的动作（提交/下单/删除）上的价值就被消耗光了。对无害动作频繁响的门
// 比不响更糟。
describe('back —— 回到已经来过的页面，不算跨站导航', () => {
  it('back 到别的站的上一页：不拦', () => {
    const action: LaneAction = { kind: 'back', tabId: 1, domain: 'www.xiaoyuzhoufm.com' }
    expect(classifyAction(action).risk).toBe('low')
    expect(needsConfirmation(action)).toBe(false)
  })

  it('理由说清它为什么不是新去处（而不是含混的"同站动作"）', () => {
    expect(classifyAction(at({ kind: 'back' })).reason).toMatch(/历史|来过|上一页/)
  })

  it('放行 back 不等于放行 goto —— 跨站 goto 照拦', () => {
    const goto: LaneAction = { kind: 'goto', tabId: 1, domain: 'a.example', targetUrl: 'https://evil.example/x' }
    expect(needsConfirmation(goto)).toBe(true)
  })

  it('ask-before-acting 档下 back 仍要问 —— 那一档本就每个非读动作都问', () => {
    expect(needsConfirmation(at({ kind: 'back' }), 'ask-before-acting')).toBe(true)
  })
})

describe('needsConfirmation — 两档模式', () => {
  it('默认档 act-without-asking：非高危直行、不打断', () => {
    expect(needsConfirmation(at({ kind: 'click' }), 'act-without-asking')).toBe(false)
    expect(needsConfirmation(at({ kind: 'scroll' }), 'act-without-asking')).toBe(false)
    expect(needsConfirmation(at({ kind: 'type' }), 'act-without-asking')).toBe(false)
  })

  it('默认档：高危动作要停下等确认', () => {
    expect(needsConfirmation(at({ kind: 'submit' }), 'act-without-asking')).toBe(true)
    expect(
      needsConfirmation(at({ kind: 'goto', domain: 'a.example', targetUrl: 'https://other.example/' }), 'act-without-asking'),
    ).toBe(true)
  })

  it('ask-before-acting 档：每个 mutating 动作都要确认', () => {
    expect(needsConfirmation(at({ kind: 'click' }), 'ask-before-acting')).toBe(true)
    expect(needsConfirmation(at({ kind: 'type' }), 'ask-before-acting')).toBe(true)
    expect(needsConfirmation(at({ kind: 'submit' }), 'ask-before-acting')).toBe(true)
  })

  it('ask-before-acting 档：纯读取仍不打断（读不改变任何东西）', () => {
    expect(needsConfirmation(at({ kind: 'look' }), 'ask-before-acting')).toBe(false)
    expect(needsConfirmation(at({ kind: 'exists' }), 'ask-before-acting')).toBe(false)
  })

  it('默认档就是 act-without-asking（不传模式时）', () => {
    expect(needsConfirmation(at({ kind: 'click' }))).toBe(false)
    expect(needsConfirmation(at({ kind: 'submit' }))).toBe(true)
  })
})

// 门判的是「做什么」，从来不是「在哪做」。它一行都没读过 tabId——
// 可 tabId 焊在 LaneAction 里，于是 cloak（按 facility+laneKey 寻址、根本没有 tabId）
// 想过同一道门就得编一个假 tabId 出来。那不是共享，那是骗类型。
// 拆出 ActionSpec 之后，两条 transport 是真的在过同一道门。
describe('ActionSpec — 门与地址解耦', () => {
  const spec = (a: Partial<ActionSpec>): ActionSpec => ({ kind: 'click', domain: 'a.example', ...a })

  it('不带 tabId 的动作照样能判——cloak 侧没有 tabId 可给', () => {
    expect(classifyAction(spec({ kind: 'submit' })).risk).toBe('high')
    expect(classifyAction(spec({ kind: 'click' })).risk).toBe('low')
    expect(needsConfirmation(spec({ kind: 'submit' }))).toBe(true)
    expect(needsConfirmation(spec({ kind: 'scroll' }))).toBe(false)
  })

  it('判决只由动作决定——带不带 tabId 结果必须一模一样', () => {
    const withTab: LaneAction = { kind: 'goto', tabId: 7, domain: 'a.example', targetUrl: 'https://other.example/' }
    const withoutTab: ActionSpec = { kind: 'goto', domain: 'a.example', targetUrl: 'https://other.example/' }
    expect(classifyAction(withoutTab)).toEqual(classifyAction(withTab))
  })

  it('LaneAction 仍是 ActionSpec 的子型——ext-cdp 侧调用点一处都不用改', () => {
    const lane: LaneAction = { kind: 'submit', tabId: 3, domain: 'a.example' }
    const asSpec: ActionSpec = lane
    expect(classifyAction(asSpec).risk).toBe('high')
  })
})
