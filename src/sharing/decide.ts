import type { UserStore } from '../store/user-store.ts'
import type { ProviderBindings } from '../providers/bindings.ts'
import { isParked } from '../providers/parked.ts'
import { activateProvider, type ActivateDeps, type ActivationDecision, type ActivationConflict } from './activate-provider.ts'
import type { ImportRunStore, ImportItem } from './import-run-store.ts'

export interface DecideDeps {
  runs: ImportRunStore
  store: UserStore
  bindings: ProviderBindings
  /** 激活体检要的 serves 具名键从它取（转交 activateProvider）。 */
  directory: ActivateDeps['directory']
}

/** decision 是 item 唯一的状态迁移入口（spec §2）。失败不半提交：item 保持 open，
 *  原因写回 detail——调用方（UI/AI）当场就在上下文里，不再落异步台账。 */
export type DecideResult =
  | { ok: true; item: ImportItem }
  | { ok: false; code: 'not_found' | 'invalid_choice' | 'already_decided' | 'apply_failed'; message: string; item?: ImportItem; conflicts?: ActivationConflict[] }

export function decideImportItem(runId: string, itemId: string, choice: string, deps: DecideDeps): DecideResult {
  const run = deps.runs.get(runId)
  const item = run?.items.find((i) => i.id === itemId)
  if (!run || !item) return { ok: false, code: 'not_found', message: `未找到导入 ${runId} 的条目 ${itemId}` }
  if (item.status !== 'open') return { ok: false, code: 'already_decided', message: `条目已拍板（${item.status}: ${item.choice}）`, item }
  if (!item.choices.includes(choice)) return { ok: false, code: 'invalid_choice', message: `choice 必须是 ${item.choices.join(' | ')}`, item }

  const settle = (status: 'decided' | 'dismissed'): DecideResult => {
    const patched = deps.runs.patchItem(runId, itemId, { status, choice, decidedAt: new Date().toISOString() })!
    return { ok: true, item: patched }
  }
  const fail = (message: string, conflicts?: ActivationConflict[]): DecideResult => {
    const patched = deps.runs.patchItem(runId, itemId, { detail: `${item.detail}；上次执行失败：${message}` })
    return { ok: false, code: 'apply_failed', message, item: patched, ...(conflicts?.length ? { conflicts } : {}) }
  }

  if (choice === 'dismiss') return settle('dismissed') // 全 kind 通用：先不管，什么都不动

  switch (item.kind) {
    case 'notice':
      return settle('decided') // choices 只有 dismiss，结构上到不了；防御
    case 'parked-provider': {
      const providerId = (item.subject as { providerId?: string }).providerId ?? ''
      if (!deps.store.getProvider(providerId)) return fail(`Provider ${providerId} 已不存在`)
      // choice 与 ActivationDecision 一一对应；激活逻辑原封不动（含 candidateSlots 恢复）。
      const r = activateProvider(providerId, { store: deps.store, bindings: deps.bindings, directory: deps.directory, bundleMeta: run.meta }, choice as ActivationDecision)
      if (r.status !== 'activated') {
        return fail(r.conflicts.length ? `激活冲突：${r.conflicts.map((c) => c.kind).join(', ')}` : '候选 binding 无法应用（callsite 未知或变体不符）', r.conflicts)
      }
      return settle('decided')
    }
    // 用户从候选全名里挑了一个 → 把这条流里所有还写着那个裸名的成员改写成它。
    // 按**当前库值**改（不是按台账里的快照）：这一条可能是几天后才拍的板，中间流可能已经被动过。
    case 'source-ambiguous': {
      const { streamId, source } = item.subject as { streamId?: string; source?: string }
      const stream = streamId ? deps.store.getStream(streamId) : null
      if (!stream || !source) return fail(`流 ${streamId ?? '(未知)'} 已不存在`)
      const members = stream.members.map((m) => (m.source === source ? { ...m, source: choice } : m))
      if (members.every((m, i) => m.source === stream.members[i].source)) {
        return fail(`流 ${streamId} 里已经没有引用 \`${source}\` 的成员了（可能已被改过）`)
      }
      deps.store.putStream({ ...stream, members })
      return settle('decided')
    }
    case 'slot-conflict': {
      if (choice === 'keep-mine') return settle('decided') // 本机本就生效，纯状态迁移
      // use-imported：包内那份从 item.theirs 取（run 是唯一存储），以 store 现值校验。
      const { channelId, callsiteId } = item.subject as { channelId?: string; callsiteId?: string }
      const theirIds = (item.theirs as { providerIds?: string[] } | undefined)?.providerIds ?? []
      const channel = channelId ? deps.store.getChannel(channelId) : null
      if (!channel || !callsiteId || !theirIds.length) return fail('频道或槽位信息已失效')
      const rows = theirIds.map((id) => deps.store.getProvider(id))
      if (rows.some((p) => !p)) return fail(`引用的 Provider 已消失：${theirIds.filter((id) => !deps.store.getProvider(id)).join(', ')}`)
      const hasParked = rows.some((p) => p && isParked(p))
      if (!hasParked) {
        // 直接生效前过与手工填槽同一条校验（fixed/dispatch 数量、去重、variant）。
        try {
          deps.bindings.validateSelection(callsiteId, theirIds)
        } catch (e) {
          return fail((e as Error).message)
        }
      }
      const opts = { ...(channel.options as Record<string, unknown>) }
      const slots = { ...((opts.slots as Record<string, unknown> | undefined) ?? {}) }
      const candidate = { ...((opts.candidateSlots as Record<string, unknown> | undefined) ?? {}) }
      if (hasParked) {
        // 含 parked 行：不能直接进 slots（读路径立刻 SlotBrokenError）——落 candidateSlots，
        // 激活时 restoreCandidateSlots 搬回并覆盖本机 slots 键（本机继续生效到那一刻）。
        candidate[callsiteId] = theirIds
      } else {
        slots[callsiteId] = theirIds
        delete candidate[callsiteId] // 本机若占的是 candidateSlots 键，移除——防激活时盖掉已拍板结果
      }
      if (Object.keys(slots).length) opts.slots = slots; else delete opts.slots
      if (Object.keys(candidate).length) opts.candidateSlots = candidate; else delete opts.candidateSlots
      deps.store.patchChannel(channel.id, { options: opts })
      return settle('decided')
    }
  }
}
