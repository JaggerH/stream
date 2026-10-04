// src/replay/desktop-override-store.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecipeOverrideStore, type LocalGrounding } from './desktop-override-store.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'ovr-'))
const g = (extra: Partial<LocalGrounding> = {}): LocalGrounding => ({
  on: { platform: 'darwin' }, kind: 'click', at: { x: 0.6, y: 0.87 },
  verified: { runs: 1, first: '2026-09-14', last: '2026-09-14', by: 'human' }, ...extra,
})

describe('RecipeOverrideStore', () => {
  it('没文件 = 空；文件坏了当空并不炸', () => {
    const s = new RecipeOverrideStore(dir())
    expect(s.load('x')).toEqual({ recipe: 'x', steps: {}, areas: {}, edges: [] })
    expect(s.groundingsFor('x', 'L')).toEqual([])
  })
  it('addGrounding 落盘到 <dir>/<sourceId>.json', () => {
    const d = dir(); const s = new RecipeOverrideStore(d)
    s.addGrounding('x', 'L', g(), { name: '@streamapp/wechat', version: '1.0.0' })
    const f = JSON.parse(readFileSync(join(d, 'x.json'), 'utf8'))
    expect(f.package).toEqual({ name: '@streamapp/wechat', version: '1.0.0' })
    expect(f.steps.L.groundings).toHaveLength(1)
  })
  it('recordRun：同 label 同 on 同 body → runs+1、last 更新、app 区间按 appVersion 扩', () => {
    let day = '2026-09-14'
    const s = new RecipeOverrideStore(dir(), () => day)
    s.addGrounding('x', 'L', g({ on: { platform: 'darwin', app: '>=4.0.6 <=4.0.6' } }))
    day = '2026-09-16'
    s.recordRun('x', [{ label: 'L', body: { kind: 'click', at: { x: 0.6, y: 0.87 } }, on: { platform: 'darwin', app: '>=4.0.6 <=4.0.6' }, by: 'human' }], { platform: 'darwin', appVersion: '4.0.8' })
    const [row] = s.groundingsFor('x', 'L')
    expect(row.verified).toEqual({ runs: 2, first: '2026-09-14', last: '2026-09-16', by: 'human' })
    expect(row.on.app).toBe('>=4.0.6 <=4.0.8')
  })
  it('recordRun：包内 grounding（by author）的记账也落在本机文件里，第一次见就建行', () => {
    const s = new RecipeOverrideStore(dir())
    s.recordRun('x', [{ label: 'L', body: { kind: 'click', see: { text: '发送' } }, on: { platform: 'win32' }, by: 'author' }], { platform: 'win32' })
    expect(s.groundingsFor('x', 'L')[0].verified.by).toBe('author')
  })
  it('reconcile：本机 ai/human 条目与包内某条 body 相同 → 删除；on 被包覆盖但 body 不同 → shadowed；author 记账行不删', () => {
    const s = new RecipeOverrideStore(dir())
    s.addGrounding('x', 'L', g())                                                            // 与包相同 → 删
    s.addGrounding('x', 'L', g({ at: { x: 0.5, y: 0.9 } }))                                  // on 同、body 异 → shadowed
    s.addGrounding('x', 'L', g({ on: { platform: 'win32' }, verified: { runs: 1, first: 'a', last: 'a', by: 'author' } })) // 记账行 → 留
    const r = s.reconcile('x', { steps: [{ label: 'L', groundings: [{ on: { platform: 'darwin' }, kind: 'click', at: { x: 0.6, y: 0.87 } }] }] })
    expect(r).toEqual({ removed: 1, shadowed: 1 })
    const rows = s.groundingsFor('x', 'L')
    expect(rows).toHaveLength(2)
    expect(rows.find((x) => x.on.platform === 'darwin')!.shadowed).toBe(true)
    expect(rows.find((x) => x.on.platform === 'win32')!.shadowed).toBeFalsy()
  })
  // 对账现在每趟运行开头都跑一次（见 `OverrideSource.reconcile`），所以"没变化"是常态。
  // 无条件落盘会给每条从没学过东西的 recipe 建一个空壳文件，那个目录就不再能回答
  // 「这台机器学到过什么」——而空文件和真有内容的文件长得一样，谁都不会去怀疑它。
  it('reconcile：没变化就不落盘（没文件的不新建），真删了才重写', () => {
    const d = dir(); const s = new RecipeOverrideStore(d)
    const pkgStep = { steps: [{ label: 'L', groundings: [{ on: { platform: 'darwin' as const }, kind: 'click', at: { x: 0.6, y: 0.87 } }] }] }
    expect(s.reconcile('never-learned', pkgStep)).toEqual({ removed: 0, shadowed: 0 })
    expect(existsSync(join(d, 'never-learned.json'))).toBe(false)

    s.addGrounding('x', 'L', g())
    const before = readFileSync(join(d, 'x.json'), 'utf8')
    expect(s.reconcile('x', pkgStep)).toEqual({ removed: 1, shadowed: 0 })
    expect(readFileSync(join(d, 'x.json'), 'utf8')).not.toBe(before)
    expect(s.groundingsFor('x', 'L')).toEqual([])
  })
  it('contributable：≥3 次且跨 ≥2 天，且 by 是 ai/human；shadowed 的不算', () => {
    const s = new RecipeOverrideStore(dir())
    s.addGrounding('x', 'L', g({ verified: { runs: 3, first: '2026-09-14', last: '2026-09-16', by: 'human' } }))
    s.addGrounding('x', 'M', g({ verified: { runs: 3, first: '2026-09-14', last: '2026-09-15', by: 'human' } }))     // 只跨 1 天
    s.addGrounding('x', 'N', g({ verified: { runs: 9, first: '2026-09-01', last: '2026-09-16', by: 'author' } }))    // 包内记账
    s.addGrounding('x', 'O', g({ verified: { runs: 9, first: '2026-09-01', last: '2026-09-16', by: 'ai' }, shadowed: true }))
    expect(s.contributable('x').map((c) => c.label)).toEqual(['L'])
  })
})

