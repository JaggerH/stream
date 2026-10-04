import type { UserStore } from '../store/user-store.ts'
import type { ProviderRecord, ProviderCategory } from '../store/types.ts'
import type { ProviderBindings } from '../providers/bindings.ts'
import type { ProviderDirectory } from '../providers/directory.ts'
import { isParked } from '../providers/parked.ts'

/** 激活过程的旁路记录（窄接口）：decision 路径（decide.ts）失败直接体现在响应 + item detail 上，
 *  不需要它；独立调用方想留痕时注入。字段形状沿用旧 import-problems 台账（kind 固定 activation-conflict）。 */
export interface ActivationProblem {
  at: string
  bundleTitle: string
  bundleAuthor?: string
  revision: string
  kind: 'activation-conflict'
  detail: string
  dep?: string
  status: 'open'
}
export interface ActivationProblemSink { record(p: ActivationProblem): void }

export type ActivationDecision = 'use-imported' | 'keep-mine' | 'append'

export interface ActivationConflict {
  providerId: string
  kind: 'serves-overlap' | 'fallback-overlap' | 'binding-occupied'
  category: ProviderCategory
  overlapKeys?: string[]
  rivalProviderId?: string
  callsiteId?: string
}

export interface ActivateResult {
  status: 'activated' | 'conflict'
  providerId: string
  conflicts: ActivationConflict[]
}

export interface ActivateDeps {
  store: UserStore
  bindings: ProviderBindings
  /** serves 的具名键与「是不是兜底行」从这里取（系统行的身份在代码里，行上的字段可能是陈旧数据）。 */
  directory: Pick<ProviderDirectory, 'serveKeysOf' | 'isFallback'>
  problems?: ActivationProblemSink
  bundleMeta?: { title?: string; author?: string; revision?: string }
}

function candidateCallsite(p: ProviderRecord): string | null {
  const cb = (p.options as { candidateBinding?: { callsiteId?: string } } | undefined)?.candidateBinding
  return cb?.callsiteId ?? null
}

/** §5.1 激活恢复：providerId 激活后，扫全部频道 options.candidateSlots，把「现在全部 id 都可用」
 *  的键搬回 options.slots（id 已在导入时 remap 过，此处不再改写）。只搬「包含 providerId 且键内
 *  全部 id 都存在且非 parked、并通过 validateSelection（callsite 存在 + variant 匹配 + 数量约束）」
 *  的键——键里还有别的 provider 仍 parked/已删 → 该键整体留在 candidateSlots，不半搬（否则会把
 *  一个仍指向 parked 行的键放进 slots，读路径立刻 SlotBrokenError）。校验失败经 problems sink 留痕
 *  （注入方决定落哪；decision 路径失败直接体现在响应里），不静默丢。 */
function restoreCandidateSlots(providerId: string, deps: ActivateDeps): void {
  for (const ch of deps.store.listChannels()) {
    const candidateSlots = (ch.options as { candidateSlots?: Record<string, unknown> } | undefined)?.candidateSlots
    if (!candidateSlots) continue
    let touched = false
    const nextCandidate: Record<string, unknown> = { ...candidateSlots }
    const nextSlots: Record<string, unknown> = { ...((ch.options as { slots?: Record<string, unknown> } | undefined)?.slots ?? {}) }
    for (const [callsiteId, rawIds] of Object.entries(candidateSlots)) {
      if (!Array.isArray(rawIds) || !rawIds.includes(providerId)) continue
      const ids = rawIds as string[]
      const allUsable = ids.every((id) => {
        const p = deps.store.getProvider(id)
        return !!p && !isParked(p)
      })
      if (!allUsable) continue // 键里还有别的行仍 parked/已删 → 留在 candidate，不半搬
      try {
        deps.bindings.validateSelection(callsiteId, ids)
      } catch (e) {
        deps.problems?.record({
          at: new Date().toISOString(),
          bundleTitle: deps.bundleMeta?.title ?? providerId,
          bundleAuthor: deps.bundleMeta?.author,
          revision: deps.bundleMeta?.revision ?? '',
          kind: 'activation-conflict',
          detail: `频道 ${ch.id} 槽位 ${callsiteId} 恢复失败：${(e as Error).message}，已留在 candidateSlots`,
          dep: providerId,
          status: 'open',
        })
        continue
      }
      nextSlots[callsiteId] = ids
      delete nextCandidate[callsiteId]
      touched = true
    }
    if (!touched) continue
    const nextOptions: Record<string, unknown> = { ...ch.options, slots: nextSlots }
    if (Object.keys(nextCandidate).length) nextOptions.candidateSlots = nextCandidate
    else delete nextOptions.candidateSlots
    deps.store.patchChannel(ch.id, { options: nextOptions })
  }
}

/** 激活前的冲突体检，三类：
 *  - `serves-overlap`：同 category 下具名 serves 键重叠；
 *  - `fallback-overlap`：同 category 下双方都是兜底行——具名键集合两边都空，键重叠永远算不出来，
 *    但 `directory.match()` 的兜底档会把两条一起返回、由 `[0]`（id 字典序）决胜，所以导入一条
 *    兜底行会静默改写分发结果。这一类要的就是让它别再静默。
 *  - `binding-occupied`：候选 binding 的目标 callsite 已被活跃行占用。
 *
 *  同一个对手只报一类：具名键已经重叠时，两条都兜底只是同一件事的另一种说法，多报一条纯噪音。 */
