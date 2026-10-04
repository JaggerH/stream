// src/replay/desktop-grounding.ts
/**
 * 桌面 recipe 的「落地方式」（grounding）：一步的动作 body 可以按（平台，应用版本，界面语言）
 * 并列多份，运行时按 agent 报的事实挑。**图与判据不在这儿**——`expect` / `require` / `else` /
 * `optional` / `blind` / `label` / `intent` 只住顶层，grounding 只是"怎么点、点哪"。
 *
 * 为什么是纯函数模块：选择规则要在单测里钉死（贴合度 > 来源 > 次数、通用 body 永远最后），
 * runner 只负责逐条试与兜底。spec：docs/superpowers/specs/2026-09-13-desktop-recipe-grounding-and-contribution-design.md
 */

import type { SeeRegion } from './desktop-recipe.ts'

export type GroundingPlatform = 'win32' | 'darwin'
export const GROUNDING_PLATFORMS: readonly GroundingPlatform[] = ['win32', 'darwin']

export interface GroundingKey {
  platform?: GroundingPlatform
  /** 版本区间，`>=4.0 <4.1` 这种（见 `satisfiesRange`）。agent 报不出版本时它**不匹配**。 */
  app?: string
  lang?: string
}
export type GroundingBy = 'author' | 'contributed' | 'ai' | 'human'
export interface GroundingVerified { runs: number; first: string; last: string; by: GroundingBy }
export interface GroundingFacts { platform?: GroundingPlatform; appVersion?: string; lang?: string }
export type Grounding = { on: GroundingKey; verified?: GroundingVerified; note?: string; ref?: string } & Record<string, unknown>
export interface RankedGrounding {
  body: Record<string, unknown>
  on: GroundingKey
  verified?: GroundingVerified
  source: 'package' | 'local'
  universal: boolean
}

/** grounding 上不属于动作 body 的键。 */
export const GROUNDING_META_KEYS: readonly string[] = ['on', 'verified', 'note', 'ref', 'origin', 'shadowed']
/** 只许住顶层的键——判据与落地方式无关，grounding 里出现它们是格式错误。 */
export const STEP_TOP_ONLY_KEYS: readonly string[] = ['label', 'intent', 'expect', 'require', 'else', 'optional', 'blind', 'skipIf', 'groundings']

function versionParts(v: string): number[] {
  return v.split('.').map((p) => Number.parseInt(p, 10)).map((n) => (Number.isFinite(n) ? n : 0))
}
function compareVersions(a: string, b: string): number {
  const pa = versionParts(a), pb = versionParts(b)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}
/**
 * 版本区间：空格分隔的若干比较子（`>=4.0 <4.1`、`4.0.6`、`=4.0.6`），全部成立才算。
 * **只认这几种**：`^`/`~`/`||` 一概不认（不匹配），别引 semver 依赖去支持一个没人写的语法。
 */
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/
/**
 * 这个区间**写法对不对**——装载期问它（`recipe-store.ts` 的 `validateGroundingKey`）。
 *
 * 和 `satisfiesRange` 共用同一段 `COMPARATOR`，而不是在校验那头另写一条整串正则：两份语法定义
 * 漂了不会有任何测试喊，表现是「装载放行、运行时永不匹配」——这条落地方式就此静默消失。
 * `^4` / `~4` / `4 || 5` 在 `satisfiesRange` 里是"永不匹配"，所以这里必须当**语法错**拒掉。
 */
export function isValidRange(range: string): boolean {
  const parts = range.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return false
  return parts.every((p) => COMPARATOR.test(p))
}
export function satisfiesRange(version: string, range: string): boolean {
  const parts = range.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return false
  for (const p of parts) {
    const m = COMPARATOR.exec(p)
    if (!m) return false
    const c = compareVersions(version, m[2])
    const op = m[1] ?? '='
    const ok = op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0
    if (!ok) return false
  }
  return true
}

export function keyMatches(on: GroundingKey, facts: GroundingFacts): boolean {
  if (on.platform !== undefined && on.platform !== facts.platform) return false
  if (on.app !== undefined && (facts.appVersion === undefined || !satisfiesRange(facts.appVersion, on.app))) return false
  if (on.lang !== undefined && on.lang !== facts.lang) return false
  return true
}
export function specificity(on: GroundingKey): number {
  return ['platform', 'app', 'lang'].filter((k) => (on as Record<string, unknown>)[k] !== undefined).length
}

export function groundingBody(g: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(g)) if (!GROUNDING_META_KEYS.includes(k) && !STEP_TOP_ONLY_KEYS.includes(k)) out[k] = v
  return out
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
export function sameBody(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonical(a) === canonical(b)
}

const BY_RANK: Record<string, number> = { 'package:author': 0, 'package:contributed': 1, 'local:human': 2, 'local:ai': 3 }
function sourceRank(source: 'package' | 'local', by: GroundingBy | undefined): number {
  return BY_RANK[`${source}:${by ?? (source === 'package' ? 'author' : 'ai')}`] ?? 9
}

