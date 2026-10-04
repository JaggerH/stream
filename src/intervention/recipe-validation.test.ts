import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertionSnapshot, requiredParams, validateCandidate } from './recipe-validation.ts'

/**
 * 一份**真的过得了 `validateRecipe`** 的 `kind:'http'` recipe（任务书里那份夹具过不了，
 * 见 report）：http 的 items 档要求 `request` / `pagination.mode` / `assert` / `mapping`
 * 四件都在，`output` 是字符串枚举而不是对象。
 */
const original = {
  version: 4,
  kind: 'http',
  sourceId: 'demo',
  request: { url: 'https://a.example/api', method: 'GET' },
  pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'items', maxPages: 1 },
  assert: [{ path: 'items', desc: 'items' }],
  mapping: { guid: 'id', title: 'title' },
  meta: { type: 'post', description: 'd', normalizer: 'generic' },
}
const write = (obj: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cand-'))
  const p = join(dir, 'demo.recipe.json')
  writeFileSync(p, JSON.stringify(obj))
  return p
}

describe('assertionSnapshot', () => {
  it('只看断言字段，改选择器不变、改 expect 变', () => {
    const a = { steps: [{ kind: 'click', selector: '.x', expect: '#ok' }], observers: [{ input: { assert: [{ path: 'a' }] } }], loginCheck: { wall: '.w' } }
    const b = { ...a, steps: [{ kind: 'click', selector: '.y', expect: '#ok' }] }
    const c = { ...a, steps: [{ kind: 'click', selector: '.x', expect: '#changed' }] }
    expect(assertionSnapshot(a)).toBe(assertionSnapshot(b))
    expect(assertionSnapshot(a)).not.toBe(assertionSnapshot(c))
  })
  it('V1 browser recipe（actions[].expect / harvest.assert）也在快照里', () => {
    const v1 = {
      kind: 'browser',
      actions: [{ kind: 'click', selector: '.card', expect: { selector: '#detail' } }],
      harvest: { mode: 'xhr', urlPattern: '*/feed*', itemsAt: 'data', dedupeBy: 'id', targetCount: 10, mapping: { guid: 'id' }, assert: [{ path: 'data', desc: 'feed' }] },
    }
    const selectorOnly = { ...v1, actions: [{ kind: 'click', selector: '.other', expect: { selector: '#detail' } }] }
    const expectChanged = { ...v1, actions: [{ kind: 'click', selector: '.card', expect: { selector: '#whatever' } }] }
    const harvestChanged = { ...v1, harvest: { ...v1.harvest, assert: [] } }
    expect(assertionSnapshot(v1)).toBe(assertionSnapshot(selectorOnly))
    expect(assertionSnapshot(v1)).not.toBe(assertionSnapshot(expectChanged))
    expect(assertionSnapshot(v1)).not.toBe(assertionSnapshot(harvestChanged))
  })
  it('canonical recipe 的 output.assert（observer 没 input 时的默认守卫）也在快照里', () => {
    const c = { kind: 'browser', steps: [], observers: [{ kind: 'network', urlPattern: '*/x*' }], output: { itemsAt: 'data', dedupeBy: 'id', targetCount: 5, mapping: { guid: 'id' }, assert: [{ path: 'data', desc: 'd' }] } }
    const weakened = { ...c, output: { ...c.output, assert: [] } }
    const harmless = { ...c, output: { ...c.output, targetCount: 50 } }
    expect(assertionSnapshot(c)).not.toBe(assertionSnapshot(weakened))
    expect(assertionSnapshot(c)).toBe(assertionSnapshot(harmless))
  })
  it('desktop recipe 的 steps[].require（发错人那道闸）也在快照里', () => {
    const d = {
      kind: 'desktop',
      steps: [
        { kind: 'invoke', query: { name: '搜索' }, expect: { query: { name: '结果' } } },
        { kind: 'type', query: { name: '输入框' }, text: 'hi', require: { query: { name: '张三' } }, expect: { query: { name: 'hi' } } },
      ],
    }
    const requireChanged = { ...d, steps: [d.steps[0], { ...d.steps[1], require: { query: { name: '李四' } } }] }
    const requireDropped = { ...d, steps: [d.steps[0], { kind: 'type', query: { name: '输入框' }, text: 'hi', expect: { query: { name: 'hi' } } }] }
    const textChanged = { ...d, steps: [d.steps[0], { ...d.steps[1], text: 'hello' }] }
    expect(assertionSnapshot(d)).not.toBe(assertionSnapshot(requireChanged))
    expect(assertionSnapshot(d)).not.toBe(assertionSnapshot(requireDropped))
    expect(assertionSnapshot(d)).toBe(assertionSnapshot(textChanged))
  })
  it('meta.params_schema 的 required 也在快照里', () => {
    const a = { meta: { params_schema: { q: { type: 'string', required: false } } } }
    const flipped = { meta: { params_schema: { q: { type: 'string', required: true } } } }
    const renamedType = { meta: { params_schema: { q: { type: 'number', required: false } } } }
    expect(assertionSnapshot(a)).not.toBe(assertionSnapshot(flipped))
    expect(assertionSnapshot(a)).toBe(assertionSnapshot(renamedType))
  })
})

