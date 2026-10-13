import { describe, expect, it } from 'vitest'
import { RecipeRunner } from './recipe-runner.ts'
import type { PageDriver } from './actions.ts'
import type { CanonicalBrowserRecipe } from './recipe.ts'
import type { RepairRunner, StateProposal } from './repair-runner.ts'

const recipe: CanonicalBrowserRecipe = {
  version: 2, kind: 'browser', sourceId: 'demo', cookieDomain: 'x.test', entryUrl: 'https://x.test/',
  loginCheck: { loggedIn: '.me', wall: '.wall' },
  session: { facility: 'demo-facility', lifecycle: 'persistent', visibility: 'unattended' },
  steps: [{ kind: 'scroll', dwell_s: [0, 0], maxTimes: 1, noProgressStop: 1 }],
  observers: [{ kind: 'dom', trigger: 'entry', itemSelector: '.card', fields: { id: {} }, input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } } }],
  output: { itemsAt: 'items', dedupeBy: 'guid', targetCount: 1, mapping: { guid: 'id' } },
}

function fakeDriver(overrides: Partial<PageDriver> = {}): PageDriver {
  return {
    exists: async (selector) => selector === '.me', readItems: async () => [{ id: 'n1' }],
    goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
    type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {},
    ...overrides,
  }
}

/**
 * 照 `recipe-runner.test.ts`「落空之后按状态图认一眼」那组的夹具：让进场那一步抛错
 * → 落进外层 catch（先判 blocked）→ 走第二处 `classifyByState`。
 * `currentUrl` 必须给且不同于 entryUrl，否则 goto 压根不会被调用。
 */
const boom = (present: string[]) =>
  fakeDriver({
    currentUrl: async () => 'https://elsewhere.test/',
    goto: async () => { throw new Error('boom') },
    exists: async (s: string) => present.includes(s),
  })

/** 收件人：把交上来的提议原样攒着，好断言「交了几条、交的是哪一种」。 */
const collecting = (): RepairRunner & { got: StateProposal[] } => {
  const got: StateProposal[] = []
  return {
    got,
    requestRepair: async () => {},
    proposeLocator: async () => {},
    proposeState: async (p) => { got.push(p) },
    proposeDiscriminator: async (p) => { got.push(p) },
    proposeTransition: async (p) => { got.push(p) },
  }
}

