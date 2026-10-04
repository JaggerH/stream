import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeFileRecipeStore, validateRecipe, PRESSABLE_KEYS, MAX_PRESS_TIMES, DESKTOP_STEP_KINDS } from './recipe-store.ts'
import type { Recipe } from './recipe.ts'

/**
 * 「校验后写进这个文件库」——下面那一组用例原先经生产导出 `saveRecipe` 做这件事。那个导出已经删掉：
 * 它写的是 `<dir>/<sourceId>.json`，而包里的引擎只装载 `*.recipe.json`，于是拿它去写回一份候选
 * recipe 时文件会落在一个谁也不装载的地方、而回执说写成功了（这条分支上真出过一次）。
 * `<sourceId>.json` 是 `makeFileRecipeStore` 自己的文件名约定，所以这个夹具留在测试里是对的：
 * 它验的正是「这个文件库写得进、读得回」，以及 `validateRecipe` 的每一条规则。
 */
const save = (d: string, recipe: Recipe): string => {
  validateRecipe(recipe.sourceId ?? '(unknown)', recipe)
  const path = join(d, `${recipe.sourceId}.json`)
  writeFileSync(path, JSON.stringify(recipe, null, 2) + '\n')
  return path
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'recipes-'))
  writeFileSync(join(dir, 'good.json'), JSON.stringify({
    version: 1, kind: 'fetch', sourceId: 'good', cookieDomain: '', entryUrl: 'https://x/',
    request: { url: '/a?p={page}', method: 'GET' },
    pagination: { mode: 'increment', itemsAt: 'hits', param: 'page', start: 0, step: 1, maxPages: 1 },
    assert: [{ path: 'hits', desc: 'x' }], mapping: { title: 't' },
  }))
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ version: 1, kind: 'Z' }))
  writeFileSync(join(dir, 'noversion.json'), JSON.stringify({
    kind: 'http', sourceId: 'noversion',
    request: { url: 'https://x/a', method: 'GET' },
    pagination: { mode: 'increment', itemsAt: 'data', param: 'page', start: 1, step: 1, maxPages: 1 },
    assert: [], mapping: { title: 't' },
  }))
  writeFileSync(join(dir, 'plain.json'), JSON.stringify({
    version: 1, kind: 'http', sourceId: 'plain',
    request: { url: 'https://x/a?p={page}', method: 'GET' },
    pagination: { mode: 'increment', itemsAt: 'data', param: 'page', start: 1, step: 1, maxPages: 2 },
    assert: [{ path: 'data', desc: 'x' }], mapping: { title: 't' },
  }))
  writeFileSync(join(dir, 'nopage.json'), JSON.stringify({
    version: 1, kind: 'http', sourceId: 'nopage',
    request: { url: 'https://x/a', method: 'GET' },
    pagination: { mode: 'Z', itemsAt: 'data', maxPages: 1 },
    assert: [], mapping: {},
  }))
  writeFileSync(join(dir, 'compute-ok.json'), JSON.stringify({
    version: 1, kind: 'http', sourceId: 'compute-ok',
    request: { url: 'https://x/a', method: 'POST' },
    compute: { capabilities: ['hmacSha256', 'aesGcmDecrypt'], sign: '1', decode: '2' },
    pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'data', maxPages: 1 },
    assert: [], mapping: {},
  }))
  writeFileSync(join(dir, 'compute-evil.json'), JSON.stringify({
    version: 1, kind: 'http', sourceId: 'compute-evil',
    request: { url: 'https://x/a', method: 'POST' },
    compute: { capabilities: ['exfiltrate'] },
    pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'data', maxPages: 1 },
    assert: [], mapping: {},
  }))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('makeFileRecipeStore', () => {
  it('loads and returns a valid recipe by id', () => {
    const r = makeFileRecipeStore(dir).load('good')
    expect(r.sourceId).toBe('good')
    expect(r.kind).toBe('fetch')
    if (r.kind === 'fetch') {
      expect(r.pagination.mode).toBe('increment')
    }
  })
  it('throws on a missing recipe', () => {
    expect(() => makeFileRecipeStore(dir).load('nope')).toThrow(/recipe/i)
  })
  it('throws on a malformed recipe', () => {
    expect(() => makeFileRecipeStore(dir).load('bad')).toThrow(/kind|pagination/i)
  })

  /**
   * 一份**其余部分完全合法**的 recipe，只是没申报 version —— 它必须装不上。
   *
   * 为什么值得一条用例：没有这道闸门时，这份文件会安静地装载并运行，而它没有任何东西说明
   * 自己是按哪一版字段语义写的。真正的代价发生在字段**同名换义**之后：老文件照样过校验、
   * 被按新语义解释，不报错、不崩溃，只是数据悄悄变形。
   */
  it('refuses an otherwise-valid recipe that declares no version', () => {
    expect(() => makeFileRecipeStore(dir).load('noversion')).toThrow(/version must be a positive integer/)
  })

  // kind:'http' carries NO entryUrl/cookieDomain — those are browser fields. A validator
  // that demanded them would make the cheapest rung pay the most expensive rung's tax.
  it('loads an http recipe with no entryUrl and no cookieDomain', () => {
    const r = makeFileRecipeStore(dir).load('plain')
    expect(r.kind).toBe('http')
    if (r.kind === 'http') {
      expect(r.cookieDomain).toBeUndefined()
      expect(r.pagination?.mode).toBe('increment')
    }
  })

  it('holds an http recipe to the same pagination contract as a fetch recipe', () => {
    expect(() => makeFileRecipeStore(dir).load('nopage')).toThrow(/pagination\.mode/i)
  })

  it('loads an http recipe with a valid compute hook', () => {
    const r = makeFileRecipeStore(dir).load('compute-ok')
    expect(r.kind === 'http' && r.compute?.capabilities).toEqual(['hmacSha256', 'aesGcmDecrypt'])
  })

  // The install-time gate: a shared recipe cannot declare a capability the host does not
  // offer — caught when the recipe loads, the point where a human reviews what it can do.
  it('rejects a compute hook declaring an unknown capability', () => {
    expect(() => makeFileRecipeStore(dir).load('compute-evil')).toThrow(/unknown capability "exfiltrate"/i)
  })
})