describe('requiredParams', () => {
  it('读 meta.params_schema 里 required 的键', () => {
    expect(requiredParams({ meta: { params_schema: { keyword: { required: true }, page: { required: false } } } })).toEqual(['keyword'])
    expect(requiredParams({})).toEqual([])
  })
})

describe('validateCandidate', () => {
  it('version 不是 +1 → 不过，并说清该是几', async () => {
    const r = await validateCandidate({ localSourceId: 'demo', original, candidatePath: write({ ...original, version: 4 }) })
    expect(r.ok).toBe(false)
    expect(r.validation.version).toMatch(/5/)
  })
  it('改了断言 → 不过', async () => {
    const r = await validateCandidate({ localSourceId: 'demo', original, candidatePath: write({ ...original, version: 5, assert: [{ path: 'data', desc: 'x' }] }) })
    expect(r.ok).toBe(false)
    expect(r.validation.assertions).not.toBe('ok')
  })
  it('文件读不到 / 不是合法 recipe → schema 格说话，其余格不装懂', async () => {
    const r = await validateCandidate({ localSourceId: 'demo', original, candidatePath: '/nonexistent/demo.recipe.json' })
    expect(r.ok).toBe(false)
    expect(r.validation.schema).not.toBe('ok')
  })
  it('形状不合法（validateRecipe 抛错）→ schema 格说话', async () => {
    const r = await validateCandidate({ localSourceId: 'demo', original, candidatePath: write({ ...original, version: 5, pagination: undefined }) })
    expect(r.ok).toBe(false)
    expect(r.validation.schema).not.toBe('ok')
    expect(r.validation.version).not.toBe('ok')
  })
  it('全过 + 没有 probe 执行器 → ok，probe 记 skipped-no-executor（不是 ok）', async () => {
    const r = await validateCandidate({
      localSourceId: 'demo',
      original,
      candidatePath: write({ ...original, version: 5, request: { url: 'https://a.example/v2', method: 'GET' } }),
    })
    expect(r.ok).toBe(true)
    expect(r.validation).toEqual({ schema: 'ok', version: 'ok', assertions: 'ok', probe: 'skipped-no-executor' })
    expect((r.candidate as { version: number }).version).toBe(5)
  })
  it('有必填参数 → probe 记 skipped-needs-params，不调执行器', async () => {
    const withParam = {
      ...original,
      request: { url: 'https://a.example/api?q={q}', method: 'GET' },
      meta: { ...original.meta, params_schema: { q: { type: 'string', required: true } } },
    }
    let called = false
    const r = await validateCandidate({ localSourceId: 'demo', original: withParam, candidatePath: write({ ...withParam, version: 5 }), probe: async () => { called = true; return { outcome: 'ok', items: 1 } } })
    expect(called).toBe(false)
    expect(r.validation.probe).toBe('skipped-needs-params')
    expect(r.ok).toBe(true)
  })
  it('probe 跑了：outcome ok 且有 item → ok；否则不过并带原因', async () => {
    const good = await validateCandidate({ localSourceId: 'demo', original, candidatePath: write({ ...original, version: 5 }), probe: async () => ({ outcome: 'ok', items: 3 }) })
    expect(good.validation.probe).toBe('ok')
    const bad = await validateCandidate({ localSourceId: 'demo', original, candidatePath: write({ ...original, version: 5 }), probe: async () => ({ outcome: 'drift', reason: 'no items', items: 0 }) })
    expect(bad.ok).toBe(false)
    expect(bad.validation.probe).toMatch(/drift/)
  })
  it('V1 browser recipe 改 actions[].expect → 不过', async () => {
    const v1 = {
      version: 2, kind: 'browser', sourceId: 'demo', cookieDomain: 'a.example', entryUrl: 'https://a.example/',
      loginCheck: { loggedIn: '.me', wall: '.login' },
      actions: [{ kind: 'scroll', expect: { selector: '.card' } }],
      harvest: { mode: 'xhr', urlPattern: '*/feed*', itemsAt: 'data', dedupeBy: 'id', targetCount: 10, mapping: { guid: 'id' }, assert: [{ path: 'data', desc: 'feed' }] },
    }
    const ok = await validateCandidate({ localSourceId: 'demo', original: v1, candidatePath: write({ ...v1, version: 3, actions: [{ kind: 'scroll', selector: '.feed', expect: { selector: '.card' } }] }) })
    expect(ok.validation.schema).toBe('ok')
    expect(ok.ok).toBe(true)
    const bad = await validateCandidate({ localSourceId: 'demo', original: v1, candidatePath: write({ ...v1, version: 3, actions: [{ kind: 'scroll', expect: { selector: '.anything' } }] }) })
    expect(bad.ok).toBe(false)
    expect(bad.validation.assertions).not.toBe('ok')
  })
  it('canonical recipe 改 output.assert → 不过', async () => {
    const cb = {
      version: 2, kind: 'browser', sourceId: 'demo', cookieDomain: 'a.example', entryUrl: 'https://a.example/',
      loginCheck: { loggedIn: '.me', wall: '.login' },
      session: { facility: 'demo', lifecycle: 'one-shot', visibility: 'unattended' },
      steps: [],
      observers: [{ kind: 'network', urlPattern: '*/x*', windowMs: 5000, maxBodyBytes: 1000000 }],
      output: { itemsAt: 'data', dedupeBy: 'id', targetCount: 5, mapping: { guid: 'id' }, assert: [{ path: 'data', desc: 'd' }] },
    }
    const ok = await validateCandidate({ localSourceId: 'demo', original: cb, candidatePath: write({ ...cb, version: 3, observers: [{ kind: 'network', urlPattern: '*/x2*', windowMs: 5000, maxBodyBytes: 1000000 }] }) })
    expect(ok.validation.schema).toBe('ok')
    expect(ok.ok).toBe(true)
    const bad = await validateCandidate({ localSourceId: 'demo', original: cb, candidatePath: write({ ...cb, version: 3, output: { ...cb.output, assert: [] } }) })
    expect(bad.ok).toBe(false)
    expect(bad.validation.assertions).not.toBe('ok')
  })
  it('候选自己把参数改成 required → 绕不过 probe：assertions 不过，且执行器没被调', async () => {
    const withOptional = { ...original, meta: { ...original.meta, params_schema: { q: { type: 'string', required: false } } } }
    let called = false
    const r = await validateCandidate({
      localSourceId: 'demo',
      original: withOptional,
      candidatePath: write({ ...withOptional, version: 5, meta: { ...withOptional.meta, params_schema: { q: { type: 'string', required: true } } } }),
      probe: async () => { called = true; return { outcome: 'ok', items: 1 } },
    })
    expect(r.validation.assertions).not.toBe('ok')
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
  it('要不要跑 probe 看原版：原版没有必填参数 → 照跑', async () => {
    const withOptional = { ...original, meta: { ...original.meta, params_schema: { q: { type: 'string', required: false } } } }
    let called = false
    const r = await validateCandidate({
      localSourceId: 'demo',
      original: withOptional,
      candidatePath: write({ ...withOptional, version: 5 }),
      probe: async () => { called = true; return { outcome: 'ok', items: 2 } },
    })
    expect(called).toBe(true)
    expect(r.validation.probe).toBe('ok')
  })
  it('probe 抛错 → 不过，原因原样带出来', async () => {
    const r = await validateCandidate({ localSourceId: 'demo', original, candidatePath: write({ ...original, version: 5 }), probe: async () => { throw new Error('relay 掉线') } })
    expect(r.ok).toBe(false)
    expect(r.validation.probe).toMatch(/relay 掉线/)
  })
})
