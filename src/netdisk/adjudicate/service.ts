// 轮末裁决器主体（spec 2026-09-03-netdisk-llm-adjudicator）：把归档 pending 卡与追更候选打包问
// 一次模型，结论过 `gate.ts` 的代码闸后落决策账本；归档卡过闸的再跑一次归档，追更候选过闸的
// 直接转存（复用 `follow` 的分享客户端）。**模型不删文件**——这里只写 `is-episode`/`not-episode`，
// 从不直接调删除；删除仍只走 `ReconcileService.executeBinding` 现有的代码闸。
import { randomUUID } from 'node:crypto'
import type { MappingStore } from '../mapping-store.ts'
import type { MappingSet } from '../types.ts'
import type { ReconcileService } from '../reconcile/service.ts'
import type { SuggestionLog, SuggestionVerdict } from '../reconcile/suggestions.ts'
import type { EventInput } from '../../events/store.ts'
import type { PendingLike } from '../../mcp/reconcile-surface.ts'
import type { AuthorityEntry } from '../reconcile/plan.ts'
import { cardsFromPending, cardsFromFollowCandidates, cardsHash, selectCards, type Card } from './cards.ts'
import { buildMessages, parseDecisions, type AdjudicateMessage, type Decision } from './prompt.ts'
import { admitDecision } from './gate.ts'
import type { FollowCandidate } from '../follow/types.ts'
import { landingPathOf } from '../follow/service.ts'

/** 一次结构化调用：system+user 消息进，模型原文回执出（`null` = 没配置 LLM / 调用失败——不是
 *  拿不准，是压根没问到）。解析是 `prompt.ts` 的 `parseDecisions` 的事，这里不碰。 */
export type InvokeAdjudicateLlm = (messages: readonly AdjudicateMessage[]) => Promise<string | null>

/** 节流窗口（spec §3）：卡片集合指纹相同、且距上次问过不足这么久 → 不再问，防止每小时的追更轮
 *  重复烧钱问同一批卡。 */
const THROTTLE_MS = 7 * 24 * 3600 * 1000
/** 一次最多问几张卡、一次模型调用（spec §3）。 */
const MAX_CARDS = 40

export interface AdjudicationRun {
  runId: string
  /** 跳过：`same cards` = 节流命中；`no cards` = 这一轮压根没有待问的卡（归档卡 + 追更候选都是空的）。
   *  跳过时 `asked`/`applied`/`rejected`/`unsure` 恒为 0，不算一次真的裁决——不通知、不占审计行。 */
  skipped?: 'same cards' | 'no cards'
  asked: number
  applied: number
  rejected: number
  unsure: number
  /** 整批作废：`no llm`（`invokeLlm` 未配置或调用失败）/ `unparseable`（回执不是合法 JSON）。 */
  failed?: string
}

export interface AdjudicationRunOpts {
  trigger: 'follow' | 'manual'
  /** 归档卡过闸后重新归档时，`executeBinding` 的确认档开关（追更轮传 true，手动入口按调用方拍板）。 */
  losers: boolean
  /** 本轮判成 pending 的追更候选（`matchExternalFiles` 的产物）——只有从追更轮触发才有；
   *  手动入口（HTTP/MCP）不传，那一路只裁归档待定卡。 */
  followCandidates?: readonly FollowCandidate[]
  /** 越过节流（同一批卡 7 天内不再问）。只给手动入口用——人说「现在就裁」就是现在；追更轮不传。 */
  force?: boolean
}

export interface AdjudicationServiceDeps {
  reconcile: Pick<ReconcileService, 'previewBinding' | 'authorityForBinding' | 'setIsEpisode' | 'setNotEpisode' | 'executeBinding' | 'revokeAdjudication'>
  store: MappingStore
  suggestions: SuggestionLog
  invokeLlm: InvokeAdjudicateLlm
  /**
   * 追更候选过闸后的转存（宿主派发，与 `FollowDeps.shares` 同一份分享客户端——**只取 `save` 这一支**，
   * 结构类型，别 import 整个 `ShareClient`）。缺席 = 追更候选这一路整段跳过转存（归档待定卡照常裁），
   * 手动入口没有追更上下文时不传。
   */
  shares?: {
    save: (
      netdisk: string, pwdId: string,
      opts: { files: Array<{ fid: string; token: string; pdirFid?: string }>; subdir: string; passcode?: string },
    ) => Promise<{ saved: boolean; stage: string; message: string }>
  }
  events?: { append: (e: EventInput) => unknown }
  now?: () => Date
  log: (m: string) => void
}