describe('validateRecipe + 写进文件库', () => {
  const recipe: Recipe = {
    version: 1, kind: 'fetch', sourceId: 'saved', cookieDomain: '', entryUrl: 'https://x/',
    request: { url: '/a?p={page}', method: 'GET' },
    pagination: { mode: 'increment', itemsAt: 'hits', param: 'page', start: 0, step: 1, maxPages: 1 },
    assert: [{ path: 'hits', desc: 'x' }], mapping: { title: 't' },
  }

  it('writes a recipe that loads back equal', () => {
    const path = save(dir, recipe)
    expect(path).toContain('saved.json')
    expect(makeFileRecipeStore(dir).load('saved')).toEqual(recipe)
  })

  it('throws on an invalid recipe (bad kind)', () => {
    expect(() => save(dir, { ...recipe, kind: 'Z' } as unknown as Recipe)).toThrow(/kind/i)
  })

  it('saves and loads a valid tier C recipe', () => {
    const recipeC: Recipe = {
      version: 1, kind: 'browser', sourceId: 'goodC', cookieDomain: 'x.com', entryUrl: 'https://x/',
      loginCheck: { loggedIn: '.me', wall: '.login-wall' },
      actions: [{ kind: 'goto', url: 'https://x/' }],
      harvest: { urlPattern: '*/feed*', dedupeBy: 'id', itemsAt: 'data', targetCount: 10, mapping: {}, assert: [] },
    }
    const path = save(dir, recipeC)
    expect(path).toContain('goodC.json')
    expect(makeFileRecipeStore(dir).load('goodC')).toEqual(recipeC)
  })

  it('throws on invalid tier C recipe (empty actions)', () => {
    const badC: any = {
      version: 1, kind: 'browser', sourceId: 'badC', cookieDomain: 'x.com', entryUrl: 'https://x/',
      loginCheck: { loggedIn: '.me', wall: '.login-wall' },
      actions: [],
      harvest: { urlPattern: '*/feed*', dedupeBy: 'id', itemsAt: 'data', targetCount: 10, mapping: {}, assert: [] },
    }
    expect(() => save(dir, badC)).toThrow(/actions/i)
  })

  it('accepts an eval harvest with empty actions (no scroll/click; a self-paced request loop)', () => {
    const evalC: Recipe = {
      version: 1, kind: 'browser', sourceId: 'goodEval', cookieDomain: 'x.com', entryUrl: 'https://x/',
      loginCheck: { loggedIn: '.me', wall: '.login-wall' },
      actions: [],
      harvest: {
        mode: 'eval', call: 'async (c, n) => ({ items: [], cursor: "" })',
        itemsAt: 'items', cursorField: 'cursor', dedupeBy: 'id', targetCount: 10,
        mapping: { note_id: 'id' },
      },
    }
    const path = save(dir, evalC)
    expect(path).toContain('goodEval.json')
    expect(makeFileRecipeStore(dir).load('goodEval')).toEqual(evalC)
  })

  it('throws on an eval harvest missing call / mapping', () => {
    const badEval: any = {
      version: 1, kind: 'browser', sourceId: 'badEval', cookieDomain: 'x.com', entryUrl: 'https://x/',
      loginCheck: { loggedIn: '.me', wall: '.login-wall' },
      actions: [],
      harvest: { mode: 'eval', itemsAt: 'items', cursorField: 'cursor', dedupeBy: 'id', targetCount: 10, mapping: {} },
    }
    expect(() => save(dir, badEval)).toThrow(/eval harvest/i)
  })

  it('accepts the canonical session + steps + observers + output shape', () => {
    const canonical: Recipe = {
      version: 2, kind: 'browser', sourceId: 'canonical', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [{ kind: 'scroll', dwell_s: [1, 2], maxTimes: 2, noProgressStop: 1 }],
      observers: [
        { kind: 'network', urlPattern: '*/feed*', windowMs: 30_000, maxBodyBytes: 1024 },
        { kind: 'dom', itemSelector: '.card', fields: { id: { attr: 'data-id' } }, trigger: 'after-step', fallback: true },
      ],
      output: { itemsAt: 'data.items', dedupeBy: 'id', targetCount: 10, mapping: { guid: 'id' } },
    }
    const path = save(dir, canonical)
    expect(makeFileRecipeStore(dir).load('canonical')).toEqual(canonical)
    expect(path).toContain('canonical.json')
  })

  it('output.files：键必须是 mapping 字段、要么 ext 要么 extFrom（extFrom 也得是 mapping 字段）——声明错了装载期就响', () => {
    const base: Recipe = {
      version: 2, kind: 'browser', sourceId: 'files', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'one-shot', visibility: 'unattended' },
      steps: [], observers: [{ kind: 'network', urlPattern: '*/export*', windowMs: 30_000, maxBodyBytes: 1024 }],
      output: { itemsAt: 'items', dedupeBy: 'guid', targetCount: 1, mapping: { guid: 'guid', format: 'format', file: 'data' } },
    }
    const withFiles = (files: unknown): Recipe =>
      ({ ...base, output: { ...base.output, files } }) as Recipe
    const ok = withFiles({ file: { extFrom: 'format' } })
    save(dir, ok)
    expect(makeFileRecipeStore(dir).load('files')).toEqual(ok)
    for (const [bad, msg] of [
      [{ data: { ext: 'png' } }, /not a mapping field/],
      [{ file: {} }, /needs ext or extFrom/],
      [{ file: { extFrom: 'nope' } }, /extFrom "nope" is not a mapping field/],
      [['file'], /must be an object/],
    ] as const) {
      expect(() => {
        save(dir, withFiles(bad))
        makeFileRecipeStore(dir).load('files')
      }).toThrow(msg)
    }
  })

  it('accepts visibility:interactive + a ledger declaration（search feed 那一档）', () => {
    const feed: Recipe = {
      version: 2, kind: 'browser', sourceId: 'feed-ledger', cookieDomain: 'x.com', entryUrl: 'https://x.com/s?q={q}',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'interactive' },
      ledger: { idField: 'noteId' },
      steps: [{ kind: 'scroll', dwell_s: [1, 2], maxTimes: 2, noProgressStop: 1 }],
      observers: [{ kind: 'network', urlPattern: '*/search*', windowMs: 30_000, maxBodyBytes: 1024 }],
      output: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 10, mapping: { guid: 'noteId' } },
    }
    save(dir, feed)
    expect(makeFileRecipeStore(dir).load('feed-ledger')).toEqual(feed)
  })

  // 写错的 ledger 静默失效，而失效的表现是下游 detail 每次都掉进 fallback-nav——有数据、不报错。
  it('rejects a ledger without a usable idField', () => {
    const bad: any = {
      version: 2, kind: 'browser', sourceId: 'bad-ledger', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      ledger: { idFeild: 'noteId' },
      steps: [],
      observers: [{ kind: 'state', statePath: '__STATE__.note', trigger: 'entry' }],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    expect(() => save(dir, bad)).toThrow(/ledger/i)
  })

  it('rejects an unknown visibility', () => {
    const bad: any = {
      version: 2, kind: 'browser', sourceId: 'bad-visibility', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'front' },
      steps: [],
      observers: [{ kind: 'state', statePath: '__STATE__.note', trigger: 'entry' }],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    expect(() => save(dir, bad)).toThrow(/valid session/i)
  })

  // 三档收敛成两档时是**硬切**（不留别名映射，见该次提交）。硬切的代价必须由报错承担：
  // 一份写着旧值的 recipe 装不上时，人要能从报错本身知道改成什么，而不是去翻 git log。
  // 光说 "invalid visibility" 等于把成本转嫁给下一个人。
  it.each([
    ['silent', /unattended/],
    ['debug', /interactive/],
    ['foreground', /interactive/],
  ])('拒绝退役的 visibility:%s，并在报错里说清改成什么', (retired, hint) => {
    const bad: any = {
      version: 2, kind: 'browser', sourceId: `retired-${retired}`, cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: retired },
      steps: [],
      observers: [{ kind: 'state', statePath: '__STATE__.note', trigger: 'entry' }],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    expect(() => save(dir, bad)).toThrow(hint)
  })

  it('accepts an observer-less recipe whose evaluate step produces the items', () => {
    const evalOnly: Recipe = {
      version: 2, kind: 'browser', sourceId: 'eval-only', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [{ kind: 'evaluate', call: 'async()=>({items:[]})', itemsAt: 'items' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 10, mapping: { guid: 'id' } },
    }
    save(dir, evalOnly)
    expect(makeFileRecipeStore(dir).load('eval-only')).toEqual(evalOnly)
  })

  it('accepts a step-less recipe whose entry-triggered state observer produces the items', () => {
    const stateOnly: Recipe = {
      version: 2, kind: 'browser', sourceId: 'state-only', cookieDomain: 'x.com', entryUrl: 'https://x.com/n/{id}',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [],
      observers: [{ kind: 'state', statePath: '__STATE__.note', trigger: 'entry' }],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    save(dir, stateOnly)
    expect(makeFileRecipeStore(dir).load('state-only')).toEqual(stateOnly)
  })

  it('rejects an evaluate step missing its call or itemsAt', () => {
    const bad: any = {
      version: 2, kind: 'browser', sourceId: 'bad-evaluate', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [{ kind: 'evaluate', call: 'async()=>({items:[]})' }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    expect(() => save(dir, bad)).toThrow(/evaluate step/i)
  })

  it('rejects a recipe with no item source at all — no observers and no producing step', () => {
    const empty: any = {
      version: 2, kind: 'browser', sourceId: 'no-source', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [{ kind: 'scroll', dwell_s: [1, 2], maxTimes: 2, noProgressStop: 1 }],
      observers: [],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    expect(() => save(dir, empty)).toThrow(/item source/i)
  })

  it('rejects an unbounded canonical Network observer', () => {
    const bad: any = {
      version: 2, kind: 'browser', sourceId: 'bad-network', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [{ kind: 'goto', url: 'https://x.com/' }],
      observers: [{ kind: 'network', urlPattern: '*/feed*', windowMs: 0, maxBodyBytes: 0 }],
      output: { itemsAt: 'data.items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    expect(() => save(dir, bad)).toThrow(/positive bounds/i)
  })

  it('rejects removed random humanize fields instead of silently ignoring them', () => {
    const oldRecipe: any = {
      version: 2, kind: 'browser', sourceId: 'old-humanize', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [{ kind: 'scroll', dwell_s: [1, 2], maxTimes: 2, noProgressStop: 1, humanize: { mouseJitter: true } }],
      observers: [{ kind: 'dom', itemSelector: '.card', fields: { id: { attr: 'data-id' } }, trigger: 'after-step' }],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    expect(() => save(dir, oldRecipe)).toThrow(/humanize.*removed/i)
  })

  // `expect` on locate/openTarget is supported (it runs after the step's built-in open-confirmation),
  // but `retryEvery` is NOT: it means "redo the ACTION every N ms", and both steps already own a
  // retry (locate → fallbackUrl, openTarget → maxScrolls). Rejecting at LOAD, not ignoring silently:
  // a silently-ignored gate is exactly the accepted-then-not-honored trap this change closes.
  const withLocateStep = (step: any) => ({
    version: 2, kind: 'browser', sourceId: 'locate-expect', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
    loginCheck: { loggedIn: '.me', wall: '.wall' },
    session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
    steps: [step],
    observers: [{ kind: 'state', statePath: '__S__', trigger: 'after-step' }],
    output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
  })

  it('accepts a plain expect (selector/state/timeout) on a locate step', () => {
    expect(() => validateRecipe('locate-expect', withLocateStep({
      kind: 'locate', selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered',
      expect: { selector: '.detail', state: 'present', timeout: 4000 },
    }))).not.toThrow()
  })

  it('rejects expect.retryEvery on a locate step, pointing at its own fallbackUrl', () => {
    expect(() => validateRecipe('locate-expect', withLocateStep({
      kind: 'locate', selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered',
      expect: { selector: '.detail', retryEvery: 500 },
    }))).toThrow(/retryEvery.*locate|locate.*retryEvery/)
    expect(() => validateRecipe('locate-expect', withLocateStep({
      kind: 'locate', selector: 'a.card', identityParam: 'noteId', orderedParam: 'ordered',
      expect: { selector: '.detail', retryEvery: 500 },
    }))).toThrow(/fallbackUrl/)
  })

  // retryFrom 是"回到更早那一步重走"。指向自己或后面的步不是重试，是原地打转 / 乱序执行，
  // 而两者都是静默的——所以装载期就得拒。
  describe('retryFrom 的装载期闸门（步骤层）', () => {
    /** 重试写在**步骤**上，不在 expect 里 —— 见 RecipeAction.retryFrom 头注。 */
    const twoSteps = (retry: Record<string, unknown>) => ({
      version: 2, kind: 'browser', sourceId: 'retry-from', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [
        { kind: 'click', selector: '#a' },
        { kind: 'submit', selector: '#b', ...retry },
      ],
      observers: [{ kind: 'state', statePath: '__S__', trigger: 'after-step' }],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    })

    it('指向更早的步 + 给了次数 → 收', () => {
      expect(() => validateRecipe('retry-from', twoSteps({ retryFrom: 0, retryTimes: 5 }) as never))
        .not.toThrow()
    })

    it('指向自己 / 指向后面 / 负数 → 拒', () => {
      for (const from of [1, 2, -1]) {
        expect(() => validateRecipe('retry-from', twoSteps({ retryFrom: from, retryTimes: 5 }) as never),
          `retryFrom=${from}`).toThrow(/retryFrom/)
      }
    })

    it('只给 retryFrom 不给次数 → 拒（次数交给 timeout 决定 = 没有上限）', () => {
      expect(() => validateRecipe('retry-from', twoSteps({ retryFrom: 0 }) as never))
        .toThrow(/retryTimes/)
    })

    it('只给 retryTimes 不给 retryFrom → 拒（收下一个不生效的字段正是这里在防的事）', () => {
      expect(() => validateRecipe('retry-from', twoSteps({ retryTimes: 3 }) as never))
        .toThrow(/retryFrom/)
    })

    /**
     * 旧写法（写在 `expect` 里）必须**显式拒**。静默忽略 = 一份照旧写法写的 recipe 会在
     * "重试从没生效"的情况下一路跑绿 —— 那正是 2026-09-03 活体撞到的那个病本身。
     */
    it('还写在 expect 里 → 拒，并指明搬去了哪', () => {
      for (const key of ['retryFrom', 'retryTimes']) {
        const withExpect = twoSteps({ expect: { selector: '.x', [key]: 0 } })
        expect(() => validateRecipe('retry-from', withExpect as never), key)
          .toThrow(/搬到步骤这一层/)
      }
    })
  })

  /**
   * `call.options` —— 只收字面量。
   *
   * 这是 `call` 第 2 条边界的延长线：`options` 让通用服务换个档位跑（OCR 锁字符集），但它
   * **绝不能引用参数袋**——袋子里装着宿主注入的凭据（`secret_params`）。允许插值的话，一条
   * 第三方 recipe 写 `options: { note: "{jymm}" }` 就能把交易密码送到它点名的服务，而它在
   * 安装预览里跟现在长得一模一样。
   */
  describe('call.options 的装载期闸门', () => {
    const withCall = (options: unknown) => ({
      version: 2, kind: 'browser', sourceId: 'call-opts', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [
        { kind: 'call', service: 'ocr', path: '/ocr', input: { shotOf: '#img' }, from: 'text', bind: 'code', options },
      ],
      observers: [{ kind: 'state', statePath: '__S__', trigger: 'after-step' }],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    })

    it('字面量（字符串 / 数字 / 布尔）→ 收', () => {
      expect(() => validateRecipe('call-opts', withCall({ charset: '0123456789', n: 4, strict: true }) as never))
        .not.toThrow()
    })

    it('值里有 {参数} → 拒（这是外泄路，不是笔误）', () => {
      expect(() => validateRecipe('call-opts', withCall({ note: '{jymm}' }) as never))
        .toThrow(/只收字面量|外泄/)
    })

    it('想盖 image → 拒（送什么图归 input.shotOf 管）', () => {
      expect(() => validateRecipe('call-opts', withCall({ image: 'AAAA' }) as never))
        .toThrow(/image/)
    })

    it('嵌套对象 / 数组 → 拒（只收标量）', () => {
      expect(() => validateRecipe('call-opts', withCall({ deep: { a: 1 } }) as never)).toThrow(/只能是/)
      expect(() => validateRecipe('call-opts', withCall({ list: [1, 2] }) as never)).toThrow(/只能是/)
    })
  })

  it('rejects expect.retryEvery on an openTarget step, pointing at its own maxScrolls', () => {
    expect(() => validateRecipe('locate-expect', withLocateStep({
      kind: 'openTarget', selector: 'a.card', identityParam: 'noteId',
      expect: { selector: '.detail', retryEvery: 500 },
    }))).toThrow(/maxScrolls/)
  })

  it('accepts observer-local input and state object-map normalization', () => {
    const recipe: any = {
      version: 2, kind: 'browser', sourceId: 'state-map', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
      loginCheck: { loggedIn: '.me', wall: '.wall' },
      session: { facility: 'x', lifecycle: 'persistent', visibility: 'unattended' },
      steps: [{ kind: 'goto', url: 'https://x.com/' }],
      observers: [{ kind: 'state', statePath: '__INITIAL_STATE__.map', trigger: 'after-step', collection: 'values', input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } } }],
      output: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    }
    expect(makeFileRecipeStore(dir)).toBeDefined()
    expect(() => save(dir, recipe)).not.toThrow()
  })
})

describe('validateRecipe — http 新字段（jar / output / parse / redirect / compute.params）', () => {
  const base = () => ({
    version: 1, kind: 'http', sourceId: 's',
    request: { url: 'https://x.com/a', method: 'GET' },
    assert: [],
  })

  it('object 输出：拒绝 pagination/mapping 搭配', () => {
    expect(() => validateRecipe('s', {
      ...base(), output: 'object',
      pagination: { mode: 'increment', param: 'p', start: 1, step: 1, itemsAt: 'l', maxPages: 1 },
    })).toThrow(/object 输出/)
    expect(() => validateRecipe('s', { ...base(), output: 'object', mapping: { a: 'b' } })).toThrow(/object 输出/)
  })

  it('object 输出：合法最小形状通过', () => {
    expect(() => validateRecipe('s', {
      ...base(), output: 'object',
      compute: { capabilities: [], decode: '1' },
    })).not.toThrow()
  })

  it('items 输出（默认）：pagination 仍必填', () => {
    expect(() => validateRecipe('s', { ...base(), mapping: {} })).toThrow(/pagination.mode/)
  })

  it('拒绝未知 output / 非布尔 jar', () => {
    expect(() => validateRecipe('s', {
      ...base(), output: 'verdict',
      pagination: { mode: 'increment', param: 'p', start: 1, step: 1, itemsAt: 'l', maxPages: 1 }, mapping: {},
    })).toThrow(/output/)
    expect(() => validateRecipe('s', {
      ...base(), jar: 'yes',
      pagination: { mode: 'increment', param: 'p', start: 1, step: 1, itemsAt: 'l', maxPages: 1 }, mapping: {},
    })).toThrow(/jar/)
  })

  it('拒绝未知 parse / redirect / 非字符串 compute.params', () => {
    const paged = { pagination: { mode: 'increment', param: 'p', start: 1, step: 1, itemsAt: 'l', maxPages: 1 }, mapping: {} }
    expect(() => validateRecipe('s', {
      ...base(), ...paged,
      compute: { capabilities: [], prefetch: [{ as: 'a', parse: 'xml', request: { url: 'https://x.com/p', method: 'GET' } }] },
    })).toThrow(/parse/)
    expect(() => validateRecipe('s', {
      ...base(), ...paged,
      request: { url: 'https://x.com/a', method: 'GET', redirect: 'never' },
    })).toThrow(/redirect/)
    expect(() => validateRecipe('s', {
      ...base(), ...paged,
      compute: { capabilities: [], params: 42 },
    })).toThrow(/compute.params/)
  })
})

// recipe 里写的是**局部名**，全名由宿主用包的 npm 名合成（src/registry/source-id.ts）。
// 局部名带 `/` 或 `:` 会让合成出来的全名在解析时二义，所以在装载点就拒。
describe('sourceId 局部名文法', () => {
  const base = {
    version: 1, kind: 'http' as const,
    request: { url: 'https://x/a?p={page}', method: 'GET' },
    pagination: { mode: 'increment', itemsAt: 'data', param: 'page', start: 1, step: 1, maxPages: 1 },
    assert: [{ path: 'data', desc: 'x' }], mapping: { title: 't' },
  }
  it("局部名含 '/' → 装载即拒", () => {
    expect(() => validateRecipe('f.recipe.json', { ...base, sourceId: 'a/b' })).toThrow(/\//)
  })
  it("局部名含 ':' → 装载即拒", () => {
    expect(() => validateRecipe('f.recipe.json', { ...base, sourceId: 'rsshub:weibo' })).toThrow(/:/)
  })
  it('普通局部名照常通过', () => {
    expect(validateRecipe('f.recipe.json', { ...base, sourceId: 'fetch-url' }).sourceId).toBe('fetch-url')
  })
})

describe('retired transport', () => {
  const paged = { pagination: { mode: 'increment', param: 'p', start: 1, step: 1, itemsAt: 'l', maxPages: 1 }, mapping: {} }
  const fetchBase = () => ({
    version: 2, kind: 'fetch', sourceId: 's', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
    assert: [{ path: 'l', desc: 'x' }], request: { url: 'https://x.com/a', method: 'GET' }, ...paged,
  })

  const browserBase = (session: Record<string, unknown>) => ({
    version: 2, kind: 'browser', sourceId: 's', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
    loginCheck: { loggedIn: '.a', wall: '.b' },
    session, steps: [], observers: [{ kind: 'state', statePath: 's', trigger: 'final' }],
    output: { itemsAt: 'i', dedupeBy: 'id', targetCount: 1, mapping: {} },
  })

  it('拒绝 legacy fetch recipe 的 transport:"cloak"，报错点名迁移动作', () => {
    expect(() => validateRecipe('s', { ...fetchBase(), transport: 'cloak' })).toThrow(/cloak.*retired/i)
  })

  it('拒绝 canonical browser recipe 的 session.transport:"cloak"', () => {
    expect(() => validateRecipe('s', browserBase(
      { facility: 'x', lifecycle: 'one-shot', visibility: 'unattended', transport: 'cloak' },
    ))).toThrow(/cloak.*retired/i)
  })

  // 迁移期写下的显式声明必须继续能装——现役 recipe（xhs 全家 / douyin-search / xueqiu-user）
  // 全都显式写着 ext-cdp。类型里没有这个字段了，但"字段没了"不等于"旧文件该报错"。
  it('接受 transport:"ext-cdp"（no-op）——两种形态都要能装', () => {
    expect(validateRecipe('s', { ...fetchBase(), transport: 'ext-cdp' }).sourceId).toBe('s')
    expect(validateRecipe('s', browserBase(
      { facility: 'x', lifecycle: 'one-shot', visibility: 'unattended', transport: 'ext-cdp' },
    )).sourceId).toBe('s')
  })

  it('拒绝拼错的 transport 值，而不是静默忽略', () => {
    expect(() => validateRecipe('s', { ...fetchBase(), transport: 'ext_cdp' })).toThrow(/unknown transport/i)
  })

  it('不声明 transport 的 recipe 照常装载', () => {
    expect(validateRecipe('s', fetchBase()).sourceId).toBe('s')
  })
})

describe('desktop recipe 的 map', () => {
  const base = {
    version: 2, kind: 'desktop', sourceId: 'tg', app: { process: 'Telegram.exe' },
    steps: [], observer: { itemQuery: { role: 'ListItem' }, fields: { text: { read: 'name' } }, dedupeBy: 'text' },
    read: { dedupeBy: 'link', targetCount: 10 },
  }
  const withMap = (map: unknown) => validateRecipe('tg', { ...base, map })

  it('放行合法的抽取规则', () => {
    expect(() => withMap({ title: { from: 'text', match: '名称：(.+)' } })).not.toThrow()
    expect(() => validateRecipe('tg', base)).not.toThrow() // map 是可选的
  })

  /** 正则留到运行期才炸，表现是"这一轮什么都没抽到"——与"页面变了、规则不匹配了"长得一模一样，
   *  会把一个打字错误伪装成源站漂移，排查方向直接跑偏。所以装载时就编译。 */
  it('编译不了的正则在装载时就被拒，并指名是哪个字段', () => {
    expect(() => withMap({ title: { from: 'text', match: '名称：((' } })).toThrow(/map\.title\.match/)
  })

  it('from/match 缺一不可', () => {
    expect(() => withMap({ title: { from: 'text' } })).toThrow(/map\.title/)
    expect(() => withMap({ title: { match: 'x' } })).toThrow(/map\.title/)
    expect(() => withMap({ title: { from: '', match: 'x' } })).toThrow(/map\.title/)
  })

  it('map 必须是对象', () => {
    expect(() => withMap([{ from: 'text', match: 'x' }])).toThrow(/map must be an object/)
  })
})

describe('desktop recipe: app.a11y 申报', () => {
  const base = { version: 1, kind: 'desktop', sourceId: 'x', allowEmpty: true, steps: [] }
  /**
   * `a11y` 是**事实申报**（"这个应用没有控件树"），不是猜——写错的表现是 a11y 段永远缺席、
   * 点击全走坐标，而每一步都照样"成功"。所以类型上一步都不放：`"no"` / `0` 这种写法在
   * JS 里会被 `?? true` 静默当成 `true`，作者以为关了、其实什么都没变。
   */
  it('a11y 必须是布尔：非布尔当场拒、指名字段', () => {
    expect(() => validateRecipe('x', { ...base, app: { process: 'x', a11y: 'no' } })).toThrow(/app\.a11y/)
    expect(() => validateRecipe('x', { ...base, app: { process: 'x', a11y: 0 } })).toThrow(/app\.a11y/)
  })
  it('a11y:false / true / 缺席都放行', () => {
    expect(() => validateRecipe('x', { ...base, app: { process: 'x', a11y: false } })).not.toThrow()
    expect(() => validateRecipe('x', { ...base, app: { process: 'x', a11y: true } })).not.toThrow()
    expect(() => validateRecipe('x', { ...base, app: { process: 'x' } })).not.toThrow()
  })
})

describe('desktop recipe: see / expect / interrupts 装载期校验', () => {
  const base = {
    version: 1, kind: 'desktop', sourceId: 'x', app: { process: 'a.exe' }, allowEmpty: true,
  }
  it('query 与 see 同给 → 拒', () => {
    expect(() => validateRecipe('x', { ...base, steps: [
      { label: 's1', kind: 'invoke', query: { role: 'Button' }, see: { text: '搜索' } },
    ] })).toThrow(/query 与 see 只能给一个/)
  })
  it('see 里 text / icon / point 必须恰给一个', () => {
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'invoke', see: {} }] })).toThrow(/text \/ icon \/ point/)
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'invoke', see: { text: 'a', icon: 'b' } }] })).toThrow(/text \/ icon \/ point/)
    // point 和另外两个也互斥：两个目标下游只会用其中一个，而用的是哪个说不清
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'invoke', see: { text: 'a', point: 'b' } }] })).toThrow(/text \/ icon \/ point/)
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'invoke', see: { point: '消息输入框' }, blind: '拿到焦点没有画面变化' }] })).not.toThrow()
  })
  it('expect.fresh：只能写 true、只在 expect 上、只配 see.text', () => {
    const step = (over: Record<string, unknown>) => ({ label: 's1', kind: 'type', text: 'x', ...over })
    expect(() => validateRecipe('x', { ...base, steps: [step({ expect: { see: { text: '收到' }, fresh: true } })] })).not.toThrow()
    expect(() => validateRecipe('x', { ...base, steps: [step({ expect: { see: { text: '收到' }, fresh: false } })] })).toThrow(/fresh 只能写 true/)
    expect(() => validateRecipe('x', { ...base, steps: [step({ expect: { see: { text: '收到' } }, require: { see: { text: 'a' }, fresh: true } })] })).toThrow(/require 不能带 fresh/)
    expect(() => validateRecipe('x', { ...base, steps: [step({ expect: { query: { role: 'Button' }, fresh: true } })] })).toThrow(/只配 see.text/)
  })
  it('else 只认 drift / retry / abort', () => {
    expect(() => validateRecipe('x', { ...base, steps: [
      { label: 's1', kind: 'type', text: 'a', expect: { see: { text: 'b' } }, else: 'goto' },
    ] })).toThrow(/else/)
  })
  /**
   * 步骤里的 `press` 只放行 Escape。**这条闸原先一刀切禁掉 press，而它的理由只讲得通 Enter
   * 那一半**（"回车用 type 的 \n，别给同一件事两种写法"）——Escape 没有第二种写法，它是复位
   * 唯一的手段，被顺带禁掉之后 recipe 就没法从上一轮的脏状态里出来（QQ 活体 2026-09-07：
   * 搜索框留着上次的字，正文被打进了搜索框）。禁令的范围比它的理由宽，就是这么漏的。
   */
  it('press 的白名单是一条判据、不是先例清单：只放行「改变状态但不 actuate」的键', () => {
    // 放行的两个都只挪状态：Escape 复位、Tab 挪焦点（QQ：空输入框在识别层没有靶子可指，
    // 点完会话行焦点停在 Document，只能靠 Tab 走过去）。
    for (const key of ['Escape', 'Tab']) {
      expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'press', key, blind: '画面无可观测变化' }] })).not.toThrow()
    }
    // **会 actuate 当前控件的一律拒**——按键没有收件人，谁持有焦点谁收下。
    // Enter 另有 `type "\n"` 那条路；其余的（空格 / Delete / Ctrl+W…）根本不该由 recipe 敲。
    for (const key of ['Enter', ' ', 'Delete', 'F4', 'a']) {
      expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'press', key, blind: 'x' }] })).toThrow(/press/)
    }
    // 名单本身也钉住：加键的人得改这条测试，从而被迫回答"它 actuate 吗"。
    expect([...PRESSABLE_KEYS].sort()).toEqual(['Escape', 'Tab'])
    expect(() => validateRecipe('x', { ...base, steps: [], interrupts: [
      { see: { text: '跳过' }, dismiss: { kind: 'press', key: 'Escape' } },
    ] })).not.toThrow()
  })
  /**
   * `times` 只为一件事存在：`Tab×6` 写成六个步骤就是六个 `blind` 各自讲同一句话，而
   * "6 是怎么来的、怎么重新求"没有一个地方写得下。两个约束都得钉住。
   */
  it('press.times：1..20 的整数；连按多次必须给 blind', () => {
    const step = (times: unknown, blind = true) => ({ label: 's1', kind: 'press', key: 'Tab', times, ...(blind ? { blind: '逐次按键画面上看不出来' } : {}) })
    expect(() => validateRecipe('x', { ...base, steps: [step(6)] })).not.toThrow()
    // 按一次时 `expect` 就够（和别的动作步同规矩）——`times` 不额外收紧。
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'press', key: 'Tab', times: 1, expect: { see: { text: 'x' } } }] })).not.toThrow()
    for (const bad of [0, -1, 1.5, 21, 1000, '6']) {
      expect(() => validateRecipe('x', { ...base, steps: [step(bad)] })).toThrow(/times/)
    }
    // **连按多次时 `expect` 不算数**：中间态没有可观察变化，硬写 expect 只会写出一个恒真的
    // 装饰，所以必须给 blind 说清为什么没有判据。这一格就是 `times` 这条规则的全部增量。
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'press', key: 'Tab', times: 6, expect: { see: { text: 'x' } } }] })).toThrow(/blind/)
    expect(MAX_PRESS_TIMES).toBe(20)
  })
  it('interrupts[].dismiss 只认 invoke / press', () => {
    expect(() => validateRecipe('x', { ...base, steps: [], interrupts: [
      { see: { text: '跳过' }, dismiss: { kind: 'type', text: 'x' } },
    ] })).toThrow(/dismiss/)
  })
  it('interrupts[].atFocus 只认布尔值', () => {
    expect(() => validateRecipe('x', { ...base, steps: [], interrupts: [
      { see: { text: '跳过' }, dismiss: { kind: 'press', key: 'Escape' }, atFocus: 'yes' },
    ] })).toThrow(/atFocus/)
    expect(() => validateRecipe('x', { ...base, steps: [], interrupts: [
      { see: { text: '跳过' }, dismiss: { kind: 'press', key: 'Escape' }, atFocus: true },
    ] })).not.toThrow()
  })
  /**
   * 「我点了一个东西，接下来就该看见某个东西」——这条规则一直写在文档里，但因为是**可选**的，
   * 实际上基本没人守：量过一次，桌面 recipe 的 21 个动作步里 18 个没写 expect（2026-09-07）。
   * 代价是点空了要拖到两三步之后才以别的面目冒出来，排查时早已回不到现场。
   *
   * 所以改成二选一。`blind` 不是豁免，是**把"忘了写"和"想过、确实没有"分开**：有些转移在某个
   * 后端上真的看不见（"输入框拿到了焦点"在视觉方案里没有任何画面变化），那就得说出来。
   */
  it('动作步骤必须二选一：expect 或 blind', () => {
    const step = (extra: object) => ({ ...base, steps: [{ label: 's1', kind: 'invoke', see: { text: '搜索' }, ...extra }] })
    expect(() => validateRecipe('x', step({}))).toThrow(/必须给 expect/)
    expect(() => validateRecipe('x', step({ expect: { see: { text: '结果' } } }))).not.toThrow()
    expect(() => validateRecipe('x', step({ blind: '焦点进入搜索框，视觉上没有变化' }))).not.toThrow()
    // 空话不算说明
    expect(() => validateRecipe('x', step({ blind: '  ' }))).toThrow(/blind/)
    // "有判据"和"没有判据"只能占一个——同时给多半是改了一半
    expect(() => validateRecipe('x', step({ blind: 'x', expect: { see: { text: '结果' } } }))).toThrow(/只能占一个/)
    // 不改变界面的步骤不受这条约束
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 's1', kind: 'wait', ms: 10 }] })).not.toThrow()
  })

  it('合法样例整份通过', () => {
    expect(() => validateRecipe('x', { ...base, steps: [
      { kind: 'focus', label: '抢到前台' },
      { kind: 'invoke', see: { text: '搜索' }, label: '点搜索框', blind: '焦点进入搜索框，视觉上没有变化' },
      { kind: 'type', text: '{contact}', label: '打联系人名', expect: { see: { text: '{contact}', region: 'top-left' } } },
      { kind: 'type', text: '\n', label: '回车开会话', expect: { see: { text: '{contact}', region: 'top' } }, else: 'abort' },
    ], interrupts: [{ see: { text: '稍后再说' }, dismiss: { kind: 'invoke', see: { text: '稍后再说' } } }] })).not.toThrow()
  })
})

