// src/replay/desktop-override-store.ts
/**
 * 本机学到的落地方式：`<dataDir>/recipe-overrides/<sourceId>.json`。
 *
 * **不在包目录**：装的包住 `<dataDir>/recipes/<包名>/`，升级整目录覆盖，放里面就丢。
 * 形状和包里的 `groundings[]` 一模一样，只多一段来源（`verified.by` 是 ai / human、`origin`）——
 * 所以每一条都是一个能合回包里的块，不是私有魔改。包内 grounding 的次数记账也落在这里
 * （包文件只读）。写盘同步、整份重写：文件小（几 KB），而运行时记账发生在一趟 recipe 的末尾，
 * 不在热路径上。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sameBody, groundingBody, type Grounding, type GroundingBy, type GroundingFacts, type GroundingKey, type GroundingVerified } from './desktop-grounding.ts'

export interface LocalGrounding extends Grounding {
  verified: GroundingVerified
  origin?: { run?: string; evidence?: string }
  /** 包升级后同 key 被包覆盖、但 body 不同——留给用户看，运行时不参与。 */
  shadowed?: boolean
}
export interface OverrideFile {
  recipe: string
  package?: { name: string; version: string }
  steps: Record<string, { groundings: LocalGrounding[] }>
  /** 具名区域的本机落地方式，形状同 steps（spec §3.4）。 */
  areas: Record<string, { groundings: LocalGrounding[] }>
  edges: unknown[]
}
/** `label`（步骤）与 `area`（区域）恰给一个。 */
export interface UsedGrounding { label?: string; area?: string; body: Record<string, unknown>; on: GroundingKey; by: GroundingBy }

export const CONTRIBUTE_MIN_RUNS = 3
export const CONTRIBUTE_MIN_DAYS = 2

const today = () => new Date().toISOString().slice(0, 10)
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const sameKey = (a: GroundingKey, b: GroundingKey) => a.platform === b.platform && a.lang === b.lang && (a.app ?? '') === (b.app ?? '')

/** `>=a <=b` 形状的区间按新版本扩边；别的写法原样留着（人写的区间不替他改）。 */
export function widenAppRange(range: string | undefined, version: string | undefined): string | undefined {
  if (!version) return range
  if (!range) return `>=${version} <=${version}`
  const m = /^>=(\d+(?:\.\d+)*) <=(\d+(?:\.\d+)*)$/.exec(range)
  if (!m) return range
  const cmp = (x: string, y: string) => {
    const a = x.split('.').map(Number), b = y.split('.').map(Number)
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d }
    return 0
  }
  const lo = cmp(version, m[1]) < 0 ? version : m[1]
  const hi = cmp(version, m[2]) > 0 ? version : m[2]
  return `>=${lo} <=${hi}`
}

export class RecipeOverrideStore {
  constructor(private readonly dir: string, private readonly now: () => string = today) {}

  private path(sourceId: string) { return join(this.dir, `${sourceId}.json`) }

