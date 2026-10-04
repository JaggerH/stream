import type { Registry } from '../registry/registry.ts'
import { trackRefFromUrl, type TrackRef } from '../audio/track-url.ts'

/** A classification rule: given a pasted input, return the target key or null if it doesn't match. */
export interface IntentRule {
  targetType: string
  match: (input: string) => string | null
}

export interface IntentResult {
  /** the resolved target-type, or 'generic-url' (any URL) / 'unknown' (no match) */
  targetType: string
  key: string
  /** source ids that can resolve this target-type, in priority order (the derived ladder) */
  candidates: string[]
}

/**
 * Classify a pasted URL/identifier into a Target `{target-type, key}` and the candidate Sources
 * that can resolve it (RSSHub-Radar-style discovery). Rule-based here; an AI-assisted classifier
 * can be layered on top for disambiguation. Any unmatched URL falls back to `generic-url` (served
 * by the browser last rung); non-URL unmatched input is `unknown` for the UI to disambiguate.
 */
export class IntentResolver {
  /** `candidates` maps a target-type to the ordered source ids that can resolve it. Injected so it
   *  reflects the live resolve ladder (Provider row's expanded members, incl. {mode:'auto', matches}
   *  catalog sources) instead of only `provides`-declaring manifests. Defaults to the provides-derived
   *  ladder when omitted, keeping registry-only callers (tests) working. */
  constructor(
    private readonly registry: Registry,
    private readonly rules: IntentRule[],
    private readonly candidates: (targetType: string) => string[] = (tt) =>
      registry.providersOf(tt).map((m) => m.id),
    /** 「这个 URL 是谁家的哪条曲目」——认领函数的曲目视图，文法来自包的 `stream.links.patterns`
     *  （kind track；源码里没有任何站的正则，spec 2026-09-26-link-recognition）。命中 → targetType = 平台键（取歌
     *  那行的 serveKeys 里带它）、key = track id。注入是为了测试；生产上就是那张现取的表。 */
    private readonly trackRef: (url: string) => TrackRef | null = trackRefFromUrl
  ) {}

  resolve(input: string): IntentResult {
    const t = (input ?? '').trim()
    for (const r of this.rules) {
      const key = r.match(t)
      if (key != null) return this.build(r.targetType, key)
    }
    const track = this.trackRef(t)
    if (track) return this.build(track.platform, track.track_id)
    if (/^https?:\/\//i.test(t)) return this.build('generic-url', t)
    return this.build('unknown', t)
  }

  private build(targetType: string, key: string): IntentResult {
    return { targetType, key, candidates: this.candidates(targetType) }
  }
}

/** 内置分类规则。**只放没法用包的 track pattern 表达的**目标（作者页、合集页这类非曲目 URL）；曲目 URL 一律
 *  走包声明的 `stream.links.patterns`（kind track）。今天这张表是空的：非曲目目标没有任何源能解析（没有 manifest 的
 *  `provides` 里出现过这类 target-type），一条没人接的规则只会把贴进来的 URL 从 `generic-url`
 *  改判成一个候选为空的目标。哪天有包能解析作者页，规则和解析源一起来。order = match precedence。 */
export const DEFAULT_RULES: IntentRule[] = []
