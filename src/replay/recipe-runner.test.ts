import { describe, expect, it } from 'vitest'
import { RecipeRunner } from './recipe-runner.ts'
import { RunProbe } from './recipe-probe.ts'
import type { PageDriver } from './actions.ts'
import type { CanonicalBrowserRecipe } from './recipe.ts'

const recipe: CanonicalBrowserRecipe = {
  version: 2, kind: 'browser', sourceId: 'demo', cookieDomain: 'x.test', entryUrl: 'https://x.test/',
  loginCheck: { loggedIn: '.me', wall: '.wall' },
  session: { facility: 'demo', lifecycle: 'persistent', visibility: 'unattended' },
  steps: [{ kind: 'scroll', dwell_s: [0, 0], maxTimes: 1, noProgressStop: 1 }],
  observers: [{ kind: 'dom', trigger: 'entry', itemSelector: '.card', fields: { id: {} }, input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } } }],
  output: { itemsAt: 'items', dedupeBy: 'guid', targetCount: 1, mapping: { guid: 'id' } },
}

/** Minimal happy-path driver; override per test. */
function fakeDriver(overrides: Partial<PageDriver> = {}): PageDriver {
  return {
    exists: async (selector) => selector === '.me', readItems: async () => [{ id: 'n1' }],
    goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
    type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {},
    ...overrides,
  }
}