const newRunId = (): string => `adj_${randomUUID().slice(0, 8)}`

export class AdjudicationService {
  private readonly now: () => Date
  constructor(private readonly deps: AdjudicationServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** 按 note 前缀（`llm:<runId>`）整批撤回这一轮模型裁的决定（spec §6）——只撤"这一份是/不是那一集"
   *  这条决定，不碰追更候选是否已经转存/落地：文件已经在货架上了，撤销只是让它重新回到待认领状态,
   *  下一轮同步会把它判回 missing/pending。 */
  async revoke(runId: string): Promise<number> {
    return this.deps.reconcile.revokeAdjudication(runId)
  }

  async run(setId: string, opts: AdjudicationRunOpts): Promise<AdjudicationRun> {
    const runId = newRunId()
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`unknown binding: ${setId}`)

    // —— 1. 造卡（spec §4.1）：归档 pending 卡（只挑 evidence-conflict/duration-collision/no-duration
    //    三档，`cardsFromPending` 自己会把 suspect-dir 熔断的与其余种类挡在外面）+ 追更候选卡。
    const preview = await this.deps.reconcile.previewBinding(setId)
    const pending = preview.plan.filter((a) => a.kind === 'pending') as unknown as PendingLike[]
    const authority = (await this.deps.reconcile.authorityForBinding(setId)).entries as AuthorityEntry[]
    // `seasonOfDir` 必须带过去：季一致性闸（spec §5 第 4 条）把"目录没判出季"读成"没有季这回事"直接放行，
    // 不递就等于整条闸对所有卡关着——而且没有任何一处会喊。
    const seasonOfDir = preview.seasonOfDir ? new Map(Object.entries(preview.seasonOfDir)) : undefined
    const archiveCards = cardsFromPending(pending, authority, seasonOfDir)
    const followCards = opts.followCandidates?.length ? cardsFromFollowCandidates(opts.followCandidates, authority) : []
    const allCards = [...archiveCards, ...followCards]
    if (allCards.length === 0) return { runId, skipped: 'no cards', asked: 0, applied: 0, rejected: 0, unsure: 0 }
    const cards = selectCards(allCards, MAX_CARDS)

    // —— 2. 节流（spec §3）：指纹与上次相同、距上次不足 7 天 → 不问。跳过不落 `adjudication`——
    //    下一轮卡集合真的变了，判据要看到的是"上一次真的问过的那份"，不是这次白跳过的这份。
    const hash = cardsHash(cards)
    const last = set.adjudication
    if (!opts.force && last && last.lastCardsHash === hash) {
      const age = this.now().getTime() - Date.parse(last.lastAt)
      if (Number.isFinite(age) && age < THROTTLE_MS) return { runId, skipped: 'same cards', asked: 0, applied: 0, rejected: 0, unsure: 0 }
    }
    // 节流状态先落：问过就是问过（哪怕接下来调用失败/解析不出），否则一次失败的调用会让下一轮立刻
    // 重问同一批卡——节流形同虚设。
    this.deps.store.save({ ...set, adjudication: { lastCardsHash: hash, lastAt: this.now().toISOString(), lastRunId: runId } })

    // —— 3. 调模型（spec §4.2）
    const content = await this.deps.invokeLlm(buildMessages(cards))
    if (content == null) return this.finish(set, { runId, asked: cards.length, applied: 0, rejected: 0, unsure: 0, failed: 'no llm' })
    const decisions = parseDecisions(content)
    if (!decisions) return this.finish(set, { runId, asked: cards.length, applied: 0, rejected: 0, unsure: 0, failed: 'unparseable' })

    // —— 4. 过闸 + 落账（spec §5/§6）
    const cardById = new Map(cards.map((c) => [c.id, c]))
    let applied = 0, rejected = 0, unsure = 0
    let archiveApplied = false
    for (const d of decisions) {
      const card = cardById.get(d.id)
      // id 对不上这次发出去的任何卡——模型编了一个 candidates 里没有的编号，丢弃、不落账。
      if (!card) continue
      if (d.verdict === 'unsure') { unsure++; this.recordSuggestion(card, 'unsure', d); continue }
      const gate = admitDecision(card, d)
      const suggestionVerdict: SuggestionVerdict = d.verdict === 'is-episode' ? 'is-episode' : 'none-of-these'
      if (!gate.ok) { rejected++; this.recordSuggestion(card, suggestionVerdict, d); continue }
      const note = `llm:${runId}`
      if (card.kind === 'follow-candidate') {
        // `not-episode` 对追更候选没有可持久化的落点——它键的是分享内相对路径，不是任何一份已经
        // 落在用户网盘上的文件，reconcile 的决定账本从不会按这个键去查它。只留审计行，不计入
        // applied/rejected（它既没被采纳、也没被闸拒收——是"这个动词对这类卡没有意义"）。
        if (d.verdict !== 'is-episode') { this.recordSuggestion(card, suggestionVerdict, d); continue }
        const ok = await this.applyFollowCandidate(set, card, d, note, opts)
        this.recordSuggestion(card, suggestionVerdict, d)
        if (ok) applied++; else rejected++
        continue
      }
      if (d.verdict === 'is-episode') this.deps.reconcile.setIsEpisode(d.leftKey!, card.file.path, true, note)
      // 「都不是」（不带 leftKey）= 对卡上每个候选各落一条；带 leftKey 只否定那一集。
      else for (const k of d.leftKey ? [d.leftKey] : card.candidates.map((c) => c.leftKey)) this.deps.reconcile.setNotEpisode(k, card.file.path, true, note)
      applied++
      archiveApplied = true
      this.recordSuggestion(card, suggestionVerdict, d)
    }

    // —— 5. 裁完之后（spec §7）：归档卡有任何一条过闸 → 立刻再跑一次归档（`losers`/`gated` 跟随
    //    触发它的那一轮——追更轮无人值守必须过健康闸，手动入口按调用方给的 `losers` 拍板）。
    if (archiveApplied) {
      try { await this.deps.reconcile.executeBinding(setId, { losers: opts.losers, gated: opts.trigger === 'follow' }) }
      catch (e) { this.deps.log(`[adjudicate] ${setId} 裁完之后重新归档失败：${(e as Error).message}`) }
    }

    return this.finish(set, { runId, asked: cards.length, applied, rejected, unsure })
  }