export function detectConflicts(
  provider: ProviderRecord,
  store: UserStore,
  bindings: ProviderBindings,
  directory: Pick<ProviderDirectory, 'serveKeysOf' | 'isFallback'>,
): ActivationConflict[] {
  const conflicts: ActivationConflict[] = []
  const mySpecific = directory.serveKeysOf(provider)
  const iAmFallback = directory.isFallback(provider)
  for (const rival of store.listActiveProviders()) {
    if (rival.id === provider.id || rival.category !== provider.category) continue
    const overlap = directory.serveKeysOf(rival).filter((k) => mySpecific.includes(k))
    if (overlap.length) conflicts.push({ providerId: provider.id, kind: 'serves-overlap', category: provider.category, overlapKeys: overlap, rivalProviderId: rival.id })
    else if (iAmFallback && directory.isFallback(rival)) conflicts.push({ providerId: provider.id, kind: 'fallback-overlap', category: provider.category, rivalProviderId: rival.id })
  }
  const callsiteId = candidateCallsite(provider)
  if (callsiteId) {
    // 只有当占用者是**活跃**行时才算抢占（parked 占用者是惰性的，不算冲突）。
    const occupied = (bindings.binding(callsiteId)?.providerIds ?? []).some((id) => {
      const p = store.getProvider(id)
      return p != null && !isParked(p)
    })
    if (occupied) conflicts.push({ providerId: provider.id, kind: 'binding-occupied', category: provider.category, callsiteId })
  }
  return conflicts
}

/** 清 parked（激活）并按需写候选 binding。返回 false = binding 应用失败（未知 callsite/变体不符）→
 *  保持 parked、不半提交。keep-mine 保留本机路由：import 保持 parked，不动 binding、不清 parked。 */
function commit(provider: ProviderRecord, deps: ActivateDeps, decision: ActivationDecision | undefined): boolean {
  if (decision === 'keep-mine') return true // 保留本机：不清 parked（import 保持惰性，不抢 dispatch）
  const callsiteId = candidateCallsite(provider)
  if (callsiteId) {
    // binding 先写（唯一可抛的部分）：未知 callsite / 变体不符 → 保持 parked，不半提交（避免 active 却无 binding）。
    try {
      const existing = deps.bindings.binding(callsiteId)?.providerIds ?? []
      const withoutSelf = existing.filter((id) => id !== provider.id)
      const next = decision === 'append' ? [...withoutSelf, provider.id] : [provider.id, ...withoutSelf] // 默认/ use-imported：导入居首
      deps.bindings.put(callsiteId, next)
    } catch {
      return false
    }
  }
  const nextOptions = { ...(provider.options as Record<string, unknown>) }
  delete (nextOptions as { parked?: unknown }).parked
  delete (nextOptions as { candidateBinding?: unknown }).candidateBinding
  deps.store.patchProvider(provider.id, { options: nextOptions })
  return true
}

function conflictDetail(providerId: string, c: ActivationConflict): string {
  switch (c.kind) {
    case 'serves-overlap':
      return `激活 ${providerId} 与本机 ${c.rivalProviderId} 在 [${(c.overlapKeys ?? []).join(', ')}] 上 serves 重叠，已搁置`
    case 'fallback-overlap':
      return `激活 ${providerId} 与本机 ${c.rivalProviderId} 在 ${c.category} 上都是兜底行，谁接管未命中的键将由 id 序决定，已搁置`
    case 'binding-occupied':
      return `激活 ${providerId} 的 binding 覆盖抢占已占用的 callsite ${c.callsiteId}，已搁置`
  }
}

export function activateProvider(providerId: string, deps: ActivateDeps, decision?: ActivationDecision): ActivateResult {
  const provider = deps.store.getProvider(providerId)
  if (!provider) return { status: 'conflict', providerId, conflicts: [] }
  if (!isParked(provider)) return { status: 'activated', providerId, conflicts: [] } // 幂等：已激活
  const conflicts = detectConflicts(provider, deps.store, deps.bindings, deps.directory)
  if (conflicts.length && !decision) {
    const now = new Date().toISOString()
    for (const c of conflicts) {
      const p: ActivationProblem = {
        at: now,
        bundleTitle: deps.bundleMeta?.title ?? provider.label,
        bundleAuthor: deps.bundleMeta?.author,
        revision: deps.bundleMeta?.revision ?? '',
        kind: 'activation-conflict',
        detail: conflictDetail(provider.id, c),
        dep: provider.id,
        status: 'open',
      }
      deps.problems?.record(p)
    }
    return { status: 'conflict', providerId, conflicts }
  }
  const committed = commit(provider, deps, decision)
  if (!committed) {
    // binding 无法应用（未知 callsite / 变体不符）→ 保持 parked、落台账、不半提交。
    deps.problems?.record({
      at: new Date().toISOString(),
      bundleTitle: deps.bundleMeta?.title ?? provider.label,
      bundleAuthor: deps.bundleMeta?.author,
      revision: deps.bundleMeta?.revision ?? '',
      kind: 'activation-conflict',
      detail: `激活 ${provider.id} 的候选 binding 无法应用（callsite 未知或变体不符），已保持 parked`,
      dep: provider.id,
      status: 'open',
    })
    return { status: 'conflict', providerId, conflicts: [] }
  }
  restoreCandidateSlots(providerId, deps)
  return { status: 'activated', providerId, conflicts: [] }
}
