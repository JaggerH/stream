import type { HealthState, SourceHealth } from '../source-health-store.ts'

export interface DoctorRow {
  sourceId: string
  state: HealthState
  /** human reason for a non-healthy state (e.g. "empty ×4", "error ×2 [blocked] (HTTP 412)") */
  reason: string
  /** full stack of the most recent error, for `doctor --trace` */
  trace?: string
  /** set when the source needs a cookie domain that the credential provider can't resolve */
  missingCredential?: string
}

export interface DoctorInput {
  snapshot: Record<string, SourceHealth>
  /** the source's declared auth (from its manifest) */
  authOf: (sourceId: string) => { type: string; domain?: string } | undefined
  /** cookie domains the credential provider can currently resolve */
  availableDomains: string[]
}

function domainResolved(domain: string, available: string[]): boolean {
  // The broker matches by domain suffix; accept either direction so a stored
  // ".xueqiu.com" or "xueqiu.com" both satisfy a "xueqiu.com" requirement.
  return available.some((d) => d === domain || d.endsWith(domain) || domain.endsWith(d))
}

/**
 * Pure projection of the health ledger into doctor rows (no I/O). Joins each source's
 * health with its declared cookie domain to prescribe missing credentials. Sorted by id.
 */
export function buildDoctorReport(input: DoctorInput): DoctorRow[] {
  return Object.entries(input.snapshot)
    .map(([sourceId, h]): DoctorRow => {
      const reason =
        h.state === 'healthy'
          ? ''
          : h.lastOutcome === 'error'
            ? `error ×${h.consecutiveError} [${h.lastErrorCategory ?? 'unknown'}]${h.lastError ? ` (${h.lastError})` : ''}`
            : `empty ×${h.consecutiveEmpty}`
      const auth = input.authOf(sourceId)
      let missingCredential: string | undefined
      if (auth?.type === 'cookie' && auth.domain && !domainResolved(auth.domain, input.availableDomains)) {
        missingCredential = `cookie for ${auth.domain} not configured — log in to ${auth.domain} in your browser`
      }
      return { sourceId, state: h.state, reason, trace: h.lastErrorStack, missingCredential }
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
}