describe('meta.title / meta.purpose（提示条第二行）', () => {
  const base = { version: 1, kind: 'desktop', sourceId: 'x', app: { process: 'a.exe' }, allowEmpty: true, steps: [] }
  /**
   * `purpose` 是要上屏的模板：`{contact}` 在 runner 里用参数填。占位没在 `params_schema` 里声明，
   * 填参时会原样留成字面的 `{contact}` 上屏——不报错、只是条子上多一对花括号，作者以为拼错了
   * 参数名却没有一处会喊。所以在装载点拒。
   */
  it('purpose 里的占位必须在 params_schema 里声明过', () => {
    expect(() => validateRecipe('x', { ...base, meta: { purpose: '发给 {contact}', params_schema: { who: { type: 'string' } } } })).toThrow(/meta\.purpose.*\{contact\}/)
    expect(() => validateRecipe('x', { ...base, meta: { purpose: '发给 {contact}' } })).toThrow(/meta\.purpose.*\{contact\}/)
  })
  it('声明过的占位 / 没有占位 / 缺席都放行', () => {
    expect(() => validateRecipe('x', { ...base, meta: { title: '微信发消息', purpose: '发给 {contact}', params_schema: { contact: { type: 'string' } } } })).not.toThrow()
    expect(() => validateRecipe('x', { ...base, meta: { title: '微信发消息', purpose: '发消息' } })).not.toThrow()
    expect(() => validateRecipe('x', { ...base, meta: {} })).not.toThrow()
  })
  it('purpose 不许引用 secret_params（哪怕 params_schema 里也有同名）', () => {
    const meta = { purpose: '用 {pwd}', params_schema: { pwd: { type: 'string' } }, secret_params: ['pwd'], runtime_config: { ref: 'x', fields: { pwd: { type: 'secret' } } } }
    expect(() => validateRecipe('x', { ...base, meta })).toThrow(/meta\.purpose.*secret_params.*\{pwd\}/)
  })
  it('title / purpose 只认字符串', () => {
    expect(() => validateRecipe('x', { ...base, meta: { title: 3 } })).toThrow(/meta\.title/)
    expect(() => validateRecipe('x', { ...base, meta: { purpose: ['x'] } })).toThrow(/meta\.purpose/)
  })
  it('非 desktop recipe 同样校验（meta 是通用字段）', () => {
    const http = { version: 1, kind: 'http', sourceId: 'h', request: { url: 'https://a/b', method: 'GET' }, pagination: { mode: 'increment', itemsAt: 'data', param: 'page', start: 1, step: 1, maxPages: 1 }, assert: [], mapping: { title: 't' }, meta: { purpose: '看 {q}' } }
    expect(() => validateRecipe('h', http)).toThrow(/meta\.purpose.*\{q\}/)
  })
})

