// 裁决器输入：把归档 pending 卡与追更候选打包成给模型看的证据卡（spec 2026-09-03-netdisk-llm-adjudicator §4.1）。
// 只造数据，不问模型、不落账——那是 prompt.ts / gate.ts / service.ts 的事。
import { createHash } from 'node:crypto'
import type { AuthorityEntry, PendingKind } from '../reconcile/plan.ts'
import { seasonEpisodeOfKey, QI_OF } from '../reconcile/plan.ts'
import type { PendingLike } from '../../mcp/reconcile-surface.ts'
import { suspectOf } from '../../mcp/reconcile-surface.ts'

/** 这张卡问的是哪一种事——归档 pending 的三档（spec §2 只挑这三档问模型）+ 追更候选一档。 */
export type CardKind = 'evidence-conflict' | 'duration-collision' | 'no-duration' | 'follow-candidate'

/** 一张卡允许模型作答的候选之一（spec §4.1）。 */
export interface CardCandidate {
  leftKey: string
  title: string
  airDate?: string
  authorityDurationS?: number
  /** 这一集货架上已经有的正主（如果有）——让模型看得出"这份是另一版还是另一集"。 */
  existing?: { path: string; sizeBytes?: number; durationS?: number }
  /**
   * 候选的季号（从 leftKey 抽，抽不出 = 不分季的绑定，如播客）。**只给 `gate.ts` 用**，
   * 校验目录季号与候选季号是否一致；不进 `prompt.ts` 发给模型的那份 JSON（那份只挑 spec §4.1
   * 列出的字段）。
   */
  season?: number
}