describe('recipe-runner 的介入闸', () => {
  it('页面自己报了失败（siteErrorField 有值）→ siteError，不交 AI 认页面、不判 drift', async () => {
    // 豆包生图 2026-10-13：回复只写「出了点问题，请稍后重试」，状态图认不出那张会话页，
    // 于是每次失败都去问一遍 AI「这是哪个页面」，攒了 25 条一样的提议。
    const rr = collecting()
    const siteErr = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items', cursorField: 'cursor', pendingField: 'pending', siteErrorField: 'siteError', maxPages: 8 }],
      observers: [],
    }
    const pages: Record<string, unknown> = {
      '""': { items: [], pending: true, cursor: '1' },
      '"1"': { items: [], siteError: '豆包这一轮生图失败（ai_creation_res_code=710082003）', cursor: '' },
    }
    const out = await new RecipeRunner().run(siteErr, {}, fakeDriver({
      currentUrl: async () => 'https://x.test/chat/1',
      evalJson: async (expr) => pages[expr.match(/\)\((""|"[^"]*")/)![1]!] ?? { items: [], cursor: '' },
    }), { repairRunner: rr })
    expect(out.outcome).toBe('siteError')
    expect(out.reason).toContain('710082003')
    expect(rr.got).toHaveLength(0)
  })

  it('siteError 可以是对象：retry / retryAfterMs / code 原样带出；写歪的 retry 退回 now', async () => {
    const run = (v: unknown) => new RecipeRunner().run({
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items', siteErrorField: 'siteError' }],
      observers: [],
    }, {}, fakeDriver({ currentUrl: async () => 'https://x.test/', evalJson: async () => ({ items: [], siteError: v }) }))
    const later = await run({ message: '额度用完', code: 'quota', retry: 'later', retryAfterMs: 3_600_000 })
    expect(later.outcome).toBe('siteError')
    expect(later.siteError).toEqual({ message: '额度用完', code: 'quota', retry: 'later', retryAfterMs: 3_600_000 })
    expect((await run({ message: 'x', retry: 'soon' })).siteError).toEqual({ message: 'x', retry: 'now' })
    // 时长只对 later 有意义；now 带了也丢掉，免得下游误当成要等
    expect((await run({ message: 'x', retry: 'now', retryAfterMs: 5 })).siteError).toEqual({ message: 'x', retry: 'now' })
  })

  it('siteErrorField 声明了但这一页没值 → 照常收尾', async () => {
    const siteErr = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items', siteErrorField: 'siteError' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    const out = await new RecipeRunner().run(siteErr, {}, fakeDriver({
      evalJson: async () => ({ items: [{ id: 'a' }], siteError: '' }),
    }))
    expect(out.outcome).toBe('ok')
  })

  it('整趟判 blocked 且状态图认不出 → proposeState 一次，带 scene 与 known', async () => {
    const rr = collecting()
    const out = await new RecipeRunner().run(recipe, {}, boom(['.article']), { repairRunner: rr })
    expect(out.outcome).toBe('blocked')
    expect(rr.got).toHaveLength(1)
    expect(rr.got[0]!.kind).toBe('state')
    expect(rr.got[0]!.scene?.side).toBe('browser')
    // 已知词汇 = 装配后的整张图（内置全局 ∪ 本地），让 AI 用我们的词回答。
    expect(rr.got[0]!.known?.length).toBeGreaterThan(0)
    // 状态图与观测账本都按 facility 分文件，所以提议必须带它，而不是只带 sourceId。
    expect(rr.got[0]!.facility).toBe('demo-facility')
  })

  it('同组撞车 → proposeDiscriminator，candidates 是撞车的那几个', async () => {
    const rr = collecting()
    const graph = {
      states: [
        { id: 'a', features: [{ kind: 'dom' as const, selector: '.both' }] },
        { id: 'b', features: [{ kind: 'dom' as const, selector: '.both' }] },
      ],
      transitions: [],
    }
    await new RecipeRunner().run(recipe, {}, boom(['.both']), { stateGraph: graph, repairRunner: rr })
    expect(rr.got[0]!.kind).toBe('discriminator')
    expect(rr.got[0]!.candidates?.length).toBe(2)
  })

  /**
   * **两处判决点各交各的**（spec §4）：步级那一处（`StepExpectError` 之后）说的是「这一步
   * 落空时我在哪」，整趟那一处说的是「这一趟结束时我在哪」——中间隔着 retry / 逃生 / 撞墙
   * 探测，页面完全可能已经不是同一张了。合并成一条会把其中一张现场永久丢掉。
   */
  it('expect 落空那一处也交，且理由点名是第几步', async () => {
    const rr = collecting()
    const gated: CanonicalBrowserRecipe = {
      ...recipe,
      steps: [{ kind: 'click', selector: '.go', expect: { selector: '.done', timeout: 20 } }],
    }
    await new RecipeRunner().run(gated, {}, fakeDriver({
      currentUrl: async () => 'https://x.test/',
      exists: async () => false,
    }), { repairRunner: rr })
    expect(rr.got.length).toBeGreaterThanOrEqual(2)
    expect(rr.got[0]!.kind).toBe('state')
    expect(rr.got[0]!.reason).toContain('expect 落空')
  })

  /**
   * 一趟最多问 3 次（spec §8）。闸在 runner 这一侧，判据是**连现场都不抓**——现场是
   * 整页截图 + 元素清单（`inventoryExpression` 认它的 `__streamInvSeq`），那笔钱在收件人
   * 拿到提议之前就花掉了，把闸装在收件人那边等于没装。
   */
  it('同一趟反复落空 → 最多交 3 条，第 4 次起连现场都不抓', async () => {
    const rr = collecting()
    const exprs: string[] = []
    const looping: CanonicalBrowserRecipe = {
      ...recipe,
      steps: [{ kind: 'click', selector: '.go', expect: { selector: '.done', timeout: 10 }, retryFrom: 0, retryTimes: 6 }],
    }
    await new RecipeRunner().run(looping, {}, fakeDriver({
      currentUrl: async () => 'https://x.test/',
      exists: async () => false,
      evalJson: async (e: string) => { exprs.push(e); return null },
    }), { repairRunner: rr })
    expect(rr.got).toHaveLength(3)
    expect(exprs.filter((e) => e.includes('__streamInvSeq'))).toHaveLength(3)
  })

  it('预算可调：repairBudget=1 时只交一条', async () => {
    const rr = collecting()
    const looping: CanonicalBrowserRecipe = {
      ...recipe,
      steps: [{ kind: 'click', selector: '.go', expect: { selector: '.done', timeout: 10 }, retryFrom: 0, retryTimes: 4 }],
    }
    await new RecipeRunner().run(looping, {}, fakeDriver({
      currentUrl: async () => 'https://x.test/',
      exists: async () => false,
    }), { repairRunner: rr, repairBudget: 1 })
    expect(rr.got).toHaveLength(1)
  })

  it('没传 repairRunner 时行为一个字不变（不抓现场、不抛）', async () => {
    const exprs: string[] = []
    const d = fakeDriver({
      currentUrl: async () => 'https://elsewhere.test/',
      goto: async () => { throw new Error('boom') },
      exists: async (s: string) => s === '.article',
      evalJson: async (e: string) => { exprs.push(e); return null },
    })
    const out = await new RecipeRunner().run(recipe, {}, d)
    expect(out.outcome).toBe('blocked')
    expect(out.reason).toBe('boom')
    // 介入现场的元素清单（`inventoryExpression`，认它的 `__streamInvSeq`）是这条闸专属的开销：
    // 没有收件人就一次都不该发生。既有的 FailureScene 取证不受影响，它是另一条路。
    expect(exprs.some((e) => e.includes('__streamInvSeq'))).toBe(false)
  })

  /**
   * **一趟跑完 0 条 item 是最常见的那种失败**，所以它必须和抛错那条走同一个出口：
   * 曾经它从 try 里直接 return，于是 classify / 介入交接 / 撞墙补探 / 抓现场全部静默跳过
   * （活体 2026-09-11：故意改坏的 xhs-search 报 `blocked: recipe produced no items`，
   * `repairRunner` 接好了却一次介入都没有）。
   */
  const emptyDriver = () =>
    fakeDriver({ currentUrl: async () => 'https://x.test/', readItems: async () => [] })

  it('一趟跑完 0 条 item → 照样交一次 proposeState，结论仍是 blocked', async () => {
    const rr = collecting()
    const out = await new RecipeRunner().run(recipe, {}, emptyDriver(), { repairRunner: rr })
    expect(out.outcome).toBe('blocked')
    expect(out.reason).toContain('recipe produced no items')
    expect(rr.got).toHaveLength(1)
    expect(rr.got[0]!.kind).toBe('state')
    expect(rr.got[0]!.scene?.side).toBe('browser')
  })

  it('0 条 item 且没传 repairRunner → 结论一个字不变，也不抓介入现场', async () => {
    const exprs: string[] = []
    const d = fakeDriver({
      currentUrl: async () => 'https://x.test/',
      readItems: async () => [],
      evalJson: async (e: string) => { exprs.push(e); return null },
    })
    const out = await new RecipeRunner().run(recipe, {}, d)
    expect(out.outcome).toBe('blocked')
    expect(out.reason).toContain('recipe produced no items')
    expect(exprs.some((e) => e.includes('__streamInvSeq'))).toBe(false)
  })

  /** 空收成也吃 classify：认出死路就是 `challenged`（站方让我们停），不是 drift。 */
  it('0 条 item 落在状态图认得出的死路上 → challenged', async () => {
    const graph = {
      states: [{ id: 't/dead', features: [{ kind: 'dom' as const, selector: '.banned' }], deadEnd: '这条路今天走不通' }],
      transitions: [],
    }
    const d = fakeDriver({
      currentUrl: async () => 'https://x.test/',
      readItems: async () => [],
      exists: async (s: string) => s === '.banned',
    })
    const out = await new RecipeRunner().run(recipe, {}, d, { stateGraph: graph })
    expect(out.outcome).toBe('challenged')
    expect(out.reason).toContain('这条路今天走不通')
  })

  /** 收件人自己抛错不许掀翻采集——它只是个旁路，判决早就下完了。 */
  it('收件人抛错时，这一趟的结论一个字不变', async () => {
    const rude: RepairRunner = {
      requestRepair: async () => {},
      proposeLocator: async () => {},
      proposeState: async () => { throw new Error('收件人炸了') },
      proposeDiscriminator: async () => { throw new Error('收件人炸了') },
      proposeTransition: async () => {},
    }
    const out = await new RecipeRunner().run(recipe, {}, boom(['.article']), { repairRunner: rude })
    expect(out.outcome).toBe('blocked')
    expect(out.reason).toBe('boom')
  })
})