describe('RecipeRunner', () => {
  it('runs canonical actions and observers without owning a browser session', async () => {
    const outcome = await new RecipeRunner().run(recipe, {}, {
      exists: async (selector) => selector === '.me', readItems: async () => [{ id: 'n1' }],
      goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {}, type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {},
    })
    expect(outcome).toMatchObject({ outcome: 'ok', items: [{ guid: 'n1' }] })
  })

  /**
   * 步与步之间是最常停住的那个退出点：locate 刚点完、正准备等 state 的那一刻，用户点了别条。
   * 判据是**下一步没有开始**（`scrollOnce` 一次没被调），不是"最后返回了 cancelled"——后者
   * 光靠跑完再改个标签也能满足，而那正是这条改动要消灭的行为。
   */
  it('stops between steps once the caller gives up — the next step must not start', async () => {
    const controller = new AbortController()
    let scrolls = 0
    const outcome = await new RecipeRunner().run(recipe, {}, fakeDriver({
      readItems: async () => { controller.abort(); return [{ id: 'n1' }] },
      scrollOnce: async () => { scrolls++ },
    }), { signal: controller.signal })
    expect(outcome.outcome).toBe('cancelled')
    expect(scrolls).toBe(0)
  })

  it('streams freshly-harvested items to the injected live sink, tagged by sourceId', async () => {
    const seen: Array<{ sourceId: string; items: unknown[] }> = []
    const runner = new RecipeRunner(undefined, (sourceId, items) => seen.push({ sourceId, items }))
    const outcome = await runner.run(recipe, {}, fakeDriver())
    expect(outcome.outcome).toBe('ok')
    expect(seen).toEqual([{ sourceId: 'demo', items: [{ guid: 'n1' }] }])
  })

  it('returns a per-phase timing trace (entry → login → setup → step → harvest)', async () => {
    const outcome = await new RecipeRunner().run(recipe, {}, fakeDriver())
    const phases = (outcome.timing ?? []).map((t) => t.phase)
    expect(phases[0]).toBe('entry')
    expect(phases).toContain('login')
    expect(phases).toContain('setup')
    expect(phases.some((p) => p.startsWith('step#0'))).toBe(true)
    expect(phases).toContain('harvest')
  })

  it('opens an identified target with bounded recovery and restores context', async () => {
    const calls: string[] = []
    const target = { ...recipe, steps: [{ kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId', maxScrolls: 1, restore: 'back' as const }] }
    const outcome = await new RecipeRunner().run(target, { noteId: 'n1' }, {
      exists: async (selector) => selector === '.me', readItems: async () => [{ id: 'n1' }],
      openTarget: async () => { calls.push('open'); return true },
      goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => { calls.push('back') }, type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {},
    })
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'back'])
  })

  it('re-enters the recipe entry page when a reused tab is somewhere else', async () => {
    const gotos: string[] = []
    const outcome = await new RecipeRunner().run(recipe, {}, fakeDriver({
      currentUrl: async () => 'https://x.test/search_result?q=old',
      goto: async (url) => { gotos.push(url) },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(gotos).toEqual(['https://x.test/'])
  })

  it('reloads a persistent tab parked on the entry page — a parked render is the previous run\'s answer', async () => {
    const gotos: string[] = []
    const outcome = await new RecipeRunner().run(recipe, {}, fakeDriver({
      currentUrl: async () => 'https://x.test/?channel=fresh',
      goto: async (url) => { gotos.push(url) },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(gotos).toEqual(['https://x.test/'])
  })

  it('does not navigate a one-shot tab already on the entry page — it was just opened there', async () => {
    const gotos: string[] = []
    const oneShot = { ...recipe, session: { ...recipe.session, lifecycle: 'one-shot' as const } }
    const outcome = await new RecipeRunner().run(oneShot, {}, fakeDriver({
      currentUrl: async () => 'https://x.test/?channel=fresh',
      goto: async (url) => { gotos.push(url) },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(gotos).toEqual([])
  })

  it('never navigates or reloads an adopted tab — it is the user\'s live page', async () => {
    const gotos: string[] = []
    const outcome = await new RecipeRunner().run(recipe, {}, fakeDriver({
      currentUrl: async () => 'https://x.test/somewhere-else',
      goto: async (url) => { gotos.push(url) },
    }), { adoptedTab: true })
    expect(outcome.outcome).toBe('ok')
    expect(gotos).toEqual([])
  })

  it('rideCurrentPage 骑哪个 feed 就把标签还回哪个 feed —— 不是 entryUrl', async () => {
    // detail 骑的是标签当时holding的那个 feed（今天是搜索结果页）。它进场不导航，跑完也必须还回
    // **那一页**：账本记的是那一批，把标签"清理"到 entryUrl 等于把账本作废，下一次 known=0 → MISS
    // → 整页导航 → 再回 entryUrl，一次清理把后面每一次 detail 都变成 fallback-nav。
    const calls: string[] = []
    let where = 'https://x.test/search_result?q=old'
    const ride = {
      ...recipe, rideCurrentPage: true,
      steps: [{ kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId', maxScrolls: 1, restore: 'back' as const }],
    }
    const outcome = await new RecipeRunner().run(ride, { noteId: 'n1' }, fakeDriver({
      currentUrl: async () => where,
      goto: async (url) => { calls.push(`goto ${url}`) },
      // the click opens the note in place → url gains the id (observeOpened confirms)
      openTarget: async () => { calls.push('open'); where = 'https://x.test/explore/n1'; return true },
      back: async () => { calls.push('back'); where = 'https://x.test/search_result?q=old' },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(calls.indexOf('open')).toBe(0)   // no re-entry nav before the click — the feed tab served the run
    expect(calls).toEqual(['open', 'back'])  // back 就落回搜索页 = 已经到家，0 次导航
  })

  it('骑进来的是空白页 → 不认它当家，落点回 entryUrl（剪断自我延续循环）', async () => {
    // 冷启的标签是 about:blank：locate 在空白页上什么都找不到 → fallbackUrl 整页导航 → back 又回
    // 空白页 → 下一次原样重来。把 about:blank 当成"工作上下文"就是这个循环的起点（99b8c55f）。
    const calls: string[] = []
    let where = 'about:blank'
    const ride = {
      ...recipe, rideCurrentPage: true,
      steps: [{ kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId', maxScrolls: 1, restore: 'back' as const }],
    }
    const outcome = await new RecipeRunner().run(ride, { noteId: 'n1' }, fakeDriver({
      currentUrl: async () => where,
      goto: async (url) => { calls.push(`goto ${url}`) },
      openTarget: async () => { calls.push('open'); where = 'https://x.test/explore/n1'; return true },
      back: async () => { calls.push('back'); where = 'about:blank' },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'back', 'goto https://x.test/'])
  })

  it('骑进来时标签停在笔记页（上一次 fallback 留下的）→ 不认它当家', async () => {
    // 「entryUrl 和 fallbackUrl 填成一样就等于没有落点确认」那个已知的坑，换成"上一次运行把标签
    // 停在了目标页"的形状复活。判据是这次 step 自己的 fallbackUrl 目标。
    const calls: string[] = []
    let where = 'https://x.test/explore/n1'
    const ride = {
      ...recipe, rideCurrentPage: true,
      steps: [{
        kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId', maxScrolls: 1,
        restore: 'back' as const, fallbackUrl: 'https://x.test/explore/{noteId}',
      }],
    }
    const outcome = await new RecipeRunner().run(ride, { noteId: 'n1' }, fakeDriver({
      currentUrl: async () => where,
      goto: async (url) => { calls.push(`goto ${url}`) },
      openTarget: async () => { calls.push('open'); where = 'https://x.test/explore/n1'; return true },
      back: async () => { calls.push('back') },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'back', 'goto https://x.test/'])
  })

  it('locate step scrolls the ledger target into view then clicks it', async () => {
    const calls: string[] = []
    const ids = ['n0', 'n1', 'n2']
    const locateRecipe = {
      ...recipe, rideCurrentPage: true,
      steps: [{ kind: 'locate' as const, selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered', maxSteps: 4, restore: 'back' as const }],
      observers: [{ kind: 'state' as const, statePath: '__X__', trigger: 'after-step' as const, collection: 'single' as const,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { guid: 'noteId' } } }],
    }
    let rendered = false
    const outcome = await new RecipeRunner().run(locateRecipe, { noteId: 'n1', ordered: JSON.stringify(ids) }, {
      exists: async (s) => s === '.me',
      scrollProbe: async () => ({ scrollY: 0, viewportH: 500, scrollHeight: 300 }),
      readViewport: async () => (rendered ? [{ id: 'n1', top: 0, height: 100 }] : (rendered = true, [{ id: 'n0', top: 0, height: 100 }])),
      openTarget: async () => { calls.push('click'); return true },
      readState: async () => ({ noteId: 'n1' }),
      goto: async () => {}, scrollOnce: async () => { calls.push('scroll') }, openItem: async () => {}, click: async () => true, back: async () => { calls.push('back') },
      type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {}, evalJson: async () => null,
    })
    expect(outcome.outcome).toBe('ok')
    expect(calls).toContain('click')
    expect(calls[calls.length - 1]).toBe('back')
  })

  // 「在 feed 上找卡片」当然要 feed 的顺序——那是 locate 步的运行契约，不是某个调用方的事。
  // 调用方没传 `params[orderedParam]` 时，runner 按 recipe 的 facility 向注入的账本要。
  it('locate: 缺省 ordered 时按 facility 从注入的账本取，传了就用传的', async () => {
    const ids = ['n0', 'n1', 'n2']
    const locateRecipe = {
      ...recipe, rideCurrentPage: true,
      steps: [{ kind: 'locate' as const, selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered', maxSteps: 4, restore: 'back' as const }],
      observers: [{ kind: 'state' as const, statePath: '__X__', trigger: 'after-step' as const, collection: 'single' as const,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { guid: 'noteId' } } }],
    }
    const run = async (params: Record<string, string>) => {
      const lines: string[] = []
      const asked: string[] = []
      const runner = new RecipeRunner((id) => {
        const p = new RunProbe(id, false)
        const orig = p.detail.bind(p)
        p.detail = (line: string) => { lines.push(line); orig(line) }
        return p
      })
      let rendered = false
      const outcome = await runner.run(locateRecipe, params, {
        exists: async (s) => s === '.me',
        scrollProbe: async () => ({ scrollY: 0, viewportH: 500, scrollHeight: 300 }),
        readViewport: async () => (rendered ? [{ id: 'n1', top: 0, height: 100 }] : (rendered = true, [{ id: 'n0', top: 0, height: 100 }])),
        openTarget: async () => true,
        readState: async () => ({ noteId: 'n1' }),
        goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
        type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {}, evalJson: async () => null,
      }, { orderedFor: (facility) => { asked.push(facility); return ids } })
      return { outcome, lines, asked }
    }
    // 缺省：账本被问了一次（键是 recipe 的 facility），locate 拿到 3 条。
    const a = await run({ noteId: 'n1' })
    expect(a.outcome.outcome).toBe('ok')
    expect(a.asked).toEqual([recipe.session.facility])
    expect(a.lines.some((l) => l.startsWith('locate: ledger=3 targetInLedger=true'))).toBe(true)
    // 调用方显式传了（哪怕是空账本）：尊重它，账本不被问。
    const b = await run({ noteId: 'n1', ordered: '[]' })
    expect(b.asked).toEqual([])
    expect(b.lines.some((l) => l.startsWith('locate: ledger=0'))).toBe(true)
  })

  it('locate+click breaks its wall-clock into locate / humanize / open so DebugBox is not one opaque block', async () => {
    const ids = ['n0', 'n1', 'n2']
    const locateRecipe = {
      ...recipe, rideCurrentPage: true,
      steps: [{ kind: 'locate' as const, selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered', maxSteps: 4, restore: 'back' as const }],
      observers: [{ kind: 'state' as const, statePath: '__X__', trigger: 'after-step' as const, collection: 'single' as const,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { guid: 'noteId' } } }],
    }
    let rendered = false
    const outcome = await new RecipeRunner().run(locateRecipe, { noteId: 'n1', ordered: JSON.stringify(ids) }, {
      exists: async (s) => s === '.me',
      scrollProbe: async () => ({ scrollY: 0, viewportH: 500, scrollHeight: 300 }),
      readViewport: async () => (rendered ? [{ id: 'n1', top: 0, height: 100 }] : (rendered = true, [{ id: 'n0', top: 0, height: 100 }])),
      openTarget: async () => true,
      currentUrl: async () => 'https://x.test/explore/n1', // observeOpened confirms the note opened
      readState: async () => ({ noteId: 'n1' }),
      goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
      type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {}, evalJson: async () => null,
    })
    const phases = (outcome.timing ?? []).map((t) => t.phase)
    // The three sub-phases the old single `open` mark hid: locate (find the card), humanize (the
    // trusted human-like click travel), open (OBSERVE — wait for the note to open).
    // Each its own DebugBox row now — humanize vs open is the humanize-cost vs wait-cost the user wants.
    expect(phases).toContain('step#0 locate')
    expect(phases).toContain('step#0 humanize')
    expect(phases).toContain('step#0 open locate+click') // acceptance label unchanged (4 skill docs read it)
    // There is no fourth `settle` row: the fixed dwell it timed is gone, and a 0ms row would read
    // as "there is still a dwell phase, it just happens to be fast". The wait that remains is the
    // observer's own readyWhen poll, which the `state-wait` row already reports.
    expect(phases).not.toContain('step#0 settle')
    // Real execution order: locate → humanize (click) → open (observe) → state-wait. Not a relabel.
    const at = (p: string) => phases.indexOf(p)
    expect(at('step#0 locate')).toBeLessThan(at('step#0 humanize'))
    expect(at('step#0 humanize')).toBeLessThan(at('step#0 open locate+click'))
    expect(at('step#0 open locate+click')).toBeLessThan(at('step#0 state-wait'))
  })

  // ── probe 标签的护栏 ────────────────────────────────────────────────────────────────────
  // 这串标签不是内部细节：`step#0 open locate+click` / `fallback-nav` / `step#0 state-wait` 是
  // skill 文档、故障查表和验收判据 **grep 的对象**（`write-recipe/references/` 多处）。标签
  // 改一个字，一堆排错手册当场失效，而且没有任何测试会因此变红——所以这里逐字钉整条序列，
  // 不用 toContain：少一行、多一行、顺序换了，都在这儿当场失败。搬代码可以，改字不行。
  it('locate: the probe phase labels are the documented ones — verbatim, in order, nothing extra', async () => {
    const phasesOf = async (over: Record<string, unknown> = {}) => {
      const r = {
        ...recipe, rideCurrentPage: true,
        steps: [{ kind: 'locate' as const, selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered', maxSteps: 4, restore: 'back' as const, ...over }],
        observers: [{ kind: 'state' as const, statePath: '__X__', trigger: 'after-step' as const, collection: 'single' as const,
          input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { guid: 'noteId' } } }],
      }
      const outcome = await new RecipeRunner().run(r, { noteId: 'n1', ordered: JSON.stringify(['n0', 'n1']) }, {
        exists: async (s) => s === '.me' || s === '.detail-ready',
        scrollProbe: async () => ({ scrollY: 0, viewportH: 500, scrollHeight: 300 }),
        readViewport: async () => [{ id: 'n1', top: 0, height: 100 }],
        openTarget: async () => true,
        currentUrl: async () => 'https://x.test/explore/n1',
        readState: async () => ({ noteId: 'n1' }),
        goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
        type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {}, evalJson: async () => null,
      })
      expect(outcome.outcome).toBe('ok')
      return (outcome.timing ?? []).map((t) => t.phase)
    }
    expect(await phasesOf()).toEqual([
      'entry', 'login', 'setup',
      'step#0 locate', 'step#0 humanize', 'step#0 open locate+click', 'step#0 state-wait',
      'harvest',
    ])
    // 声明了 expect 才多这一行，且它落在内建确认之后、observers 读（state-wait）之前。
    // 没声明就一行都不留：一行 0ms 的空账会被读成"这里还有一道闸门，只是很快"。
    expect(await phasesOf({ expect: { selector: '.detail-ready', timeout: 30 } })).toEqual([
      'entry', 'login', 'setup',
      'step#0 locate', 'step#0 humanize', 'step#0 open locate+click', 'step#0 expect', 'step#0 state-wait',
      'harvest',
    ])
  })

  // The two tests below pin the invariant that came out of the 2026-07-27 live measurement:
  // after locate opens the note there is NO fixed dwell — the state observer's readyWhen poll is
  // the only thing that gates the read. See the comment on the `locate` branch in recipe-runner.ts
  // for the measured fill timeline.
  it('locate: nothing sleeps a fixed dwell after the note opens when the state is ready at once', async () => {
    const ids = ['n0', 'n1', 'n2']
    const locateRecipe = {
      ...recipe, rideCurrentPage: true,
      steps: [{ kind: 'locate' as const, selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered', maxSteps: 4, restore: 'back' as const }],
      observers: [{ kind: 'state' as const, statePath: '__INITIAL_STATE__.note.noteDetailMap', trigger: 'after-step' as const,
        collection: 'values' as const, keyField: 'noteId', identityParam: 'noteId',
        readyWhen: 'comments.firstRequestFinish', maxWaitMs: 15000, pollMs: 50,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { guid: 'noteId', title: 'note.title' } } }],
    }
    let opened = false
    const sleepsAfterOpen: number[] = []
    // An image note fills atomically: the first read already carries a complete entry.
    const outcome = await new RecipeRunner().run(locateRecipe, { noteId: 'n1', ordered: JSON.stringify(ids) }, {
      exists: async (s) => s === '.me',
      scrollProbe: async () => ({ scrollY: 0, viewportH: 500, scrollHeight: 300 }),
      readViewport: async () => [{ id: 'n1', top: 0, height: 100 }],
      openTarget: async () => { opened = true; return true },
      currentUrl: async () => 'https://x.test/explore/n1',
      readState: async () => ({ n1: { note: { title: 'done' }, comments: { firstRequestFinish: true } } }),
      goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
      type: async () => true, submit: async () => true, moveMouse: async () => {}, evalJson: async () => null,
      sleep: async (ms) => { if (opened) sleepsAfterOpen.push(ms) },
    })
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([{ guid: 'n1', title: 'done' }])
    // Zero sleeps: no blind dwell, and the observer offered on its very first read.
    expect(sleepsAfterOpen).toEqual([])
  })

  it('locate: a note that fills in stages is gated by readyWhen polling, not by a fixed wait', async () => {
    const ids = ['n0', 'n1', 'n2']
    const locateRecipe = {
      ...recipe, rideCurrentPage: true,
      steps: [{ kind: 'locate' as const, selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered', maxSteps: 4, restore: 'back' as const }],
      observers: [{ kind: 'state' as const, statePath: '__INITIAL_STATE__.note.noteDetailMap', trigger: 'after-step' as const,
        collection: 'values' as const, keyField: 'noteId', identityParam: 'noteId',
        readyWhen: 'comments.firstRequestFinish', maxWaitMs: 15000, pollMs: 50,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { guid: 'noteId', title: 'note.title' } } }],
    }
    let opened = false
    const sleepsAfterOpen: number[] = []
    // A video note's three measured stages: skeleton → content filled → comments finished.
    const stages: unknown[] = [
      { undefined: {}, n1: { note: {}, comments: { firstRequestFinish: false } } },
      { undefined: {}, n1: { note: { title: 'done' }, comments: { firstRequestFinish: false } } },
      { undefined: {}, n1: { note: { title: 'done' }, comments: { firstRequestFinish: true } } },
    ]
    let reads = 0
    const outcome = await new RecipeRunner().run(locateRecipe, { noteId: 'n1', ordered: JSON.stringify(ids) }, {
      exists: async (s) => s === '.me',
      scrollProbe: async () => ({ scrollY: 0, viewportH: 500, scrollHeight: 300 }),
      readViewport: async () => [{ id: 'n1', top: 0, height: 100 }],
      openTarget: async () => { opened = true; return true },
      currentUrl: async () => 'https://x.test/explore/n1',
      readState: async () => stages[Math.min(reads++, stages.length - 1)],
      goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
      type: async () => true, submit: async () => true, moveMouse: async () => {}, evalJson: async () => null,
      sleep: async (ms) => { if (opened) sleepsAfterOpen.push(ms) },
    })
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([{ guid: 'n1', title: 'done' }])
    expect(reads).toBe(3)                       // stopped at the FIRST ready read, no extra poll
    expect(sleepsAfterOpen).toEqual([50, 50])   // only the observer's own pollMs — nothing else
  })

  // ── step.expect on locate / openTarget ──────────────────────────────────────────────────
  // These two steps carry their OWN built-in confirmation (observeOpened: does the url carry the
  // identity), which answers "did it open". `expect` is the author's EXTRA verdict — "is the thing
  // that opened the one I wanted / is the page actually ready" — so it runs AFTER the built-in one
  // and BEFORE the observers read. The order is the load-bearing part: an observer that reads a
  // wrong page harvests real-looking data from somewhere else, which is the hardest kind of bug.
  const locateStep = (over: Record<string, unknown> = {}) => ({
    kind: 'locate' as const, selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered', maxSteps: 4,
    expect: { selector: '.detail-ready', timeout: 30 }, ...over,
  })
  const locateRecipeWithExpect = (over: Record<string, unknown> = {}) => ({
    ...recipe, rideCurrentPage: true,
    steps: [locateStep(over)],
    observers: [{ kind: 'state' as const, statePath: '__X__', trigger: 'after-step' as const, collection: 'single' as const,
      input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { guid: 'noteId' } } }],
  })
  /** locate that finds + clicks the card; `hasFeature` decides whether the expect selector shows up */
  const locateDriver = (hasFeature: boolean, over: Partial<PageDriver> = {}): PageDriver => ({
    exists: async (s) => s === '.me' || (hasFeature && s === '.detail-ready'),
    scrollProbe: async () => ({ scrollY: 0, viewportH: 500, scrollHeight: 300 }),
    readViewport: async () => [{ id: 'n1', top: 0, height: 100 }],
    openTarget: async () => true,
    currentUrl: async () => 'https://x.test/explore/n1', // observeOpened confirms the note opened
    readState: async () => ({ noteId: 'n1' }),
    readItems: async () => [{ id: 'n1' }],
    goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
    type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {}, evalJson: async () => null,
    ...over,
  })

  it('locate: a satisfied expect lets the run continue and the observers read', async () => {
    const outcome = await new RecipeRunner().run(
      locateRecipeWithExpect(), { noteId: 'n1', ordered: JSON.stringify(['n0', 'n1']) }, locateDriver(true),
    )
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([{ guid: 'n1' }])
  })

  it('locate: an unmet expect throws — same error as the runActions path, naming step and selector', async () => {
    const outcome = await new RecipeRunner().run(
      locateRecipeWithExpect(), { noteId: 'n1', ordered: JSON.stringify(['n0', 'n1']) }, locateDriver(false),
    )
    expect(outcome.outcome).toBe('blocked')
    expect(outcome.reason).toMatch(/step#0 expect 未满足/)
    expect(outcome.reason).toMatch(/\.detail-ready/)
  })

  it('locate: expect runs on the fallback-nav path too — the verdict is on the final state, not the route', async () => {
    const gotos: string[] = []
    // No readViewport → locateCard gives up at once → no click → fallbackUrl nav. The page IS open,
    // just via the other route, so it must still pass the author's verdict.
    const outcome = await new RecipeRunner().run(
      locateRecipeWithExpect({ fallbackUrl: 'https://x.test/explore/{noteId}' }),
      { noteId: 'n1', ordered: JSON.stringify(['n0', 'n1']) },
      locateDriver(false, { readViewport: undefined, goto: async (url) => { gotos.push(url) } }),
    )
    expect(gotos).toEqual(['https://x.test/explore/n1']) // it really took the fallback route
    expect(outcome.outcome).toBe('blocked')
    expect(outcome.reason).toMatch(/step#0 expect 未满足/)
  })

  it('locate: expect is settled BEFORE the observers read (an observer must never read a wrong page)', async () => {
    const order: string[] = []
    const outcome = await new RecipeRunner().run(
      locateRecipeWithExpect(), { noteId: 'n1', ordered: JSON.stringify(['n0', 'n1']) },
      locateDriver(true, {
        exists: async (s) => { if (s === '.detail-ready') order.push('expect'); return s === '.me' || s === '.detail-ready' },
        readState: async () => { order.push('observe'); return { noteId: 'n1' } },
      }),
    )
    expect(outcome.outcome).toBe('ok')
    expect(order.indexOf('expect')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('expect')).toBeLessThan(order.indexOf('observe'))
  })

  // ── step.settle on locate / openTarget / evaluate ───────────────────────────────────────
  // `settle` 的语义是「动手之前，等目标那块区域画完并停住」。它过去只有走 runActions 的动作
  // 步骤收得到——`locate` 上写了照样不生效，纯粹是接线漏了：locate 干的事就是"点一张卡"，
  // 这道闸门对它完全适用。判据是「变过了 + 停住了」，所以下面的 shotOf 序列是
  // baseline('a') → 'b' → 'b'：与基线不同、且连着两帧一致。
  it('locate: settle gates the click — the area must have painted and stopped before the card is pressed', async () => {
    const order: string[] = []
    const frames = ['a', 'b', 'b']
    const settleRecipe = {
      ...recipe, rideCurrentPage: true,
      steps: [{
        kind: 'locate' as const, selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered', maxSteps: 4,
        settle: { selector: '.feed', stableFrames: 2, intervalMs: 0, timeout: 500 },
      }],
      observers: [{ kind: 'state' as const, statePath: '__X__', trigger: 'after-step' as const, collection: 'single' as const,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { guid: 'noteId' } } }],
    }
    const outcome = await new RecipeRunner().run(settleRecipe, { noteId: 'n1', ordered: JSON.stringify(['n0', 'n1']) }, {
      exists: async (s) => s === '.me',
      shotOf: async (s) => { order.push(`shot ${s}`); return frames.shift() ?? 'b' },
      scrollProbe: async () => ({ scrollY: 0, viewportH: 500, scrollHeight: 300 }),
      readViewport: async () => [{ id: 'n1', top: 0, height: 100 }],
      openTarget: async () => { order.push('click'); return true },
      currentUrl: async () => 'https://x.test/explore/n1',
      readState: async () => ({ noteId: 'n1' }),
      goto: async () => {}, scrollOnce: async () => {}, openItem: async () => {}, click: async () => true, back: async () => {},
      type: async () => true, submit: async () => true, sleep: async () => {}, moveMouse: async () => {}, evalJson: async () => null,
    })
    expect(outcome.outcome).toBe('ok')
    // 闸门真的开了火（盯的是 recipe 声明的那块区域），而且**在点击之前**——事后再等等于没等。
    expect(order.filter((o) => o.startsWith('shot'))).toEqual(['shot .feed', 'shot .feed', 'shot .feed'])
    expect(order.indexOf('click')).toBe(order.length - 1)
    // 它自己一行 probe：settle 最长能等 15s，不给行就把这段时间悄悄记到 `step#0 locate` 头上，
    // DebugBox 会指着一个没花时间的阶段说它慢。
    expect((outcome.timing ?? []).map((t) => t.phase)).toContain('step#0 settle')
  })

  it('openTarget: settle gates the click the same way — same contract, same place in the order', async () => {
    const order: string[] = []
    const frames = ['a', 'b', 'b']
    const target = {
      ...recipe,
      steps: [{
        kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId',
        settle: { selector: '.feed', stableFrames: 2, intervalMs: 0, timeout: 500 },
      }],
    }
    const outcome = await new RecipeRunner().run(target, { noteId: 'n1' }, fakeDriver({
      shotOf: async (s) => { order.push(`shot ${s}`); return frames.shift() ?? 'b' },
      openTarget: async () => { order.push('click'); return true },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(order).toEqual(['shot .feed', 'shot .feed', 'shot .feed', 'click'])
  })

  it('settle is a gate, not a verdict: a timeout lets the step proceed (the expect decides the outcome)', async () => {
    const order: string[] = []
    const target = {
      ...recipe,
      steps: [{
        kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId',
        // 画面永远不变 → 永远等不到"变过了" → 超时。超时照常动手，不阻断。
        settle: { selector: '.feed', stableFrames: 2, intervalMs: 0, timeout: 0 },
      }],
    }
    const outcome = await new RecipeRunner().run(target, { noteId: 'n1' }, fakeDriver({
      shotOf: async () => { order.push('shot'); return 'same' },
      openTarget: async () => { order.push('click'); return true },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(order[order.length - 1]).toBe('click')
  })

  it('openTarget: a satisfied expect lets the run continue', async () => {
    const target = {
      ...recipe,
      steps: [{ kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId', expect: { selector: '.detail-ready', timeout: 30 } }],
    }
    const outcome = await new RecipeRunner().run(target, { noteId: 'n1' }, fakeDriver({
      exists: async (s) => s === '.me' || s === '.detail-ready',
      openTarget: async () => true,
    }))
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([{ guid: 'n1' }])
  })

  it('openTarget: an unmet expect throws instead of letting the observers read the wrong page', async () => {
    const target = {
      ...recipe,
      steps: [{ kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId', expect: { selector: '.detail-ready', timeout: 30 } }],
    }
    const outcome = await new RecipeRunner().run(target, { noteId: 'n1' }, fakeDriver({
      openTarget: async () => true,
    }))
    expect(outcome.outcome).toBe('blocked')
    expect(outcome.reason).toMatch(/step#0 expect 未满足/)
    expect(outcome.reason).toMatch(/\.detail-ready/)
  })

  it('classifies a zero-item run as blocked so the session lease self-heals', async () => {
    const outcome = await new RecipeRunner().run(recipe, {}, fakeDriver({ readItems: async () => [] }))
    expect(outcome.outcome).toBe('blocked')
    expect(outcome.reason).toMatch(/no items/)
  })

  it('allowEmpty: a probe recipe treats a zero-item run as ok, not blocked', async () => {
    const probe = { ...recipe, allowEmpty: true }
    const outcome = await new RecipeRunner().run(probe, {}, fakeDriver({ readItems: async () => [] }))
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([])
  })

  it('allowEmpty still surfaces drift: a moved shape is not masked as an empty target', async () => {
    const probeDrift = {
      ...recipe,
      allowEmpty: true,
      observers: [{ kind: 'dom' as const, trigger: 'entry' as const, itemSelector: '.card', fields: { id: {} }, input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' }, assert: [{ path: 'items.0.gone', desc: 'card shape' }] } }],
    }
    const outcome = await new RecipeRunner().run(probeDrift, {}, fakeDriver())
    expect(outcome.outcome).toBe('drift')
  })

  it('classifies a zero-item run whose observers tripped asserts as drift', async () => {
    const drifting = {
      ...recipe,
      observers: [{ kind: 'dom' as const, trigger: 'entry' as const, itemSelector: '.card', fields: { id: {} }, input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' }, assert: [{ path: 'items.0.gone', desc: 'card shape' }] } }],
    }
    const outcome = await new RecipeRunner().run(drifting, {}, fakeDriver())
    expect(outcome.outcome).toBe('drift')
    expect(outcome.reason).toMatch(/malformed/)
  })

  it('restores the feed context even when a step after openTarget fails', async () => {
    const calls: string[] = []
    const target = {
      ...recipe,
      steps: [{ kind: 'openTarget' as const, selector: 'a.card', identityParam: 'noteId', restore: 'back' as const }],
      observers: [{ kind: 'state' as const, trigger: 'after-step' as const, statePath: '__S__', input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } } }],
    }
    const outcome = await new RecipeRunner().run(target, { noteId: 'n1' }, fakeDriver({
      openTarget: async () => { calls.push('open'); return true },
      readState: async () => { throw new Error('state read exploded') },
      back: async () => { calls.push('back') },
    }))
    expect(outcome.outcome).toBe('blocked')
    expect(calls).toEqual(['open', 'back'])
  })

  it('stops a run that exceeds the declared policy deadline', async () => {
    const long = { ...recipe, policy: { maxTaskMs: -1 }, steps: [{ kind: 'scroll' as const, dwell_s: [0, 0] as [number, number], maxTimes: 5, noProgressStop: 5 }] }
    const outcome = await new RecipeRunner().run(long, {}, fakeDriver({ readItems: async () => [] }))
    expect(outcome.outcome).toBe('blocked')
    expect(outcome.reason).toMatch(/deadline/)
  })

  it('paces steps by the declared minimum action interval', async () => {
    const sleeps: number[] = []
    const paced = {
      ...recipe,
      policy: { minActionIntervalMs: 50 },
      steps: [{ kind: 'goto' as const, url: 'https://x.test/a' }, { kind: 'goto' as const, url: 'https://x.test/b' }],
    }
    const outcome = await new RecipeRunner().run(paced, {}, fakeDriver({ sleep: async (ms) => { sleeps.push(ms) } }))
    expect(outcome.outcome).toBe('ok')
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThan(0)
    expect(sleeps[0]).toBeLessThanOrEqual(50)
  })

  it('classifies feature drift as drift, not blocked', async () => {
    const featured = {
      ...recipe,
      steps: [{ kind: 'type' as const, selector: '#q', text: '{keyword}', feature: { selector: '#q' } }],
    }
    const outcome = await new RecipeRunner().run(featured, { keyword: 'k' }, fakeDriver())
    expect(outcome.outcome).toBe('drift')
    expect(outcome.reason).toMatch(/Feature drift/)
  })

  it('runs an in-page evaluate step, threading its cursor until the target count', async () => {
    const calls: string[] = []
    const paged = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items', cursorField: 'cursor', pageSize: 2, maxPages: 5 }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 4, mapping: { guid: 'id' } },
    }
    const pages: Record<string, unknown> = {
      '""': { items: [{ id: 'a' }, { id: 'b' }], cursor: 'c1' },
      '"c1"': { items: [{ id: 'c' }, { id: 'd' }], cursor: 'c2' },
    }
    const outcome = await new RecipeRunner().run(paged, {}, fakeDriver({
      evalJson: async (expr) => {
        const cursor = expr.match(/\)\((""|"[^"]*")/)![1]
        calls.push(cursor)
        return pages[cursor] ?? { items: [], cursor: '' }
      },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([{ guid: 'a' }, { guid: 'b' }, { guid: 'c' }, { guid: 'd' }])
    expect(calls).toEqual(['""', '"c1"']) // stops at targetCount, no third page
  })

  it('keeps paging through pendingField pages without counting them as empty or malformed', async () => {
    // 把分页当等待循环用的 recipe(豆包生图):前几页只是「还没出图」,不是空结果
    const calls: string[] = []
    const paged = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items', cursorField: 'cursor', pendingField: 'pending', maxPages: 8 }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 4, mapping: { guid: 'id' }, assert: [{ path: 'items.0.id', desc: 'no item' }] },
    }
    const pages: Record<string, unknown> = {
      '""': { items: [], pending: true, cursor: '1' },
      '"1"': { items: [], pending: true, cursor: '2' },
      '"2"': { items: [], pending: true, cursor: '3' },
      '"3"': { items: [{ id: 'a' }], cursor: '' },
    }
    const outcome = await new RecipeRunner().run(paged, {}, fakeDriver({
      evalJson: async (expr) => {
        const cursor = expr.match(/\)\((""|"[^"]*")/)![1]
        calls.push(cursor)
        return pages[cursor] ?? { items: [], cursor: '' }
      },
    }))
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([{ guid: 'a' }])
    expect(calls).toEqual(['""', '"1"', '"2"', '"3"'])
  })

  it('surfaces an in-page evaluate failure as drift, not a silent empty ok', async () => {
    const paged = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 4, mapping: { guid: 'id' } },
    }
    const outcome = await new RecipeRunner().run(paged, {}, fakeDriver({
      evalJson: async () => { throw new Error('homefeed module not found') },
    }))
    expect(outcome.outcome).toBe('drift')
    expect(outcome.reason).toMatch(/homefeed module not found/)
  })

  it('retries an evaluate page once when the execution context detaches, instead of calling it drift', async () => {
    // 一次 detach 被当成 drift 的代价不是"这一轮失败"，是这个源被 RepairLedger 隔离、
    // 从此静默不跑（返回 items:0 + errors:[]，和"没搜到"分不出来）。所以瞬态必须挡在这里。
    const paged = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 2, mapping: { guid: 'id' } },
    }
    let attempts = 0
    const outcome = await new RecipeRunner().run(paged, {}, fakeDriver({
      evalJson: async () => {
        if (++attempts === 1) throw new Error('Detached while handling command.')
        return { items: [{ id: 'a' }, { id: 'b' }], cursor: '' }
      },
    }))
    expect(attempts).toBe(2)
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items).toEqual([{ guid: 'a' }, { guid: 'b' }])
  })

  it('gives up after one detach retry, and never retries a recipe-thrown error', async () => {
    const paged = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 2, mapping: { guid: 'id' } },
    }
    // 只数**这一步**的求值：失败路径上 runner 还会补一次撞墙探测，那也走 evalJson。
    let detachAttempts = 0
    const detached = await new RecipeRunner().run(paged, {}, fakeDriver({
      evalJson: async (expr) => {
        if (!expr.includes('(c,n)=>c')) return null
        detachAttempts++
        throw new Error('Detached while handling command.')
      },
    }))
    expect(detachAttempts).toBe(2)
    expect(detached.outcome).toBe('drift')

    // 业务错（风控挡下、模块搬家）**不重发**——重做一次有副作用的请求不叫重试。
    let businessAttempts = 0
    const business = await new RecipeRunner().run(paged, {}, fakeDriver({
      evalJson: async (expr) => {
        if (!expr.includes('(c,n)=>c')) return null
        businessAttempts++
        throw new Error('douyin: search/item did not settle in 5s')
      },
    }))
    expect(businessAttempts).toBe(1)
    expect(business.outcome).toBe('drift')
  })

  it('挑战优先于墙：验证码遮罩底下压着登录入口时，判的是 challenged 不是 needsLogin', async () => {
    // 两者对用户的动作要求相反（去登录 vs 什么都不用做）。遮罩底下常常还压着站点自己的
    // 登录入口，所以两个选择器可能同时命中——先问墙就会把"站方让我们等"读成"你得去登录"。
    const chal = { ...recipe, loginCheck: { loggedIn: '.me', wall: '.wall', challenge: '.captcha' } }
    const out = await new RecipeRunner().run(chal, {}, fakeDriver({
      exists: async (s) => s === '.captcha' || s === '.wall' || s === '.me',
    }))
    expect(out.outcome).toBe('challenged')
  })

  it('挑战绝不记 drift —— 这正是那次静默隔离的来源', async () => {
    const chal = {
      ...recipe,
      loginCheck: { loggedIn: '.me', wall: '.wall', challenge: '.captcha' },
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 2, mapping: { guid: 'id' } },
    }
    // 页内抛错（风控把请求挡了）本来会走 drift；失败路径上补探到挑战，必须翻成 challenged。
    const out = await new RecipeRunner().run(chal, {}, fakeDriver({
      exists: async (s) => s === '.captcha' || s === '.me',
      evalJson: async () => { throw new Error('douyin: search/item did not settle in 5s') },
    }))
    expect(out.outcome).toBe('challenged')
    expect(out.outcome).not.toBe('drift')
  })

  it('没声明 challenge 的 recipe 一切照旧（这一格是可选的，不能改变既有行为）', async () => {
    const out = await new RecipeRunner().run(recipe, {}, fakeDriver({
      exists: async (s) => s === '.wall' || s === '.me',
    }))
    expect(out.outcome).toBe('needsLogin')
  })

  // `runAtWall` 是给**登录 recipe** 开的：它降落的那一页按定义就是墙，不松开入场闸就连
  // 动手的机会都没有。松的只有入场那一次。
  it('runAtWall：入场时墙在也照跑，不当场判 needsLogin', async () => {
    const login = { ...recipe, loginCheck: { ...recipe.loginCheck, runAtWall: true } }
    const out = await new RecipeRunner().run(login, {}, fakeDriver({
      // 墙一直在（登录页），但 recipe 该跑完自己的步骤
      exists: async (s) => s === '.wall',
    }))
    expect(out.outcome).not.toBe('needsLogin')
  })

  it('runAtWall 只松入场：跑完之后墙还在，照旧如实翻成 needsLogin', async () => {
    // 这一条是那个开关的安全网——登录失败时人还留在登录页，结论必须是"没登录成功"，
    // 不能因为开了 runAtWall 就被盖成 ok。
    const login = {
      ...recipe,
      loginCheck: { ...recipe.loginCheck, runAtWall: true },
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 2, mapping: { guid: 'id' } },
    }
    const out = await new RecipeRunner().run(login, {}, fakeDriver({
      exists: async (s) => s === '.wall',
      evalJson: async () => { throw new Error('boom') },
    }))
    expect(out.outcome).toBe('needsLogin')
  })

  it('不开 runAtWall 的 recipe 一切照旧 —— 这一格是可选的，不能改变既有行为', async () => {
    const out = await new RecipeRunner().run(recipe, {}, fakeDriver({
      exists: async (s) => s === '.wall' || s === '.me',
    }))
    expect(out.outcome).toBe('needsLogin')
  })

  it('reclassifies a drift as needsLogin when a wall is standing after the failure', async () => {
    // 风控挑战让 evaluate 抛错，判成 drift 就会被 RepairLedger 隔离，此后返回 items:0 + errors:[]
    // ——和「跑成功了但没搜到」分不出来。阳性的墙必须翻案，走 needsLogin + facility 冷却。
    const paged = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 2, mapping: { guid: 'id' } },
    }
    const walled = await new RecipeRunner().run(paged, {}, fakeDriver({
      exists: async (s) => s === '.me' || s === '.wall',
      evalJson: async () => { throw new Error('douyin: search/item did not settle in 5s') },
    }))
    expect(walled.outcome).toBe('needsLogin')

    // 没有墙时 drift 还是 drift —— 只有阳性的墙才翻案，否则真 drift 会被伪装成"等一等"、跳过隔离。
    const drifted = await new RecipeRunner().run(paged, {}, fakeDriver({
      exists: async (s) => s === '.me',
      evalJson: async () => { throw new Error('douyin: search/item did not settle in 5s') },
    }))
    expect(drifted.outcome).toBe('drift')
  })

  it('fails explicitly when the driver cannot evaluate in-page', async () => {
    const paged = {
      ...recipe,
      steps: [{ kind: 'evaluate' as const, call: '(c,n)=>c', itemsAt: 'items' }],
      observers: [],
    }
    const outcome = await new RecipeRunner().run(paged, {}, fakeDriver())
    expect(outcome.outcome).toBe('blocked')
    expect(outcome.reason).toMatch(/in-page evaluate capability/)
  })

  it('classifies a login wall appearing mid-run as needsLogin', async () => {
    let wallProbes = 0
    const outcome = await new RecipeRunner().run(
      { ...recipe, steps: [{ kind: 'scroll', dwell_s: [0, 0], maxTimes: 3, noProgressStop: 3 }] },
      {},
      fakeDriver({
        exists: async (selector) => selector === '.wall' ? ++wallProbes >= 2 : selector === '.me',
        readItems: async () => [],
      }),
    )
    expect(outcome.outcome).toBe('needsLogin')
  })
})

/**
 * `restore` 之后的**落点确认**。
 *
 * 背景（活体实测，不是推断）：detail 骑着当前页跑（`rideCurrentPage`），`restore: 'back'` 之后
 * 历史栈上一个可能是 `about:blank`（cloak 冷启的空白 tab）——于是下一次 locate 在空白页上找不到
 * 任何卡片，只能整页导航到 `fallbackUrl`，`back` 又回到 `about:blank`，循环自我延续。
 *
 * 所以 `back` 之后要**看一眼落在哪**：不在 entry 的上下文才补一次 `goto`。反过来（无条件 goto）
 * 会给每一次命中 overlay 的 detail 都加一次整页导航——而整页导航是唯一会压崩渲染进程的操作。
 */
describe('RecipeRunner restore landing check', () => {
  const detailRecipe = (restore?: 'back' | 'entry'): CanonicalBrowserRecipe => ({
    ...recipe,
    entryUrl: 'https://x.test/explore',
    rideCurrentPage: true,
    steps: [{ kind: 'openTarget', selector: 'a.card', identityParam: 'noteId', maxScrolls: 1, ...(restore ? { restore } : {}) }],
  })

  /** feed → (openTarget) 详情页 → (back) `landing`。`landing: null` = 驱动报不出 URL。 */
  function detailDriver(landing: string | null, opts: { backThrows?: boolean; noCurrentUrl?: boolean; gotoThrows?: boolean } = {}) {
    const calls: string[] = []
    let where = 'https://x.test/explore'
    const driver = fakeDriver({
      ...(opts.noCurrentUrl ? {} : { currentUrl: async () => where }),
      openTarget: async () => { calls.push('open'); where = 'https://x.test/explore/n1'; return true },
      back: async () => {
        calls.push('back')
        if (opts.backThrows) throw new Error('back exploded')
        if (landing) where = landing
      },
      goto: async (url) => {
        calls.push(`goto ${url}`)
        // 真浏览器上的常态：SPA 自己的路由跳转 / back 的导航尾巴撞上这次 goto。
        if (opts.gotoThrows) throw new Error(`Navigation to "${url}" is interrupted by another navigation to "${url}?channel=fresh"`)
      },
    })
    return { driver, calls }
  }

  it('leaves the tab alone when back lands back in the entry context — 0 navigations', async () => {
    const { driver, calls } = detailDriver('https://x.test/explore?channel=fresh')
    const outcome = await new RecipeRunner().run(detailRecipe('back'), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'back'])
  })

  it('re-enters the entry page when back lands on about:blank (the cold-start blank tab)', async () => {
    const { driver, calls } = detailDriver('about:blank')
    const outcome = await new RecipeRunner().run(detailRecipe('back'), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'back', 'goto https://x.test/explore'])
  })

  it('re-enters the entry page when back leaves the tab parked on the target detail page', async () => {
    const { driver, calls } = detailDriver('https://x.test/explore/n1')
    const outcome = await new RecipeRunner().run(detailRecipe('back'), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'back', 'goto https://x.test/explore'])
  })

  it('still re-enters when back itself throws, without surfacing that as the run outcome', async () => {
    const { driver, calls } = detailDriver(null, { backThrows: true })
    const outcome = await new RecipeRunner().run(detailRecipe('back'), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'back', 'goto https://x.test/explore'])
  })

  // 活体回归（2026-07-27）：采集本身全程成功（probe `ok`、1 项、落点也确实回到了 /explore），
  // 但落点确认的 goto 抛了 `interrupted by another navigation`，整个 /api/enrich 变成 502。
  // 清理动作失败**不能**盖掉一次已经完成的采集——这和 captureScene「取证失败绝不能盖掉真正的
  // 失败原因」是同一条原则的两面。
  it('keeps a successful harvest when the landing-check goto throws — cleanup must not sink the run', async () => {
    const { driver, calls } = detailDriver('about:blank', { gotoThrows: true })
    const outcome = await new RecipeRunner().run(detailRecipe('back'), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('ok')
    expect(outcome.items.length).toBeGreaterThan(0)
    expect(calls).toEqual(['open', 'back', 'goto https://x.test/explore'])
  })

  it('skips the landing check when the driver cannot report its URL — never navigates on a guess', async () => {
    const { driver, calls } = detailDriver(null, { noCurrentUrl: true })
    const outcome = await new RecipeRunner().run(detailRecipe('back'), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'back'])
  })

  it("restore: 'entry' is unchanged — one goto, no back, no extra check", async () => {
    const { driver, calls } = detailDriver('https://x.test/explore')
    const outcome = await new RecipeRunner().run(detailRecipe('entry'), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open', 'goto https://x.test/explore'])
  })

  // 边界：只有**落点确认**那一步才吞错。`restore: 'entry'` 的 goto 是 recipe 显式声明的动作，
  // 不是兜底清理——它失败必须冒出去，别被顺手一起吞掉。
  it("restore: 'entry' still surfaces a failing goto — only the landing check swallows", async () => {
    const { driver, calls } = detailDriver('https://x.test/explore', { gotoThrows: true })
    const outcome = await new RecipeRunner().run(detailRecipe('entry'), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('blocked')
    expect(outcome.reason).toContain('interrupted by another navigation')
    expect(calls).toEqual(['open', 'goto https://x.test/explore'])
  })

  it('does nothing at all when the step declares no restore', async () => {
    const { driver, calls } = detailDriver('https://x.test/explore')
    const outcome = await new RecipeRunner().run(detailRecipe(), { noteId: 'n1' }, driver)
    expect(outcome.outcome).toBe('ok')
    expect(calls).toEqual(['open'])
  })
})

/**
 * 步骤层的 `retryFrom` —— 整段重来。
 *
 * 和 `expect.retryEvery`（重做这一步）是两件事：有些流程第一次失败之后，**前面那一步的产物也
 * 作废了**，只重做最后一步是纯空转。原型是图形验证码：提交被拒 → 那张图作废 → 必须回到
 * "换一张图 → 重新识别 → 重新填"。同一条流程的既有实现（Cockpit 的 auth.py）重试上限就是 5 次。
 */
describe('RecipeRunner —— retryFrom（整段重来）', () => {
  /** step0 click（换一张） → step1 type（填） → step2 submit（判定，不满足就回 step0）。 */
  const retryRecipe = (retryTimes: number): CanonicalBrowserRecipe => ({
    ...recipe,
    steps: [
      { kind: 'click', selector: '#refresh' },
      { kind: 'type', selector: '#code', text: 'x' },
      {
        kind: 'submit',
        selector: '#go',
        // 判据故意不用 `.wall`：那是 loginCheck 的墙，它在场时 runner 会先判成 needsLogin，
        // 这条测试就永远量不到重试。用表单本身当判据（成功 = 表单没了），和 dfcf 那条一致。
        retryFrom: 0,
        retryTimes,
        expect: { selector: '#form', state: 'gone', timeout: 50 },
      },
    ],
  })

  it('判定不满足 → 回到第 0 步整段重走，直到满足', async () => {
    const done: string[] = []
    let submits = 0
    // 前两次提交被"拒"（.wall 还在），第三次才过。
    const outcome = await new RecipeRunner().run(retryRecipe(5), {}, fakeDriver({
      click: async (s) => { done.push(`click:${s}`); return true },
      type: async (s) => { done.push(`type:${s}`); return true },
      submit: async (s) => { done.push(`submit:${s}`); submits++; return true },
      exists: async (s) => (s === '#form' ? submits < 3 : s === '.me'),
    }))
    expect(outcome.outcome).toBe('ok')
    expect(submits).toBe(3)
    // 关键：**每次重来都从第 0 步开始**，不是只重做 submit。少了这一条，验证码那张图永远不换。
    expect(done.filter((d) => d === 'click:#refresh')).toHaveLength(3)
    expect(done.filter((d) => d === 'type:#code')).toHaveLength(3)
  })

  it('用完次数上限就如实失败，不是无限重来', async () => {
    let submits = 0
    const outcome = await new RecipeRunner().run(retryRecipe(3), {}, fakeDriver({
      submit: async () => { submits++; return true },
      exists: async (s) => (s === '#form' ? true : s === '.me'), // 永远拒
    }))
    expect(outcome.outcome).not.toBe('ok')
    expect(submits).toBe(3) // 恰好 3 次：第一次 + 2 次重来
  })

  /**
   * **这一条是 2026-09-03 那次活体失败的回归测试。**
   *
   * 关键在于这个 `call` 步**没有 `expect`**——那正是真实 recipe 的形状：OCR 认完之后页面上
   * 没有任何东西可断言（`StepExpect.selector` 是必填的，编一个出来就是把恒真判据写进去）。
   * 重试字段曾经长在 `expect` 里，于是这一步根本没地方声明重试，识别一错就整条流程终止。
   *
   * 老写法下这条测试是**红的**：`step.expect?.retryFrom` 恒为 undefined，第一次 `240`
   * 就抛出去了。之前那条同名测试之所以是绿的，是因为它给 call 步编了个 `expect.selector`
   * ——机制在测试里成立，在真 recipe 里够不着。
   */
  it('call 的 match 不合格 → 整段重来，且这一步不需要 expect', async () => {
    let calls = 0
    const withCall: CanonicalBrowserRecipe = {
      ...recipe,
      // `call` 会把页面上一块东西发出去，没在 effects 里申报过就不许跑（边界 3）。
      meta: { effects: ['send'] },
      steps: [
        { kind: 'click', selector: '#refresh' },
        {
          kind: 'call', service: 'ocr', path: '/ocr', input: { shotOf: '#img' },
          from: 'text', bind: 'code', match: '^\\d{4}$',
          retryFrom: 0, retryTimes: 4,
        },
      ],
    }
    // `call` 的出口是**构造参数**（宿主注入），不是 run() 的 opts——recipe 只给得出服务名。
    // 前两次吐不合法的结果（3 位），第三次才合格 —— 正是实测撞到的那种。
    const runner = new RecipeRunner(undefined, undefined, undefined, undefined, undefined,
      async () => ({ text: ++calls < 3 ? '240' : '1234' }))
    const done: string[] = []
    const outcome = await runner.run(withCall, {}, fakeDriver({
      click: async (s) => { done.push(s); return true },
      shotOf: async () => 'AAAA',
    }))
    expect(outcome.outcome).toBe('ok')
    expect(calls).toBe(3)
    // 每次重来都真的回去点了那张图——不换图的"重试"只会把同一张图再认一遍，纯空转。
    expect(done.filter((d) => d === '#refresh')).toHaveLength(3)
  })

  it('用完次数上限的 call 如实失败，不是无限重认', async () => {
    let calls = 0
    const withCall: CanonicalBrowserRecipe = {
      ...recipe,
      meta: { effects: ['send'] },
      steps: [
        { kind: 'click', selector: '#refresh' },
        {
          kind: 'call', service: 'ocr', path: '/ocr', input: { shotOf: '#img' },
          from: 'text', bind: 'code', match: '^\\d{4}$',
          retryFrom: 0, retryTimes: 3,
        },
      ],
    }
    const runner = new RecipeRunner(undefined, undefined, undefined, undefined, undefined,
      async () => { calls++; return { text: '240' } }) // 永远不合格
    const outcome = await runner.run(withCall, {}, fakeDriver({ shotOf: async () => 'AAAA' }))
    expect(outcome.outcome).not.toBe('ok')
    expect(calls).toBe(3) // 恰好 3 次：第一次 + 2 次重来
  })

  /**
   * `call.options`：recipe 里写死的字面量，原样并进请求体；`image` 永远压在最后。
   * 第一个用例是 OCR 的字符集——限字符集是通用机制，限成哪一套是站点知识。
   */
  it('call.options 原样进请求体，且盖不掉 image', async () => {
    const sent: Array<Record<string, unknown>> = []
    const withCall: CanonicalBrowserRecipe = {
      ...recipe,
      meta: { effects: ['send'] },
      steps: [
        {
          kind: 'call', service: 'ocr', path: '/ocr', input: { shotOf: '#img' },
          options: { charset: '0123456789' },
          from: 'text', bind: 'code',
        },
      ],
    }
    const runner = new RecipeRunner(undefined, undefined, undefined, undefined, undefined,
      async (_s, _p, body) => { sent.push(body); return { text: '1234' } })
    const outcome = await runner.run(withCall, {}, fakeDriver({ shotOf: async () => 'AAAA' }))
    expect(outcome.outcome).toBe('ok')
    expect(sent).toEqual([{ charset: '0123456789', image: 'AAAA' }])
  })
})

describe('落空之后按状态图认一眼', () => {
  /**
   * 让进场那一步抛错 → 落进外层 catch（outcome 先被判成 blocked），再看状态图怎么改判。
   *
   * `currentUrl` 必须给且不同于 entryUrl：runner 只在「当前不在进场页」时才 goto，
   * 缺了它 goto 压根不会被调用，这一趟会一路绿到 ok。
   */
  const boom = (present: string[]) =>
    fakeDriver({
      currentUrl: async () => 'https://elsewhere.test/',
      goto: async () => { throw new Error('boom') },
      exists: async (s: string) => present.includes(s),
    })

  it('认出死路 → challenged，且 reason 里点名是哪个状态', async () => {
    const out = await new RecipeRunner().run(recipe, {}, boom(['.cf-error-overview, #cf-error-details, [data-translate="error"]']))
    expect(out.outcome).toBe('challenged')
    expect(out.reason).toContain('cf/banned')
  })

  // 判 drift 会让 RepairLedger 隔离这个源，此后 items:0 + errors:[]——和「跑成功了但确实
  // 没搜到」一模一样。一次风控挑战会把源永久静默地关掉，所以这条单独钉。
  it('绝不判 drift——recipe 一个字都没坏', async () => {
    const out = await new RecipeRunner().run(recipe, {}, boom(['.cf-error-overview, #cf-error-details, [data-translate="error"]']))
    expect(out.outcome).not.toBe('drift')
  })

  it('图里一条都不认得时，结论和理由都不变', async () => {
    const clean = await new RecipeRunner().run(recipe, {}, boom(['.article']))
    expect(clean.outcome).toBe('blocked')
    expect(clean.reason).toBe('boom')
  })

  // identified 说的是「落在了一个已知状态」，而那多半是 recipe 自己图里的普通状态——
  // 那是漂了不是被挑战。翻成 challenged 会让 facility 白白进冷却，所以只补话、不改结论。
  it('认出一个普通已知状态：只补一句话，绝不改结论', async () => {
    const graph = { states: [{ id: 'x/home', features: [{ kind: 'dom' as const, selector: '.home' }] }], transitions: [] }
    const out = await new RecipeRunner().run(recipe, {}, boom(['.home']), { stateGraph: graph })
    expect(out.outcome).toBe('blocked')
    expect(out.reason).toContain('x/home')
  })

  // 传本地图**不该**把内置的 CF 三档换掉。换掉的症状是"这个源莫名其妙被隔离"：认不出封禁页
  // → 判 drift → RepairLedger 连着几次把源关掉，而没有任何一处会说出原因。
  it('传了本地图，内置的全局那张还在——不是替换是合并', async () => {
    const graph = { states: [{ id: 'x/home', features: [{ kind: 'dom' as const, selector: '.home' }] }], transitions: [] }
    const out = await new RecipeRunner().run(
      recipe, {}, boom(['.cf-error-overview, #cf-error-details, [data-translate="error"]']), { stateGraph: graph },
    )
    expect(out.outcome).toBe('challenged')
    expect(out.reason).toContain('cf/banned')
  })

  it('同组多命中：也只补一句话——它是「特征写松了」的信号，不是关于站点的结论', async () => {
    const graph = {
      states: [
        { id: 'a', features: [{ kind: 'dom' as const, selector: '.both' }] },
        { id: 'b', features: [{ kind: 'dom' as const, selector: '.both' }] },
      ],
      transitions: [],
    }
    const out = await new RecipeRunner().run(recipe, {}, boom(['.both']), { stateGraph: graph })
    expect(out.outcome).toBe('blocked')
    expect(out.reason).toContain('同组多命中')
  })
})

describe('撞上全局障碍就清掉、重试那一步', () => {
  /**
   * 一步 click + 一个必须出现的判据；判据不出现就是 `StepExpectError`。
   *
   * **别用 scroll 当这个动作**：观测器一旦已经满足 targetCount，scroll 会整步被跳过
   * （`scroll skipped: target already reached`），于是这一步根本没有"动作"可言，
   * 测的就不是要测的东西了。
   */
  const gated: CanonicalBrowserRecipe = {
    ...recipe,
    steps: [{ kind: 'click', selector: '.go', expect: { selector: '.done', timeout: 20 } }],
  }
  /** 用自造的小图，不依赖 CF 那份数据的选择器文本——那份有它自己的用例。 */
  const graph = {
    states: [
      { id: 't/clearable', features: [{ kind: 'dom' as const, selector: '.chal' }] },
      { id: 't/dead', features: [{ kind: 'dom' as const, selector: '.banned' }], deadEnd: '这条路今天走不通' },
    ],
    transitions: [{ from: 't/clearable', steps: [{ kind: 'click', selector: '.x' }] }],
  }

  /**
   * 忠实的假页面：**障碍在场时那个动作什么也产生不了**，清掉之后它才产出 `.done`。
   *
   * 别图省事让"清除"这一下顺手把 `.done` 也加上——那样重试时判据在**动作之前**就成立了，
   * runner 里那道「expect 恒真」的闸会当场拦下（它拦得对：那样的判据区分不了"动作生效了"
   * 和"动作没生效"）。
   */
  const driverOn = (present: Set<string>, opts: { clearable?: boolean; actionWorks?: boolean } = {}) => {
    let escapes = 0
    const d = fakeDriver({
      exists: async (s: string) => present.has(s),
      click: async (s: string) => {
        if (s === '.x') { escapes++; if (opts.clearable) present.delete('.chal') }
        // 目标动作：**障碍在场时它什么也产生不了**，清掉之后才产出判据。
        if (s === '.go' && opts.actionWorks && !present.has('.chal')) present.add('.done')
        return true
      },
    })
    return { d, escapes: () => escapes }
  }

  it('可清除的障碍：清掉之后那一步重跑一次并成功', async () => {
    const { d, escapes } = driverOn(new Set(['.chal']), { clearable: true, actionWorks: true })
    const out = await new RecipeRunner().run(gated, {}, d, { stateGraph: graph })
    expect(out.outcome).toBe('ok')
    expect(escapes()).toBe(1)
  })

  // 清完还在就不是"没点中"，是"清不掉"——再清一次只是把同一件事重做一遍。
  it('清不掉：只清一次，然后干净地终止成 challenged', async () => {
    const { d, escapes } = driverOn(new Set(['.chal'])) // 怎么清都不消失
    const out = await new RecipeRunner().run(gated, {}, d, { stateGraph: graph })
    expect(out.outcome).toBe('challenged')
    expect(out.reason).toContain('t/clearable')
    expect(escapes()).toBe(1)
  })

  it('死路不重试，一次清除动作都不发', async () => {
    const { d, escapes } = driverOn(new Set(['.banned']))
    const out = await new RecipeRunner().run(gated, {}, d, { stateGraph: graph })
    expect(out.outcome).toBe('challenged')
    expect(out.reason).toContain('t/dead')
    expect(escapes()).toBe(0)
  })

  // 逃生用的是独立账本：让它复用 groupAttempts 的话，一次逃生会悄悄吃掉一次 retryFrom
  // 配额，表现成"为什么只重试了两次"，而没有任何一处说得出原因。
  it('逃生不吃掉 recipe 自己的 retryFrom 配额', async () => {
    const present = new Set(['.chal'])
    let goes = 0
    const d = fakeDriver({
      exists: async (s: string) => present.has(s),
      click: async (s: string) => {
        if (s === '.x') present.delete('.chal')  // 障碍清得掉
        if (s === '.go') goes++                  // 但目标动作始终产不出 `.done`
        return true
      },
    })
    const withRetry: CanonicalBrowserRecipe = {
      ...gated,
      steps: [{ ...gated.steps[0], retryFrom: 0, retryTimes: 2 } as never],
    }
    const out = await new RecipeRunner().run(withRetry, {}, d, { stateGraph: graph })
    // 逃生一次（第 1 次失败时）+ retryFrom 自己的 2 次，两本账各花各的 → 至少 3 次动作。
    // 若两者共用一本，逃生会吃掉一次配额，这里只会数到 2。
    expect(out.outcome).toBe('blocked')
    expect(goes).toBeGreaterThanOrEqual(3)
  })
})