describe('desktop recipe: groundings 与 label', () => {
  const base = { version: 1, kind: 'desktop', sourceId: 'x', app: { process: 'a.exe' }, allowEmpty: true }
  const click = (extra: Record<string, unknown> = {}) => ({ label: 'L', kind: 'click', at: { x: 0.5, y: 0.5 }, blind: 'b', ...extra })

  it('步骤 label 必填且唯一（override 与贡献物都用它当键）', () => {
    expect(() => validateRecipe('x', { ...base, steps: [{ kind: 'click', at: { x: 0.5, y: 0.5 }, blind: 'b' }] })).toThrow(/steps\[0\].*label/)
    expect(() => validateRecipe('x', { ...base, steps: [click(), click()] })).toThrow(/label.*重复.*L/)
  })
  it('没有 groundings 的旧 recipe 照过', () => {
    expect(() => validateRecipe('x', { ...base, steps: [click()] })).not.toThrow()
  })
  it('groundings[] 每条要有 on，on 只认 platform / app / lang，platform 只认 win32 / darwin，app 要是认得的区间', () => {
    const ok = click({ groundings: [{ on: { platform: 'darwin' }, kind: 'click', at: { x: 0.6, y: 0.87 } }] })
    expect(() => validateRecipe('x', { ...base, steps: [ok] })).not.toThrow()
    expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ kind: 'click', at: { x: 0, y: 0 } }] })] })).toThrow(/groundings\[0\].*on/)
    expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ on: { platform: 'linux' }, kind: 'click', at: { x: 0, y: 0 } }] })] })).toThrow(/platform/)
    expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ on: { os: 'win32' }, kind: 'click', at: { x: 0, y: 0 } }] })] })).toThrow(/on.*os/)
    expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ on: { app: '^4' }, kind: 'click', at: { x: 0, y: 0 } }] })] })).toThrow(/app.*区间/)
  })
  it('grounding 内不许出现顶层专属键（expect / else / optional / blind / label …）', () => {
    for (const bad of [{ expect: { see: { text: 'x' } } }, { else: 'abort' }, { optional: true }, { blind: 'b' }, { label: 'z' }]) {
      expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ on: { platform: 'win32' }, kind: 'click', at: { x: 0, y: 0 }, ...bad }] })] }))
        .toThrow(/groundings\[0\].*只能在顶层/)
    }
  })
  it('grounding 的 body 过和顶层同一套 kind 校验（click.at 出界、press 非白名单键都拒）', () => {
    expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ on: { platform: 'win32' }, kind: 'press', key: 'Enter' }] })] })).toThrow(/press Enter/)
    expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ on: { platform: 'win32' }, kind: 'invoke', see: {} }] })] })).toThrow(/text \/ icon \/ point/)
    // 出界的比例在运行时换算成窗口外的一个点，点击照样"成功"发出去、落在别的窗口上——没有一处会喊。
    expect(() => validateRecipe('x', { ...base, steps: [click({ at: { x: 1.5, y: 0 } })] })).toThrow(/at\.x.*0\.\.1/)
    expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ on: { platform: 'win32' }, kind: 'click', at: { x: 1.5, y: 0 } }] })] })).toThrow(/groundings\[0\].*at\.x.*0\.\.1/)
    // 按比例点和按坐标点只能占一个（和 desktop-recipe.ts 里 click 的注释同口径）
    expect(() => validateRecipe('x', { ...base, steps: [click({ at: { x: 0.5, y: 0.5 }, x: 10, y: 10 })] })).toThrow(/只能占一个/)
    // 拼错的 kind 不能静默放行：它到运行时不匹配任何分支，"跑过了"却什么都没做
    expect(() => validateRecipe('x', { ...base, steps: [click({ kind: 'clik' })] })).toThrow(/kind 不认识.*clik/)
  })
  /**
   * `branch` 在 `DESKTOP_STEP_KINDS` 里（顶层要用它），但它是**判据**：读一次状态、决定跳几步。
   * runner 只在候选之前评顶层的 branch，一条 `kind:'branch'` 的落地方式被选中后走到的是
   * `runStep` 那个"不认识的 kind"出口——装载期就拒，别留给运行时去撞。
   */
  it('grounding 里不许写 branch——分支是判据不是落地方式', () => {
    expect(() => validateRecipe('x', { ...base, steps: [click({ groundings: [{ on: { platform: 'win32' }, kind: 'branch', when: { query: { role: 'Edit' } }, skip: 1 }] }), click({ label: 'L2' })] }))
      .toThrow(/groundings\[0\].*分支是判据不是落地方式/)
    // 顶层照旧放行
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 'B', kind: 'branch', when: { query: { role: 'Edit' } }, skip: 1 }, click(), click({ label: 'L3' })] })).not.toThrow()
  })
  /**
   * 参数分支（`when: { param, equals }`）：`param` 必须是 params_schema 声明过的键（拼错的分支永远
   * 不成立，表现是"开关没生效、照常发了"）；只有它允许跳到 recipe 末尾（`send:false` 吃掉最后那一发）。
   */
  it('branch 按参数分支：param 要在 params_schema 里；允许跳到末尾；不许和 see/query 混', () => {
    const withSchema = { ...base, meta: { params_schema: { send: { type: 'boolean', default: true } } } }
    const pb = (when: unknown, skip = 1) => ({ label: 'B', kind: 'branch', when, skip })
    expect(() => validateRecipe('x', { ...withSchema, steps: [click(), pb({ param: 'send', equals: false }), click({ label: 'L3' })] })).not.toThrow()
    // 跳到末尾（吃掉剩下的全部步骤）：参数分支放行，读屏分支照旧拒
    expect(() => validateRecipe('x', { ...withSchema, steps: [click(), pb({ param: 'send', equals: false }), click({ label: 'L3' }), click({ label: 'L4' })] })).not.toThrow()
    expect(() => validateRecipe('x', { ...withSchema, steps: [click(), pb({ param: 'send', equals: false }, 2), click({ label: 'L3' }), click({ label: 'L4' })] })).not.toThrow()
    expect(() => validateRecipe('x', { ...withSchema, steps: [click(), pb({ query: { role: 'Edit' } }, 2), click({ label: 'L3' }), click({ label: 'L4' })] })).toThrow(/至少还剩一步/)
    // 出界仍然拒
    expect(() => validateRecipe('x', { ...withSchema, steps: [click(), pb({ param: 'send', equals: false }, 3), click({ label: 'L3' }), click({ label: 'L4' })] })).toThrow(/不超出 recipe 末尾/)
    // 没声明的键 / 混写 / equals 不是标量
    expect(() => validateRecipe('x', { ...withSchema, steps: [click(), pb({ param: 'snd', equals: false }), click({ label: 'L3' })] })).toThrow(/params_schema 里声明过的键.*snd/)
    expect(() => validateRecipe('x', { ...base, steps: [click(), pb({ param: 'send', equals: false }), click({ label: 'L3' })] })).toThrow(/params_schema 里声明过的键/)
    expect(() => validateRecipe('x', { ...withSchema, steps: [click(), pb({ param: 'send', equals: false, see: { text: 'x' } }), click({ label: 'L3' })] })).toThrow(/不能再给 see/)
    expect(() => validateRecipe('x', { ...withSchema, steps: [click(), pb({ param: 'send', equals: { a: 1 } }), click({ label: 'L3' })] })).toThrow(/equals/)
  })
  /**
   * `format:'path'` 参数执行前派生出 `_name / _stem / _stem6 / _ext / _kind`（`path-params.ts`）；按扩展名
   * 分流的 branch 指向它们必须装得进去，名单与派生处同一份——否则"派生了 `_kind`、装载闸不认"
   * 的表现是一条按类型分流的 recipe 根本装不上。
   */
  it('branch.when.param 认 format:"path" 参数的派生键；unverified 只许写在参数分支上', () => {
    const withPath = { ...base, meta: { params_schema: { path: { type: 'string', required: true, format: 'path' }, contact: { type: 'string' } } } }
    const pb = (when: unknown, extra: Record<string, unknown> = {}) => ({ label: 'B', kind: 'branch', when, skip: 1, ...extra })
    for (const k of ['path_name', 'path_stem', 'path_stem6', 'path_ext', 'path_kind']) {
      expect(() => validateRecipe('x', { ...withPath, steps: [click(), pb({ param: k, equals: 'image' }), click({ label: 'L3' })] })).not.toThrow()
    }
    // 不是 path 格式的参数没有派生键
    expect(() => validateRecipe('x', { ...withPath, steps: [click(), pb({ param: 'contact_kind', equals: 'x' }), click({ label: 'L3' })] })).toThrow(/params_schema 里声明过的键/)
    // unverified：参数分支上放行、要是非空字符串；读屏分支上拒
    expect(() => validateRecipe('x', { ...withPath, steps: [click(), pb({ param: 'path_kind', equals: 'image' }, { unverified: 'image-no-caption' }), click({ label: 'L3' })] })).not.toThrow()
    expect(() => validateRecipe('x', { ...withPath, steps: [click(), pb({ param: 'path_kind', equals: 'image' }, { unverified: '' }), click({ label: 'L3' })] })).toThrow(/unverified/)
    expect(() => validateRecipe('x', { ...withPath, steps: [click(), pb({ see: { text: 'x' } }, { unverified: 'why' }), click({ label: 'L3' }), click({ label: 'L4' })] })).toThrow(/只对参数分支/)
  })
  /** `pickFile` 是动作步：过 expect-or-blind 那道闸；`path` 必填；`dialog` 借 window 的 match 形状；超时要是正数。 */
  it('pickFile 的装载校验', () => {
    const pf = (extra: Record<string, unknown> = {}) => ({ label: 'P', kind: 'pickFile', path: '{path}', blind: '判据在下一步', ...extra })
    const ok = (step: Record<string, unknown>) => validateRecipe('x', { ...base, steps: [step] })
    expect(() => ok(pf())).not.toThrow()
    expect(() => ok(pf({ dialog: { process: 'Weixin.exe', titleAnyOf: ['选择文件', 'Open'] }, timeoutMs: 8000, closeTimeoutMs: 5000 }))).not.toThrow()
    expect(() => ok(pf({ blind: undefined, expect: { see: { text: 'a.txt' } } }))).not.toThrow()
    expect(() => ok(pf({ blind: undefined }))).toThrow(/expect|blind/)
    expect(() => ok(pf({ path: '' }))).toThrow(/path/)
    expect(() => ok(pf({ dialog: 'Open' }))).toThrow(/dialog/)
    expect(() => ok(pf({ dialog: { titleAnyOf: [] } }))).toThrow(/titleAnyOf/)
    expect(() => ok(pf({ dialog: { titleAnyOf: [''] } }))).toThrow(/titleAnyOf/)
    expect(() => ok(pf({ timeoutMs: 0 }))).toThrow(/timeoutMs/)
    expect(() => ok(pf({ closeTimeoutMs: -1 }))).toThrow(/closeTimeoutMs/)
    expect(DESKTOP_STEP_KINDS.has('pickFile')).toBe(true)
  })
  /**
   * 顶层给了 `expect` 的 press 步，落地方式写成 `Tab×6` 必须装得进去。三条规则本来会把它叠死：
   * 判据只住顶层（grounding 不许带 `blind`）+ 顶层有 `expect` 就不能再有 `blind` +
   * 「连按多次必须给 blind」。而这正是这套东西要支持的形状——换了怎么按，做完该看见什么不变。
   */
  it('grounding 里的 press.times>1 豁免 blind：判据在顶层', () => {
    expect(() => validateRecipe('x', { ...base, steps: [{
      label: 'L', kind: 'press', key: 'Tab', expect: { see: { text: '输入框' } },
      groundings: [{ on: { platform: 'win32' }, kind: 'press', key: 'Tab', times: 6 }],
    }] })).not.toThrow()
    // 顶层那条没被放松：它自己连按多次仍然必须说清为什么没有判据
    expect(() => validateRecipe('x', { ...base, steps: [{ label: 'L', kind: 'press', key: 'Tab', times: 6, expect: { see: { text: 'x' } } }] })).toThrow(/blind/)
  })
  it('顶层带 {param} 的字段在 grounding 里不许去模板化', () => {
    const step = { label: 'L', kind: 'invoke', see: { text: '{contact}' }, blind: 'b',
      groundings: [{ on: { platform: 'darwin' }, kind: 'invoke', see: { text: '文件传输助手' } }] }
    expect(() => validateRecipe('x', { ...base, meta: { params_schema: { contact: { type: 'string' } } }, steps: [step] })).toThrow(/\{contact\}/)
  })
  it('edges 认得出来但本期不执行——形状错拒，形状对放行', () => {
    expect(() => validateRecipe('x', { ...base, steps: [click()], edges: [{ from: 'L', on: { platform: 'darwin' }, insert: [click({ label: 'L2' })] }] })).not.toThrow()
    expect(() => validateRecipe('x', { ...base, steps: [click()], edges: [{ from: 'nope', on: {}, insert: [] }] })).toThrow(/edges\[0\].*from.*nope/)
    // 插进来的也是步骤：同一套 kind 校验、同样要有 label（只在这条边内部唯一）
    expect(() => validateRecipe('x', { ...base, steps: [click()], edges: [{ from: 'L', on: {}, insert: [{ kind: 'click', at: { x: 0, y: 0 }, blind: 'b' }] }] })).toThrow(/insert\[0\].*label/)
    expect(() => validateRecipe('x', { ...base, steps: [click()], edges: [{ from: 'L', on: {}, insert: [click({ label: 'A' }), click({ label: 'A' })] }] })).toThrow(/insert\[1\].*重复.*A/)
    expect(() => validateRecipe('x', { ...base, steps: [click()], edges: [{ from: 'L', on: {}, insert: [click({ label: 'A', kind: 'clik' })] }] })).toThrow(/insert\[0\].*kind 不认识/)
    // 边内部的 label 不和主 steps 比——插进来的那几步是这条边自己的东西
    expect(() => validateRecipe('x', { ...base, steps: [click()], edges: [{ from: 'L', on: {}, insert: [click()] }] })).not.toThrow()
  })
})

