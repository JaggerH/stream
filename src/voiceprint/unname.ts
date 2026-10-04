import type { SpeakerRegistryStore } from './store.ts'

export interface RevertedItem {
  itemId: string
  /** 被撤掉的名字字面量（写账那刻的快照，优先于 person.name——中途改过名也撤得干净） */
  from: string
  /** 换回去的标签：原簇号（反向映射恢复成功）或顺延的新匿名号 */
  to: string
  /** 反向映射是否拿回了原簇号 */
  restored: boolean
  timelineSpans: number
}

const CLUSTER_RE = /^SPEAKER_(\d+)$/

/** 从 `enrollFromCluster` 写下的 `source` 反解出 `(itemId, cluster)`。
 *  两种形状：`${itemId}:${cluster}`（手动 enroll）与 `${itemId}:${cluster}:intro`（抽名确认）。
 *  itemId 自身可能带冒号，所以从**右**边拆、并要求簇号形如 SPEAKER_NN——拆不出就是不可恢复。 */
function parseEnrollSource(source: string): { itemId: string; cluster: string } | null {
  let s = source
  if (s.endsWith(':intro')) s = s.slice(0, -':intro'.length)
  const at = s.lastIndexOf(':')
  if (at <= 0) return null
  const cluster = s.slice(at + 1)
  if (!CLUSTER_RE.test(cluster)) return null
  return { itemId: s.slice(0, at), cluster }
}

/** 在 `taken` 之外挑一个确定性的新匿名标签：现存最大簇号 + 1（位宽跟随现存标签，默认两位）。 */
function nextAnonymousLabel(taken: Iterable<string>): string {
  let max = -1
  let width = 2
  for (const label of taken) {
    const m = CLUSTER_RE.exec(label)
    if (!m) continue
    max = Math.max(max, Number(m[1]))
    width = Math.max(width, m[1].length)
  }
  return `SPEAKER_${String(max + 1).padStart(width, '0')}`
}

/**
 * 删一个 person 之前，把他的名字字面量从**所有波及 item** 的 diarization 时间线里改回匿名标签，
 * 并清掉他的出现账。
 *
 * 为什么需要它：enroll 是**就地改写**——`item_diarization.speaker` 直接写成人名。只删库里的
 * person/voiceprints，这些字面量原样留着：库里查无此人，页面上却还挂着他的名字，账也悬空，
 * 只能手动重跑认名才刷得掉。
 *
 * **只撤时间线**：它是说话人数据的唯一存储，转写段上的名字是读时现算的投影（`view.ts`），
 * 时间线改回去投影自然跟上，没有第二份要追着改。
 *
 * **换回什么标签**：先试反向映射——`Voiceprint.source` 记着 `${itemId}:${cluster}`，簇代表还在
 * `item_clusters` 里就能确认这个簇号真属于该 item，于是**还原成原簇号**。恢复不了的（自动认名的
 * item 压根没留声纹来源）、或同 item 有多个簇都认成了这个人（哪段属于哪簇已不可分辨）→ 用现存
 * 最大簇号顺延一个新标签，保证不与该 item 现存任何标签相撞。
 *
 * **边界**：只撤字面量与账。不碰 pending（待确认抽名）、不重跑认名、不删 person 本身
 * （调用方删——本函数只负责让删之后的世界自洽）。
 */
export function revertPersonNaming(
  registry: SpeakerRegistryStore,
  personId: string,
): { items: string[]; reverted: RevertedItem[] } {
  const person = registry.getPerson(personId)
  if (!person) return { items: [], reverted: [] }

  // 名册 = 出现账 ∪ 声纹来源。两边各自不全：自动认名的 item 只在账里（没留声纹），
  // 而 enroll 过但时长不够/没算过账的 item 只在声纹来源里。
  const roster = new Map<string, { label: string; clusters: string[] }>()
  const touch = (itemId: string) => {
    let e = roster.get(itemId)
    if (!e) roster.set(itemId, (e = { label: person.name, clusters: [] }))
    return e
  }
  for (const a of registry.listAppearancesForPersons([personId], 0)) {
    touch(a.itemId).label = a.nameAtTime || person.name
  }
  for (const vp of registry.listVoiceprints(personId)) {
    const parsed = parseEnrollSource(vp.source)
    if (!parsed) continue
    const e = touch(parsed.itemId)
    if (!e.clusters.includes(parsed.cluster)) e.clusters.push(parsed.cluster)
  }

  const reverted: RevertedItem[] = []
  for (const [itemId, { label, clusters }] of roster) {
    const timeline = registry.getItemTimeline(itemId)
    if (!timeline.some((s) => s.speaker === label)) {
      // 这个 item 的时间线上已经没有该名字的字面量了（账悬空/早已重跑过）——没得撤，跳过。
      continue
    }
    const present = new Set<string>([...timeline.map((s) => s.speaker), ...registry.listItemClusterNames(itemId)])
    // 反向映射：恰好一个簇、且它的簇代表还在（确认这个簇号真属于该 item）、且当前没被别的段占用。
    const recoverable = clusters.filter((c) => registry.getItemCluster(itemId, c))
    const restorable = recoverable.length === 1 && !timeline.some((s) => s.speaker === recoverable[0])
    const to = restorable ? recoverable[0] : nextAnonymousLabel(present)

    const timelineSpans = registry.renameInTimeline(itemId, label, to)

    // 按改回匿名后的时间线重算这一条的账——同 item 里**别人**的账因此仍然准确
    // （直接 DELETE 该 person 的行做不到这点，那只是下面的兜底）。
    registry.recomputeItemAppearances(itemId, registry.getItemTimeline(itemId))

    reverted.push({ itemId, from: label, to, restored: restorable, timelineSpans })
  }

  // 兜底：没有时间线的 item 重算不了，账会留着悬空。
  registry.deleteAppearancesForPerson(personId)
  return { items: reverted.map((r) => r.itemId), reverted }
}
