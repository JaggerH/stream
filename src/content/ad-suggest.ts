/**
 * Precision-guarded rule suggestion. Given a red-light positive (an ad the
 * current rules fail to mute), propose candidate rules that would catch it —
 * registrable domains from its URLs and keywords from its category tags / a
 * promotional lexicon. Any candidate that would also mute a known negative
 * fixture is dropped. Output is advisory only: callers print it for human
 * review and MUST NOT auto-commit it to the rule set. See
 * docs/superpowers/specs/2026-06-14-ad-fixture-loop-design.md.
 */
import { classifyAd, type AdFields, type AdRules } from './ad-filter.ts'

export type CandidateBasis = 'category' | 'domain' | 'token'

export interface RuleCandidate {
  kind: 'domain' | 'keyword'
  value: string
  basis: CandidateBasis
}

/** Promotional lexicon — tokens that, in titles/bodies, strongly indicate an ad/giveaway. */
const PROMO_LEXICON = [
  '抽奖', '瓜分', '限时', '福利', '赢取', '空投', '邀请', '返现',
  '秒杀', '恰饭', '优惠', '立减', '红包', '领取', '免费送', '中奖',
]

/** Registrable domain (naive eTLD+1): last two dot-labels of the host. */
function registrableDomain(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const parts = host.split('.').filter(Boolean)
    if (parts.length < 2) return host || undefined
    return parts.slice(-2).join('.')
  } catch {
    return undefined
  }
}

const BASIS_RANK: Record<CandidateBasis, number> = { category: 0, domain: 1, token: 2 }

export function suggestRules(fields: AdFields, rules: AdRules, negatives: AdFields[]): RuleCandidate[] {
  const haveKw = new Set((rules.keywords ?? []).map((k) => k.toLowerCase()))
  const haveDom = new Set((rules.domains ?? []).map((d) => d.toLowerCase()))
  const seen = new Set<string>()
  const candidates: RuleCandidate[] = []

  const pushKw = (value: string, basis: CandidateBasis) => {
    const key = `kw:${value.toLowerCase()}`
    if (!value || haveKw.has(value.toLowerCase()) || seen.has(key)) return
    seen.add(key)
    candidates.push({ kind: 'keyword', value, basis })
  }

  // category tags verbatim — highest precision (source-provided)
  for (const cat of fields.categories ?? []) pushKw(cat, 'category')

  // registrable domains from URLs
  for (const url of fields.urls ?? []) {
    const dom = registrableDomain(url)
    const key = `dom:${dom}`
    if (!dom || haveDom.has(dom) || seen.has(key)) continue
    seen.add(key)
    candidates.push({ kind: 'domain', value: dom, basis: 'domain' })
  }

  // promo-lexicon tokens present in title/body/categories
  const hay = `${fields.title ?? ''} ${fields.text ?? ''} ${(fields.categories ?? []).join(' ')}`
  for (const token of PROMO_LEXICON) if (hay.includes(token)) pushKw(token, 'token')

  // precision guard: drop any candidate that would mute a known negative
  const guarded = candidates.filter((c) => {
    const probe: AdRules =
      c.kind === 'domain' ? { keywords: [], domains: [c.value] } : { keywords: [c.value], domains: [] }
    return !negatives.some((neg) => classifyAd(neg, probe))
  })

  return guarded.sort((a, b) => BASIS_RANK[a.basis] - BASIS_RANK[b.basis])
}
