/**
 * Backend endpoint discovery ladder. Given an optional user-configured URL, produces the
 * ordered candidate list and resolves the first healthy one via an injected probe
 * (native fetch — see backend.tsx).
 */
export type ProbeFn = (url: string) => Promise<boolean>
export interface Discovered {
  httpBase: string
  wsBase: string
  upstream: string
}

export const SAME_ORIGIN = '' as const // 同源哨兵：页面和后端在同一个源上，无需探测

export function backendCandidates(opts: { configuredUrl?: string }): string[] {
  return opts.configuredUrl ? [opts.configuredUrl, SAME_ORIGIN] : [SAME_ORIGIN]
}

/** 命中同源哨兵：页面自己那个源就是后端，相对路径直取。 */
function sameOrigin(): Discovered {
  return { httpBase: '', wsBase: '', upstream: '' }
}

/** 命中一个显式配置的上游：HTTP 直取它，WS 换 scheme 直连。 */
function viaUpstream(upstream: string): Discovered {
  return { httpBase: upstream, wsBase: upstream.replace(/^http/, 'ws'), upstream }
}

export async function resolveBackend(opts: {
  configuredUrl?: string
  probe: ProbeFn
}): Promise<Discovered | null> {
  for (const cand of backendCandidates(opts)) {
    if (cand === SAME_ORIGIN) return sameOrigin()
    if (await opts.probe(cand)) return viaUpstream(cand)
  }
  return null
}