/**
 * 候选 = 包内 `groundings` ∪ 本机 override（未被遮蔽的）∪ 顶层通用 body，按事实过滤，
 * 排序：贴合度 > 来源（包 author > 包 contributed > 本机 human > 本机 ai）> `verified.runs`；通用永远最后。
 */
export function rankGroundings(step: Record<string, unknown>, local: Grounding[], facts: GroundingFacts): RankedGrounding[] {
  const pkg = (Array.isArray(step.groundings) ? (step.groundings as Grounding[]) : []).map((g) => ({ g, source: 'package' as const }))
  const loc = local.filter((g) => !(g as { shadowed?: boolean }).shadowed).map((g) => ({ g, source: 'local' as const }))
  const keyed: RankedGrounding[] = [...pkg, ...loc]
    .filter(({ g }) => keyMatches(g.on ?? {}, facts))
    .map(({ g, source }) => ({ body: groundingBody(g), on: g.on ?? {}, ...(g.verified ? { verified: g.verified } : {}), source, universal: false }))
    .sort((a, b) =>
      specificity(b.on) - specificity(a.on) ||
      sourceRank(a.source, a.verified?.by) - sourceRank(b.source, b.verified?.by) ||
      (b.verified?.runs ?? 0) - (a.verified?.runs ?? 0))
  const universal: RankedGrounding = { body: groundingBody(step), on: {}, source: 'package', universal: true }
  return [...keyed, universal]
}

/** 顶层公共字段（label / intent / expect / require / else / optional / blind / skipIf）+ 选中的 body。 */
export function effectiveStep<T extends Record<string, unknown>>(step: T, g: RankedGrounding): T {
  const out: Record<string, unknown> = {}
  for (const k of STEP_TOP_ONLY_KEYS) if (k !== 'groundings' && step[k] !== undefined) out[k] = step[k]
  return { ...out, ...g.body } as T
}

function templatedStrings(v: unknown, path: string, names: string[], out: Map<string, string[]>): void {
  if (typeof v === 'string') {
    const hit = names.filter((n) => v.includes(`{${n}}`))
    if (hit.length) out.set(path, hit)
  } else if (Array.isArray(v)) v.forEach((x, i) => templatedStrings(x, `${path}[${i}]`, names, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) templatedStrings(x, path ? `${path}.${k}` : k, names, out)
}
function at(obj: unknown, path: string): unknown {
  return path.split(/\.|\[|\]\.?/).filter(Boolean).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}
/**
 * 脱敏闸的可执行形式：顶层 body 里带 `{param}` 的字段，grounding 的同一路径必须还带着同一个
 * `{param}`。去模板化 = 把某次运行的参数值（联系人名、正文）写死进了落地方式——这正是贡献链
 * 不许带出去的东西，也是 recipe 跨调用就坏掉的写法。
 */
export function assertTemplatesKept(top: Record<string, unknown>, g: Record<string, unknown>, paramNames: string[], where: string): void {
  const need = new Map<string, string[]>()
  templatedStrings(groundingBody(top), '', paramNames, need)
  for (const [path, names] of need) {
    const v = at(groundingBody(g), path)
    if (v === undefined) continue // grounding 换了写法（没有这个字段）——允许
    for (const n of names) {
      if (typeof v !== 'string' || !v.includes(`{${n}}`)) {
        throw new Error(`${where} 的 ${path} 把顶层的 {${n}} 写死成了 ${JSON.stringify(v)}——落地方式里参数只能以 {${n}} 模板出现`)
      }
    }
  }
}

/** 区域 grounding 的 body 只许有这一个键（spec §3.4）。 */
export const AREA_BODY_KEYS: readonly string[] = ['region']

export interface ResolvedArea {
  region: SeeRegion
  /** 与 runner 里 step 的 tag 同形：`universal` / `package:win32@>=4 <5` / `local:darwin`。 */
  tag: string
  on: GroundingKey
  source: 'package' | 'local'
  universal: boolean
  verified?: GroundingVerified
}

/**
 * 为一块区域查一次表：`rankGroundings` 的过滤与排序原样复用，取第一条；顶层没写 `region` 的区域
 * 没有通用那一条（`rankGroundings` 总会补一个通用 body，这里把空的那个剔掉）。
 * 一条都没有 → null，调用方以 `no-grounding@area:<名字>` 判 drift——**不发明一块区域**。
 */
export function resolveArea(name: string, area: { region?: SeeRegion; groundings?: Grounding[] }, local: Grounding[], facts: GroundingFacts): ResolvedArea | null {
  void name
  const ranked = rankGroundings(area as unknown as Record<string, unknown>, local, facts).filter((r) => r.body.region !== undefined)
  const pick = ranked[0]
  if (!pick) return null
  const tag = pick.universal ? 'universal' : `${pick.source}:${pick.on.platform ?? '*'}${pick.on.app ? `@${pick.on.app}` : ''}`
  return { region: pick.body.region as SeeRegion, tag, on: pick.on, source: pick.source, universal: pick.universal, ...(pick.verified ? { verified: pick.verified } : {}) }
}
