import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractContribution, validateContribution, absorbContribution, contributionFromPrDiff, main } from './recipe-absorb.mjs'

const c = {
  recipe: 'wechat-send', package: { name: '@streamapp/wechat', version: '1.0.1' }, stream: '0.0.21', step: 'L',
  grounding: { on: { platform: 'darwin' }, kind: 'click', at: { x: 0.6, y: 0.87 } },
  verified: { runs: 4, first: '2026-09-14', last: '2026-09-17', by: 'human' },
}
const recipe = () => ({ kind: 'desktop', sourceId: 'wechat-send', steps: [{ label: 'L', kind: 'click', at: { x: 0.5, y: 0.5 }, blind: 'b' }] })

describe('extractContribution', () => {
  it('从 ```json 块里取；纯 JSON 也行；没有就抛', () => {
    expect(extractContribution('前言\n```json\n' + JSON.stringify(c) + '\n```\n尾巴')).toEqual(c)
    expect(extractContribution(JSON.stringify(c))).toEqual(c)
    expect(() => extractContribution('没有块')).toThrow(/JSON/)
  })
})
describe('validateContribution', () => {
  it('缺字段 / grounding 带 expect / on 缺 → 抛，指名字段', () => {
    expect(() => validateContribution(c)).not.toThrow()
    expect(() => validateContribution({ ...c, step: undefined })).toThrow(/step/)
    expect(() => validateContribution({ ...c, grounding: { ...c.grounding, expect: {} } })).toThrow(/expect/)
    expect(() => validateContribution({ ...c, grounding: { kind: 'click' } })).toThrow(/on/)
  })
  it('step 与 area 恰给一个；区域的落地方式只许有 region', () => {
    const a = { ...c, step: undefined, area: '气泡区', grounding: { on: { platform: 'darwin' }, region: 'bottom' } }
    expect(() => validateContribution(a)).not.toThrow()
    expect(() => validateContribution({ ...a, step: 'L' })).toThrow(/step 和 area 只能给一个/)
    expect(() => validateContribution({ ...c, step: undefined })).toThrow(/step 和 area 只能给一个/)
    expect(() => validateContribution({ ...a, grounding: { ...a.grounding, kind: 'click' } })).toThrow(/只许有 region/)
    // 元数据键不算「多了一个」。
    expect(() => validateContribution({ ...a, grounding: { ...a.grounding, note: 'x' } })).not.toThrow()
  })
})
describe('absorbContribution', () => {
  it('没有同 on → 插入，by=contributed，带 ref', () => {
    const r = absorbContribution(recipe(), c, '#12')
    expect(r.action).toBe('inserted')
    expect(r.recipe.steps[0].groundings).toEqual([{ on: { platform: 'darwin' }, kind: 'click', at: { x: 0.6, y: 0.87 }, verified: { ...c.verified, by: 'contributed' }, ref: '#12' }])
  })
  it('同 on 同 body → 只合并 verified（runs 相加、first 取早、last 取晚）', () => {
    const base = absorbContribution(recipe(), c, '#12').recipe
    const r = absorbContribution(base, { ...c, verified: { runs: 2, first: '2026-09-10', last: '2026-09-20', by: 'human' } }, '#13')
    expect(r.action).toBe('merged-verified')
    expect(r.recipe.steps[0].groundings[0].verified).toEqual({ runs: 6, first: '2026-09-10', last: '2026-09-20', by: 'contributed' })
  })
  it('同 on 但 body 不同 → 并列为第二条，不替换', () => {
    const base = absorbContribution(recipe(), c, '#12').recipe
    const r = absorbContribution(base, { ...c, grounding: { on: { platform: 'darwin' }, kind: 'click', at: { x: 0.5, y: 0.9 } } }, '#14')
    expect(r.action).toBe('appended')
    expect(r.recipe.steps[0].groundings).toHaveLength(2)
  })
  it('找不到 label → 抛', () => {
    expect(() => absorbContribution(recipe(), { ...c, step: 'nope' }, '#1')).toThrow(/nope/)
  })
  it('{ area } 条目：落到 recipe.areas[名字].groundings，四种情形同 steps', () => {
    const withArea = () => ({
      ...recipe(),
      areas: { 气泡区: { groundings: [{ on: { platform: 'darwin' }, region: 'bottom', verified: { runs: 2, first: '2026-09-01', last: '2026-09-02', by: 'contributed' } }] } },
    })
    const ac = (region, on = { platform: 'darwin' }) => ({
      recipe: 'wechat-send', package: { name: '@streamapp/wechat', version: '1.0.1' }, stream: '0', area: '气泡区',
      grounding: { on, region }, verified: { runs: 3, first: '2026-09-10', last: '2026-09-13', by: 'human' },
    })
    expect(absorbContribution(withArea(), ac('bottom'), '#9').action).toBe('merged-verified')
    const appended = absorbContribution(withArea(), ac('top'), '#9')
    expect(appended.action).toBe('appended')
    expect(appended.recipe.areas.气泡区.groundings).toHaveLength(2)
    // 步骤那边一条都没多——区域条目不该顺手落进 steps。
    expect(appended.recipe.steps[0].groundings).toBeUndefined()
    expect(absorbContribution(withArea(), ac('top', { platform: 'win32' }), '#9').action).toBe('inserted')
    expect(() => absorbContribution(withArea(), { ...ac('top'), area: '没有的' }, '#9')).toThrow(/没有名为/)
  })
  // `recipe.areas?.[c.area]` 对 `c.area === '__proto__'` 会解析到 Object.prototype（真值），
  // 脚本会当作"找到宿主"去改它、并报 inserted——实际什么都没插进这份 recipe，且污染了原型。
  it('area 名是 __proto__ → 拒（不能当成找到了宿主）', () => {
    const withArea = () => ({
      ...recipe(),
      areas: { 气泡区: { groundings: [{ on: { platform: 'darwin' }, region: 'bottom', verified: { runs: 2, first: '2026-09-01', last: '2026-09-02', by: 'contributed' } }] } },
    })
    expect(() => absorbContribution(withArea(), {
      recipe: 'wechat-send', package: { name: 'p', version: '1' }, stream: '0', area: '__proto__',
      grounding: { on: { platform: 'darwin' }, region: 'top' }, verified: { runs: 1, first: '2026-09-10', last: '2026-09-10', by: 'human' },
    }, '#9')).toThrow(/没有名为/)
  })
  it('顶层只有通用 region、还没有 groundings 的区域 → 也能插入', () => {
    const r = { ...recipe(), areas: { 气泡区: { region: 'center' } } }
    const out = absorbContribution(r, { recipe: 'wechat-send', package: { name: 'p', version: '1' }, stream: '0', area: '气泡区', grounding: { on: { platform: 'darwin' }, region: 'bottom' }, verified: { runs: 3, first: '2026-09-10', last: '2026-09-13', by: 'human' } }, '#9')
    expect(out.action).toBe('inserted')
    expect(out.recipe.areas.气泡区).toEqual({ region: 'center', groundings: [{ on: { platform: 'darwin' }, region: 'bottom', verified: { runs: 3, first: '2026-09-10', last: '2026-09-13', by: 'contributed' }, ref: '#9' }] })
  })
})

