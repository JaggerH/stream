import type { ProviderRecord, StreamRecord } from '../store/types.ts'
import { fillHoles } from '../providers/executor.ts'
import { parseSourceId } from './store.ts'

export interface LadderSnapshotDeps {
  getProvider(id: string): ProviderRecord | null
  /** 展开后的现役成员（auto 段展开、去重、exclude 应用后），$input 未填 —
   *  即 ProviderExecutor.resolvedMembers。name 是寻址键（同源多实例时是实例名），
   *  sourceId 是真源 id——快照成 Stream 成员要拆的是后者。 */
  resolvedMembers(record: ProviderRecord): Array<{ name: string; sourceId?: string; params?: Record<string, unknown> }>
}

/** 旧 standing-subscription 的权威模型替身（ARCHITECTURE.md Data Scheduling / design D2）：
 *  把一个 resolve-variant Provider 行的展开成员**在创建时快照**成 exclusive Stream —— 每个成员的
 *  `$input` 参数洞用 key 填死，产出全绑定 members。快照即静态：行后续演化不传播（invariant 3；
 *  源坏了由 failover + health 兜底）。挂频道走入口规则（裸 Stream 隐式成同名 solo Channel），
 *  或由调用方显式挂到 timeline Channel。 */
export function makeStreamFromProviderLadder(
  deps: LadderSnapshotDeps,
  rowId: string,
  key: string,
  cadence_seconds: number,
  options: Record<string, unknown> = {}
): StreamRecord {
  const record = deps.getProvider(rowId)
  if (!record) throw new Error(`Unknown provider row: ${rowId}`)
  const members = deps.resolvedMembers(record).map(({ name, sourceId, params }) => {
    const { plugin_id, source_template_id } = parseSourceId(sourceId ?? name)
    return { plugin: plugin_id, source: source_template_id, params: fillHoles(params, key) ?? {} }
  })
  if (members.length === 0) throw new Error(`Provider row ${rowId} expands to zero members`)
  const keySlug = key.replace(/[^a-zA-Z0-9_-]+/g, '-')
  return {
    id: `${rowId}-${keySlug}`,
    label: `${record.label} · ${key}`,
    strategy: 'exclusive',
    cadence_seconds,
    members,
    options,
  }
}
