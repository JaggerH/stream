/**
 * Deterministic, item-level ad classifier. Pure function over a few item fields
 * and a user-tunable rule set (keywords + domains from config.yaml). Matches are
 * explainable — the returned flag names the exact rule that fired so the UI can
 * show "folded: matched 推广". Folding (not deleting) is the caller's job; this
 * only labels. See docs/design/normalization-layer.md.
 */

export interface AdRules {
  /** substring match (case-insensitive) against title + body text */
  keywords?: string[]
  /** host match against item urls — exact host or any subdomain of it */
  domains?: string[]
}

export interface MutedFlag {
  /** classifyAd only ever emits 'ad'. 'lottery' is a manual-label-only value today.
   *  Widened to `string` (not a literal union) so a future non-ad filter type (e.g.
   *  低质量/水贴) can reuse this fold mechanism without a breaking type change. */
  reason: string
  /** the keyword/domain that matched, or 'manual' for a human read-time label */
  rule: string
  /** set when a human labeled it (gold standard), absent for auto rule hits */
  manual?: true
}

export interface AdFields {
  title?: string
  text?: string
  urls?: string[]
  /** source-provided tags (RSSHub item.category) — some sources flag promos here
   *  (e.g. v2ex's 推广 node), so keywords match against these too. */
  categories?: string[]
}

function hostOf(u: string): string | undefined {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** host equals the rule domain, or is a subdomain of it (a.b.taobao.com ⊂ taobao.com). */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export function classifyAd(fields: AdFields, rules: AdRules): MutedFlag | undefined {
  const haystack = `${fields.title ?? ''} ${fields.text ?? ''} ${(fields.categories ?? []).join(' ')}`.toLowerCase()
  for (const kw of rules.keywords ?? []) {
    if (kw && haystack.includes(kw.toLowerCase())) return { reason: 'ad', rule: kw }
  }

  const hosts = (fields.urls ?? []).map(hostOf).filter((h): h is string => !!h)
  for (const domain of rules.domains ?? []) {
    const d = domain.toLowerCase()
    if (hosts.some((h) => hostMatches(h, d))) return { reason: 'ad', rule: domain }
  }

  return undefined
}