describe('contributionFromPrDiff', () => {
  it('从新建文件 contributions/*.json 的 + 行里拼回贡献物 JSON', () => {
    const diff = [
      'diff --git a/contributions/wechat-send/darwin-abcd1234.json b/contributions/wechat-send/darwin-abcd1234.json',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/contributions/wechat-send/darwin-abcd1234.json',
      '@@ -0,0 +1,3 @@',
      '+{',
      `+  "recipe": ${JSON.stringify(c.recipe)}`,
      '+}',
      '',
    ].join('\n')
    expect(contributionFromPrDiff(diff)).toEqual({ recipe: c.recipe })
  })
  it('没有 contributions/*.json 的新建文件 → undefined', () => {
    const diff = ['diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-旧', '+新', ''].join('\n')
    expect(contributionFromPrDiff(diff)).toBeUndefined()
  })
})

describe('main（PR 路径的 diff 兜底）', () => {
  let tmp: string
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('PR 正文没有 JSON 块 → 从 gh pr diff 里取贡献物，写回 recipe', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'recipe-absorb-'))
    const pkgDir = join(tmp, 'packages', 'wechat')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: c.package.name, stream: { contribute: { path: 'recipe.json' } } }))
    const recipeFile = join(tmp, 'recipe.json')
    writeFileSync(recipeFile, JSON.stringify(recipe()))

    const diff = [
      'diff --git a/contributions/wechat-send/darwin-abcd1234.json b/contributions/wechat-send/darwin-abcd1234.json',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/contributions/wechat-send/darwin-abcd1234.json',
      '@@ -0,0 +1,1 @@',
      `+${JSON.stringify(c)}`,
      '',
    ].join('\n')

    const gh = (args: string[]) => {
      if (args[0] === 'issue') throw new Error('不是 issue')
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ body: '这是一个 PR，正文没有 JSON 块' })
      if (args[0] === 'pr' && args[1] === 'diff') return diff
      throw new Error(`未预期的 gh 调用：${args.join(' ')}`)
    }

    const code = await main(['12'], { gh, packagesRoot: join(tmp, 'packages'), repoRoot: tmp })
    expect(code).toBe(0)
    const written = JSON.parse(readFileSync(recipeFile, 'utf8'))
    expect(written.steps[0].groundings).toEqual([{ on: { platform: 'darwin' }, kind: 'click', at: { x: 0.6, y: 0.87 }, verified: { ...c.verified, by: 'contributed' }, ref: '#12' }])
  })
})
