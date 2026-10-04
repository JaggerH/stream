/**
 * Canonical ad-filter rules, committed so tests and runtime share one source.
 * The regression suite runs against THESE; runtime composes them with the user's
 * gitignored config.yaml `ad_filter` via mergeAdRules. Keeping the canonical set
 * in code is what makes the red-light loop work: the rule that turns a fixture
 * test green lives where the test can see it.
 *
 * NOTE: the broad topic word 广告 is intentionally excluded — it substring-matches
 * news ABOUT advertising (e.g. 36kr "广告主数增长200%"), a false positive. Prefer
 * ad-specific phrases + category/domain signals.
 */
import type { AdRules } from './ad-filter.ts'

export const DEFAULT_AD_RULES: AdRules = {
  keywords: ['推广', '赞助', '软文', '恰饭', '安利', '抽奖', '瓜分', 'sponsored', '#ad'],
  domains: ['taobao.com', 'jd.com', 'tmall.com', 'pinduoduo.com'],
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const key = v.toLowerCase()
    if (!v || seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

/** Runtime rules = defaults ⊕ user config (user values appended, deduped). */
export function mergeAdRules(defaults: AdRules, user: AdRules | undefined): AdRules {
  return {
    keywords: dedupe([...(defaults.keywords ?? []), ...(user?.keywords ?? [])]),
    domains: dedupe([...(defaults.domains ?? []), ...(user?.domains ?? [])]),
  }
}