export interface Card {
  id: string
  kind: CardKind
  file: { path: string; name: string; sizeBytes?: number; durationS?: number }
  candidates: CardCandidate[]
  reason: string
  /**
   * 文件所在目录判出的季号（`seasonOfDir` 的取值）：`undefined` = 非多季绑定（没有季这回事），
   * `null` = 判不出季——但判不出季的目录本来就不会有 pending 卡进来（`plan.ts`
   * `isSeasonUnresolved`），所以这里出现 `null` 只是"没有可比对的季号"，不代表异常。
   * **同 `CardCandidate.season` 一样只给 gate 用，不进模型 JSON**。
   */
  dirSeason?: number | null
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/** `AuthorityEntry` → 一条候选。`leftKey` 单独传（不是每个 entry 都必然带 `leftKey` 字段本身，
 *  调用方已经用它当 Map 的键找到了这一条，原样带出去，别指望 entry 自己一定重复这份信息）。 */
function candidateOf(entry: AuthorityEntry, leftKey: string): CardCandidate {
  const se = seasonEpisodeOfKey(leftKey)
  return {
    leftKey,
    title: entry.title,
    ...(entry.durationS !== undefined ? { authorityDurationS: entry.durationS } : {}),
    ...(entry.pinnedRight ? { existing: { path: entry.pinnedRight } } : {}),
    ...(se ? { season: se.season } : {}),
  }
}

type AskableKind = 'evidence-conflict' | 'duration-collision' | 'no-duration'
const isAskableKind = (k: PendingKind | undefined): k is AskableKind =>
  k === 'evidence-conflict' || k === 'duration-collision' || k === 'no-duration'

/**
 * 归档 pending 动作 → 待问的卡（不含 `id`，由 `selectCards` 在最终裁到 40 张之后统一编号）。
 *
 * 只挑三档（spec §2）：`evidence-conflict`（`conflictsWith` 给全部相争的 leftKey）、
 * `duration-collision`（`collidesWith` 给撞上的那一集）、`no-duration`（**没有任何 leftKey 信号**——
 * 唯一敢用的收窄是文件名自带的「第N期」，只留标题期号相同的清单条目；文件名没有期号、或收窄后
 * 一个候选都不剩，这张卡本任务就不造，不问模型）。`suspect-dir` 熔断的（`suspectOf` 有值）与 `season-unresolved`/
 * `replace`/`swap-hold` 一概不问：前者是目录级问题，后两者要么不该问模型，要么本来就不在 pending 里
 * （`season-unresolved` 的文件整段不进匹配器、也就不会有以下这些 pendingKind）。
 */
export function cardsFromPending(
  pending: readonly PendingLike[],
  authority: readonly AuthorityEntry[],
  seasonOfDir?: Map<string, number | null>,
): Card[] {
  const byKey = new Map<string, AuthorityEntry>()
  for (const e of authority) if (e.leftKey) byKey.set(e.leftKey, e)

  /** 文本里的「第N期」（找不到 → null）。评审收窄用的唯一判据，与 `plan.ts` 的 `qiConflict` 同一个正则。 */
  const qiOfText = (s: string): number | null => { const m = QI_OF.exec(s); return m ? Number(m[1]) : null }

  const out: Card[] = []
  for (const a of pending) {
    if (suspectOf(a)) continue // 目录级熔断的那些，交给 groupSuspectDirs，不逐条问模型
    const kind = a.pendingKind as PendingKind | undefined
    if (!isAskableKind(kind)) continue

    const dirSeason = seasonOfDir?.get(dirOf(a.src.path))
    let candidates: CardCandidate[]
    if (kind === 'evidence-conflict') {
      candidates = (a.conflictsWith ?? [])
        .map((k) => { const e = byKey.get(k); return e ? candidateOf(e, k) : null })
        .filter((c): c is CardCandidate => c !== null)
    } else if (kind === 'duration-collision') {
      const e = a.collidesWith ? byKey.get(a.collidesWith) : undefined
      candidates = e && a.collidesWith ? [candidateOf(e, a.collidesWith)] : []
    } else {
      // no-duration：没有任何 leftKey 信号（没有 conflictsWith/collidesWith）。唯一敢用的收窄是
      // 文件名自带的「第N期」——只留标题期号相同的清单条目（可以跨季，season 由 gate.ts 的
      // 季一致性检查二次把关）。文件名没有期号、或收窄后一个候选都不剩，说明这张卡答不出任何
      // 东西：v1 不造它（不问模型，下一轮续探），而不是造一张模型只能瞎猜的空卡。
      const want = qiOfText(baseName(a.src.path))
      if (want == null) continue
      candidates = authority
        .filter((e) => e.leftKey && qiOfText(e.title) === want)
        .map((e) => candidateOf(e, e.leftKey!))
      if (candidates.length === 0) continue
    }

    out.push({
      id: '',
      kind,
      file: {
        path: a.src.path,
        name: baseName(a.src.path),
        ...(a.src.size !== undefined ? { sizeBytes: a.src.size } : {}),
        ...(a.src.durationS !== undefined ? { durationS: a.src.durationS } : {}),
      },
      candidates,
      reason: a.reason ?? '',
      ...(dirSeason !== undefined ? { dirSeason } : {}),
    })
  }
  return out
}

/** 一条追更候选的输入（由服务层从 `matchExternalFiles` 的 `pending` assignment 汇总而来，
 *  见计划 Task B）——一份分享内文件，可能满足这几个缺集（leftKey 列表）。 */
export interface FollowCandidateInput {
  file: { path: string; name: string; sizeBytes?: number; durationS?: number }
  candidateLeftKeys: readonly string[]
}

/** 追更候选 → 待问的卡（同样不含 `id`）。`file.path` 是分享内相对路径（spec §4.1）。 */
export function cardsFromFollowCandidates(
  inputs: readonly FollowCandidateInput[],
  authority: readonly AuthorityEntry[],
): Card[] {
  const byKey = new Map<string, AuthorityEntry>()
  for (const e of authority) if (e.leftKey) byKey.set(e.leftKey, e)

  return inputs.map((c) => ({
    id: '',
    kind: 'follow-candidate' as const,
    file: c.file,
    candidates: c.candidateLeftKeys
      .map((k) => { const e = byKey.get(k); return e ? candidateOf(e, k) : null })
      .filter((x): x is CardCandidate => x !== null),
    reason: '追更分享里的文件，匹配器判成 pending 的候选缺集——需要确认它到底补的是哪一集',
  }))
}

/**
 * 这批卡的指纹（spec §3 节流）：每张卡的 `path + pendingKind/kind + 候选 leftKey 列表排序`，
 * 整批排序后 sha256 取前 16 位。**不含 `id`**——id 只是序号，卡片内容没变时序号可能因为别的卡
 * 增减而漂移，把它算进指纹会让"内容其实没变"被误判成"变了"。
 */
export function cardsHash(cards: readonly Card[]): string {
  const fingerprint = cards
    .map((c) => `${c.file.path}|${c.kind}|${[...c.candidates.map((x) => x.leftKey)].sort().join(',')}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
}

const KIND_PRIORITY: Record<CardKind, number> = {
  'evidence-conflict': 0,
  'duration-collision': 1,
  'no-duration': 2,
  'follow-candidate': 3,
}

/**
 * 裁到一次调用的上限（spec §3：最多 40 张、超出的按 `pendingKind` 优先级取，同类按路径排序），
 * 并在这里统一分配 `id`（从 "1" 起的序号字符串）——只有真正要发给模型的这批卡才需要稳定编号，
 * 编号在 `selectCards` 之前的阶段（`cardsFromPending`/`cardsFromFollowCandidates`）没有意义。
 */
export function selectCards(cards: readonly Card[], max = 40): Card[] {
  const sorted = [...cards].sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.file.path.localeCompare(b.file.path),
  )
  return sorted.slice(0, max).map((c, i) => ({ ...c, id: String(i + 1) }))
}