describe('desktop areas', () => {
  const base = {
    version: 1, kind: 'desktop', sourceId: 'x', app: { process: 'a.exe' }, allowEmpty: true,
    steps: [
      { label: '聚焦', kind: 'focus' },
      { label: '打字', kind: 'type', text: 'x', query: { role: 'Edit' }, expect: { see: { text: 'x' } } },
    ] as Record<string, unknown>[],
  }
  const validate = (r: unknown) => validateRecipe('x', r)
  const withAreas = (areas: unknown, expectSee: unknown) => ({ ...base, areas, steps: [base.steps[0], { ...base.steps[1], expect: { see: expectSee } }] })

  it('没有 areas 的旧 recipe 照过', () => {
    expect(() => validate(base)).not.toThrow()
  })
  it('see.area 指向声明过的区域 → 过', () => {
    expect(() => validate(withAreas({ 气泡区: { region: 'bottom' } }, { text: 'x', area: '气泡区' }))).not.toThrow()
  })
  /**
   * spec §3.4：**任何 see 都能引用区域**，判据位和动作位一样。动作位那条路走的是
   * `validateTarget`——它不带 `areas` 的话，一条合法的动作位 `see.area` 会被拒成
   * "这份 see 不属于任何 recipe"，而那句话对着一份真 recipe 说是错的。
   */
  it('动作位的 see 也能引用区域，且算作引用（不被判成死区域）', () => {
    const invokeWithArea = {
      ...base,
      areas: { 气泡区: { region: 'bottom' } },
      steps: [
        base.steps[0],
        { label: '点它', kind: 'invoke', see: { text: 'x', area: '气泡区' }, blind: 'b' },
      ],
    }
    expect(() => validate(invokeWithArea)).not.toThrow()
  })
  it('see.area 指向没声明的区域 → 拒', () => {
    expect(() => validate(withAreas({ 气泡区: { region: 'bottom' } }, { text: 'x', area: '标题栏' }))).toThrow(/指向不存在的区域/)
  })
  it('area 与 region 同给 → 拒', () => {
    expect(() => validate(withAreas({ 气泡区: { region: 'bottom' } }, { text: 'x', area: '气泡区', region: 'top' }))).toThrow(/同时给了 area 和 region/)
  })
  it('区域 grounding 的 body 只能有 region；on 必须合法', () => {
    expect(() => validate(withAreas({ 气泡区: { groundings: [{ on: { platform: 'win32' }, region: 'bottom', kind: 'click' }] } }, { text: 'x', area: '气泡区' }))).toThrow(/只许有 region/)
    expect(() => validate(withAreas({ 气泡区: { groundings: [{ on: { platform: 'win32' } }] } }, { text: 'x', area: '气泡区' }))).toThrow(/要给 region/)
    expect(() => validate(withAreas({ 气泡区: { groundings: [{ on: { platform: 'amiga' }, region: 'bottom' }] } }, { text: 'x', area: '气泡区' }))).toThrow()
  })
  it('区域既没有 region 也没有 groundings → 拒（空区域什么都罩不住）', () => {
    expect(() => validate(withAreas({ 气泡区: {} }, { text: 'x', area: '气泡区' }))).toThrow(/region 或 groundings/)
  })
  it('声明了没人引用的区域 → 拒（死区域）', () => {
    expect(() => validate(withAreas({ 气泡区: { region: 'bottom' }, 多余: { region: 'top' } }, { text: 'x', area: '气泡区' }))).toThrow(/没有任何 see 引用/)
  })
  /**
   * 包内的 `interrupts[]` 属于这份 recipe，它的 `see.area` 应该和判据位/动作位一样能引用顶层
   * areas。只被打断表引用的区域也算「有人引用」——否则一份"只在打断表里用了这块区域"的 recipe
   * 会被死区域那道闸误拒。
   */
  it('打断表的 see 也能引用区域，且算作引用（不被判成死区域）', () => {
    const withInterrupt = {
      ...base,
      areas: { 气泡区: { region: 'bottom' } },
      interrupts: [{ see: { text: '稍后再说', area: '气泡区' }, dismiss: { kind: 'press', key: 'Escape' } }],
    }
    expect(() => validate(withInterrupt)).not.toThrow()
  })
  it('打断表 dismiss.see 引用区域也算作引用', () => {
    const withInterrupt = {
      ...base,
      areas: { 气泡区: { region: 'bottom' } },
      interrupts: [{ see: { text: '稍后再说' }, dismiss: { kind: 'invoke', see: { text: '关闭', area: '气泡区' } } }],
    }
    expect(() => validate(withInterrupt)).not.toThrow()
  })
  it('打断表引用没声明的区域 → 拒', () => {
    const withInterrupt = {
      ...base,
      areas: { 气泡区: { region: 'bottom' } },
      interrupts: [{ see: { text: '稍后再说', area: '标题栏' }, dismiss: { kind: 'press', key: 'Escape' } }],
    }
    expect(() => validate(withInterrupt)).toThrow(/指向不存在的区域/)
  })
})