  load(sourceId: string): OverrideFile {
    const empty: OverrideFile = { recipe: sourceId, steps: {}, areas: {}, edges: [] }
    const p = this.path(sourceId)
    if (!existsSync(p)) return empty
    try {
      const f = JSON.parse(readFileSync(p, 'utf8')) as Partial<OverrideFile>
      return { recipe: sourceId, ...(f.package ? { package: f.package } : {}), steps: f.steps ?? {}, areas: f.areas ?? {}, edges: f.edges ?? [] }
    } catch (e) {
      // 坏文件当空，但要喊：安静地当空等于把用户攒了几周的记账丢掉还不告诉他。
      console.warn(`[recipe-overrides] ${p} 读不出来，当空：${(e as Error).message}`)
      return empty
    }
  }
  private save(f: OverrideFile): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.path(f.recipe), JSON.stringify(f, null, 2) + '\n')
  }

  groundingsFor(sourceId: string, label: string): LocalGrounding[] {
    return this.load(sourceId).steps[label]?.groundings ?? []
  }

  addGrounding(sourceId: string, label: string, g: LocalGrounding, pkg?: { name: string; version: string }): void {
    const f = this.load(sourceId)
    if (pkg) f.package = pkg
    ;(f.steps[label] ??= { groundings: [] }).groundings.push(g)
    this.save(f)
  }

  areaGroundingsFor(sourceId: string, name: string): LocalGrounding[] {
    return this.load(sourceId).areas[name]?.groundings ?? []
  }

  addAreaGrounding(sourceId: string, name: string, g: LocalGrounding, pkg?: { name: string; version: string }): void {
    const f = this.load(sourceId)
    if (pkg) f.package = pkg
    ;(f.areas[name] ??= { groundings: [] }).groundings.push(g)
    this.save(f)
  }

  /** 一趟 recipe 走到 done 之后：每条用到的 grounding 记一笔（同 label 同 on 同 body = 同一条）。 */
  recordRun(sourceId: string, used: UsedGrounding[], facts: GroundingFacts, pkg?: { name: string; version: string }): void {
    if (used.length === 0) return
    const f = this.load(sourceId)
    if (pkg) f.package = pkg
    const d = this.now()
    for (const u of used) {
      // 两个键一个都没给 → 当场抛。放任的话这一笔会落到字面量 `"undefined"` 那一格：文件里
      // 多一个谁也认不出的键，而记账、对账、贡献三处都照常跑——一条落地方式就此攒在一个
      // 永远不会被查的名字底下，没有任何一处会喊。
      if (u.label === undefined && u.area === undefined) {
        throw new Error(`UsedGrounding 要么 label 要么 area：${JSON.stringify(u)}`)
      }
      const rows = u.area !== undefined
        ? (f.areas[u.area] ??= { groundings: [] }).groundings
        : (f.steps[u.label!] ??= { groundings: [] }).groundings
      const hit = rows.find((r) => sameKey(r.on, u.on) && sameBody(groundingBody(r), u.body))
      if (hit) {
        hit.verified.runs += 1
        hit.verified.last = d
        if (hit.on.app !== undefined) hit.on.app = widenAppRange(hit.on.app, facts.appVersion)
      } else {
        rows.push({ ...u.body, on: { ...u.on }, verified: { runs: 1, first: d, last: d, by: u.by } })
      }
    }
    this.save(f)
  }

  /** 包升级后对账（spec §5.3）：已上游的删、被覆盖的标 shadowed、包内记账行不动。 */
  reconcile(
    sourceId: string,
    recipe: { steps: Array<{ label?: string; groundings?: Grounding[] }>; areas?: Record<string, { groundings?: Grounding[] }> },
  ): { removed: number; shadowed: number } {
    const f = this.load(sourceId)
    let removed = 0, shadowed = 0
    /** 一格（一个步骤 label 或一块区域）对一次账。步骤和区域同一套规则，所以只有这一份。 */
    const settle = (rows: LocalGrounding[], pkg: Grounding[]): LocalGrounding[] => rows.filter((r) => {
      const learned = r.verified.by === 'ai' || r.verified.by === 'human'
      const same = pkg.find((p) => sameKey(p.on, r.on) && sameBody(groundingBody(p), groundingBody(r)))
      if (learned && same) { removed++; return false }
      const covered = pkg.some((p) => sameKey(p.on, r.on))
      if (learned && covered && !r.shadowed) { r.shadowed = true; shadowed++ }
      return true
    })
    for (const step of recipe.steps) {
      const rows = step.label ? f.steps[step.label]?.groundings : undefined
      if (!rows) continue
      f.steps[step.label!].groundings = settle(rows, step.groundings ?? [])
    }
    for (const [name, a] of Object.entries(recipe.areas ?? {})) {
      const rows = f.areas[name]?.groundings
      if (!rows) continue
      f.areas[name].groundings = settle(rows, a.groundings ?? [])
    }
    // **没变化就不落盘**：对账现在每趟运行开头都跑一次，无条件 save 会给每条从没学过东西的
    // recipe 建一个空壳 `{steps:{},edges:[]}`——那个目录本该只装"这台机器真学到过的东西"，
    // 一地空文件会让 `contributable` 之外的每个读它的人先怀疑自己。
    if (removed + shadowed > 0) this.save(f)
    return { removed, shadowed }
  }

  contributable(sourceId: string, minRuns = CONTRIBUTE_MIN_RUNS, minDays = CONTRIBUTE_MIN_DAYS): Array<{ label?: string; area?: string; grounding: LocalGrounding }> {
    const f = this.load(sourceId)
    const out: Array<{ label?: string; area?: string; grounding: LocalGrounding }> = []
    const ripe = (g: LocalGrounding) =>
      (g.verified.by === 'ai' || g.verified.by === 'human') && !g.shadowed &&
      g.verified.runs >= minRuns && days(g.verified.first, g.verified.last) >= minDays
    for (const [label, { groundings }] of Object.entries(f.steps)) {
      for (const g of groundings) if (ripe(g)) out.push({ label, grounding: g })
    }
    // 区域条目和步骤条目同一个门槛、同一个清单：贡献侧（Task 3）拿到的是一份"这台机器验够了的
    // 落地方式"，区域也是落地方式的一种，分两条路出去只会让其中一条被忘掉。
    for (const [area, { groundings }] of Object.entries(f.areas)) {
      for (const g of groundings) if (ripe(g)) out.push({ area, grounding: g })
    }
    return out
  }
}