// 具名区域（spec §3.4）：形状与 steps 一模一样，只是键是区域名而不是步骤 label。
// 分开一段是因为消费方不同：steps 那份喂 rankGroundings 逐条试，areas 那份开跑前查一次表。
describe('areas', () => {
  it('recordRun 按 area 落到 areas 段，同 on 同 region 累加', () => {
    const s = new RecipeOverrideStore(dir(), () => '2026-09-13')
    const u = { area: '气泡区', body: { region: { x: 0.34, y: 0.4, w: 0.66, h: 0.38 } }, on: { platform: 'win32' as const }, by: 'ai' as const }
    s.recordRun('wechat-send', [u], { platform: 'win32' })
    s.recordRun('wechat-send', [u], { platform: 'win32' })
    const f = s.load('wechat-send')
    expect(f.steps).toEqual({})
    expect(f.areas['气泡区'].groundings).toHaveLength(1)
    expect(f.areas['气泡区'].groundings[0].verified.runs).toBe(2)
    expect(s.areaGroundingsFor('wechat-send', '气泡区')).toHaveLength(1)
    expect(s.areaGroundingsFor('wechat-send', '别的')).toEqual([])
  })
  it('contributable 把 area 条目和 step 条目一起给出，门槛相同', () => {
    const s = new RecipeOverrideStore(dir(), () => '2026-09-13')
    s.addAreaGrounding('wechat-send', '气泡区', { on: { platform: 'darwin' }, region: 'bottom', verified: { runs: 3, first: '2026-09-10', last: '2026-09-13', by: 'human' } })
    s.addAreaGrounding('wechat-send', '标题栏', { on: { platform: 'darwin' }, region: 'top', verified: { runs: 1, first: '2026-09-13', last: '2026-09-13', by: 'human' } })
    expect(s.contributable('wechat-send')).toEqual([{ area: '气泡区', grounding: expect.objectContaining({ region: 'bottom' }) }])
  })
  it('reconcile 对区域同样：已上游的删、被覆盖的标 shadowed', () => {
    const s = new RecipeOverrideStore(dir(), () => '2026-09-13')
    s.addAreaGrounding('wechat-send', '气泡区', { on: { platform: 'darwin' }, region: 'bottom', verified: { runs: 3, first: '2026-09-10', last: '2026-09-13', by: 'ai' } })
    s.addAreaGrounding('wechat-send', '气泡区', { on: { platform: 'win32' }, region: 'center', verified: { runs: 3, first: '2026-09-10', last: '2026-09-13', by: 'ai' } })
    const r = s.reconcile('wechat-send', { steps: [], areas: { 气泡区: { groundings: [{ on: { platform: 'darwin' }, region: 'bottom' }, { on: { platform: 'win32' }, region: 'top' }] } } })
    expect(r).toEqual({ removed: 1, shadowed: 1 })
    const rows = s.areaGroundingsFor('wechat-send', '气泡区')
    expect(rows).toHaveLength(1)
    expect(rows[0].shadowed).toBe(true)
  })
  it('label / area 一个都没给的记账条目 → 抛，不落到 "undefined" 那一格', () => {
    const s = new RecipeOverrideStore(dir())
    expect(() => s.recordRun('x', [{ body: { region: 'top' }, on: { platform: 'win32' }, by: 'ai' }], { platform: 'win32' }))
      .toThrow(/要么 label 要么 area/)
  })
  it('老文件没有 areas 段 → 当空，不抛', () => {
    const d = dir()
    writeFileSync(join(d, 'x.json'), JSON.stringify({ recipe: 'x', steps: {}, edges: [] }))
    expect(new RecipeOverrideStore(d).areaGroundingsFor('x', '气泡区')).toEqual([])
  })
})