  /** 追更候选过闸后：转存那个文件（复用追更的分享客户端），成功后对**落地路径**（不是分享内路径）
   *  写 `is-episode`（spec §6）。没有 `shares` 依赖、或找不到这张卡对应的候选原始数据（理论上不该
   *  发生——卡就是从它造出来的）、或转存本身失败 → 不落账，返回 false（算作被拒收）。 */
  private async applyFollowCandidate(
    set: MappingSet, card: Card, d: Decision, note: string, opts: AdjudicationRunOpts,
  ): Promise<boolean> {
    if (!this.deps.shares) return false
    const cand = opts.followCandidates?.find((c) => c.file.path === card.file.path)
    if (!cand) return false
    const r = await this.deps.shares.save(cand.netdisk, cand.pwdId, {
      files: [{ fid: cand.file.fid, token: cand.file.token, pdirFid: cand.file.pdirFid }],
      subdir: cand.subdir,
      ...(cand.passcode ? { passcode: cand.passcode } : {}),
    })
    if (!r.saved) { this.deps.log(`[adjudicate] ${set.id} 追更候选转存失败 [${r.stage}]: ${r.message}`); return false }
    const landingPath = landingPathOf(set.right.path, cand.subdir, cand.file.path)
    this.deps.reconcile.setIsEpisode(d.leftKey!, landingPath, true, note)
    return true
  }

  private recordSuggestion(card: Card, verdict: SuggestionVerdict, d: Decision): void {
    this.deps.suggestions.record({
      path: card.file.path, verdict, ...(d.leftKey ? { leftKey: d.leftKey } : {}),
      quotes: card.candidates.length, candidates: card.candidates.map((c) => c.leftKey),
    })
  }

  /** 跳过（`skipped`）不经过这里——那不是一次真的裁决，不通知、不占审计行（见 `run` 的两处 skip 早退）。 */
  private finish(set: MappingSet, res: AdjudicationRun): AdjudicationRun {
    if (this.deps.events) {
      const body = res.failed
        ? `模型没给出结论：${res.failed}`
        : `裁了 ${res.asked} 张卡，采纳 ${res.applied}、拒收 ${res.rejected}、拿不准 ${res.unsure}`
      this.deps.events.append({
        type: 'netdisk.adjudicate', severity: res.failed ? 'warn' : 'info',
        title: `《${set.left.title}》轮末裁决`, body, dedupeKey: `netdisk-adjudicate:${set.id}:${res.runId}`,
      } as EventInput)
    }
    return res
  }
}
