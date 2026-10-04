import type { ProviderRecord } from '../store/types.ts'

/** One resource-search member as a physical fetch: which source (or Provider) to call, and the
 *  stored params to call it with. The live keyword is injected per-source at call time.
 *
 *  This used to be `PlanGroup` from the Flow/Binding planner. That whole model was cut out of the
 *  running app in 6e6962a1 (2026-06-30) — nothing plans flows any more; resource-search members
 *  ARE the groups. The `flows: []` field every construction site had to pass was the last trace. */
export interface SearchGroup {
  source_id: string
  physicalParams: Record<string, unknown>
  /** this member is a Provider (`{provider}`), invoked via the executor rather than readSource */
  provider?: boolean
}

/** The two collaborators the fan-out plan needs: the Provider row store and the executor's member
 *  expansion. Narrowed to these two methods so the unit test can drive the real store + real
 *  executor without booting the app. */
export interface SearchGroupsDeps {
  getProvider(id: string): ProviderRecord | null
  resolvedMembers(record: ProviderRecord): Array<{
    sourceId: string
    params?: Record<string, unknown>
    kind: 'source' | 'provider'
  }>
}

/** A search Provider row's live members as planner groups — the single source of truth for which
 *  sources search (row expansion, deduped, exclude-applied). The streaming path fans out over the
 *  SAME members the executor's concurrent invoke uses; each member's $input hole is stripped
 *  because searchOneGroup injects the live keyword itself. The row defaults to the global
 *  `resource-search`, but a channel slot override for `search.resources` resolves to another row
 *  id — that's how the in-place chip actually changes the streamed results, so `providerId` MUST
 *  stay wired through from the caller (a no-arg call silently pins every channel to the global row
 *  while every other layer still reports the override; see search-groups.test.ts). */
export function resourceSearchGroups(deps: SearchGroupsDeps, providerId = 'resource-search'): SearchGroup[] {
  const row = deps.getProvider(providerId)
  if (!row) return []
  return deps.resolvedMembers(row).map(({ sourceId, params, kind }) => ({
    // 流式扇出按**真源 id** 读源（同源多实例的实例名不是源 id）；{provider} 成员的 sourceId = 子行 id。
    source_id: sourceId,
    provider: kind === 'provider', // {provider} 成员走 executor.invoke,不是 scheduler.readSource
    physicalParams: Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== '$input')),
  }))
}
