// src/intent/service.ts
import { IntentStore } from './store.ts'
import type { IntentLlm } from './llm.ts'
import { runDigestRound, type DigestDeps } from './digest.ts'
import { runRecruit, type RecruitDeps, type RecruitOutcome } from './recruit.ts'
import type { IntentRecord, DigestOutcome } from './types.ts'

// 退避（phase2 spec §3）：30min 起指数翻倍，封顶 4h
const BACKOFF_BASE_MS = 30 * 60_000
const BACKOFF_CAP_MS = 4 * 3600_000

export interface IntentServiceDeps {
  store: IntentStore
  llm: IntentLlm
  digestDeps: Omit<DigestDeps, 'store' | 'llm'>
  /** 注册表内招源 + retire 回退的动作面（bootstrap 接线）。absent → recruit 报未配置。 */
  recruit?: {
    search: RecruitDeps['search']
    preview: RecruitDeps['preview']
    findExisting: RecruitDeps['findExisting']
    subscribe: RecruitDeps['subscribe']
    ensureChannel: RecruitDeps['ensureChannel']
    unsubscribe: (streamId: string) => void
    removeChannel: (channelId: string) => void
  }
}

/** 意图跟踪的服务面。消化单槽串行（照 SearchAgentService 的队列模式）：
 *  digestNow 排队执行，scanDue 逐个 await——LLM 端点同一时刻只有一轮消化在打。 */
export class IntentService {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: IntentServiceDeps) {}

  async create(input: { goal: string; streamIds?: string[] }): Promise<IntentRecord> {
    const parsed = await this.deps.llm.parseIntent(input.goal) // LLM 不可用 → throw，意图不立（spec）
    return this.deps.store.create({
      goal: input.goal,
      criteria: parsed.criteria,
      ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      streamIds: input.streamIds ?? [],
    })
  }

  private withCount(rec: IntentRecord): IntentRecord & { ledgerCount: number } {
    return { ...rec, ledgerCount: this.deps.store.ledgerCount(rec.id) }
  }

  list(): Array<IntentRecord & { ledgerCount: number }> {
    return this.deps.store.list().map((r) => this.withCount(r))
  }

  get(id: string): (IntentRecord & { ledgerCount: number }) | null {
    const rec = this.deps.store.get(id)
    return rec ? this.withCount(rec) : null
  }

  dossier(id: string): string | null {
    return this.deps.store.get(id) ? this.deps.store.dossier(id) : null
  }

  async recruit(id: string): Promise<RecruitOutcome> {
    const rec = this.deps.store.get(id)
    if (!rec) throw new Error('意图不存在')
    if (rec.status === 'retired') throw new Error('意图已退休')
    const r = this.deps.recruit
    if (!r) throw new Error('recruit 未配置')
    return runRecruit(id, {
      store: this.deps.store,
      llm: this.deps.llm,
      search: r.search,
      preview: r.preview,
      findExisting: r.findExisting,
      subscribe: r.subscribe,
      ensureChannel: r.ensureChannel,
      events: this.deps.digestDeps.events,
      log: this.deps.digestDeps.log,
    })
  }

  digestNow(id: string): Promise<DigestOutcome> {
    const rec = this.deps.store.get(id)
    if (!rec) return Promise.reject(new Error('意图不存在'))
    const job = this.chain.then(async () => {
      try {
        const outcome = await runDigestRound(rec, { ...this.deps.digestDeps, store: this.deps.store, llm: this.deps.llm })
        this.recordBackoff(id, outcome)
        return outcome
      } catch (e) {
        // 整轮 throw（如 mergeDossier 端点整体不可用）也要计失败轮退避——不然只有"判过但全错"
        // 那条路径退避，端点直接连不上这种更彻底的失败反而不退避，scanDue 会一直空转重打。
        this.bumpFailStreak(rec.id)
        this.deps.digestDeps.events?.append({
          type: 'intent.digest.error',
          title: `「${rec.goal.slice(0, 20)}」消化失败`,
          body: (e as Error).message,
          severity: 'error',
          dedupeKey: `intent:${rec.id}:error`,
        })
        throw e
      }
    })
    this.chain = job.catch(() => {}) // 队列不因单轮失败断掉
    return job
  }

  /** 失败退避记账（phase2 spec §3）：全军覆没算失败轮，出现成功判定清零，空轮不动。 */
  private recordBackoff(id: string, outcome: DigestOutcome): void {
    const rec = this.deps.store.get(id)
    if (!rec) return
    if (outcome.judged > 0 && outcome.errors === outcome.judged) {
      this.bumpFailStreak(id)
    } else if (outcome.judged > outcome.errors) {
      if (rec.digestFailStreak || rec.digestBackoffUntil) {
        this.deps.store.put(id, { digestFailStreak: 0, digestBackoffUntil: 0 })
      }
    }
  }

  /** 失败轮计数 + 退避时限推进，两条路径共用（判过但全错 / 整轮 throw）。 */
  private bumpFailStreak(id: string): void {
    const rec = this.deps.store.get(id)
    if (!rec) return
    const streak = (rec.digestFailStreak ?? 0) + 1
    this.deps.store.put(id, {
      digestFailStreak: streak,
      digestBackoffUntil: Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (streak - 1), BACKOFF_CAP_MS),
    })
  }

  /** 退休 + 回退（phase2 spec §1）：下线招源创建的流、删意图频道；清理失败只记 log 不回滚。 */
  retire(id: string): IntentRecord | null {
    const rec = this.deps.store.put(id, { status: 'retired' })
    if (!rec) return null
    const r = this.deps.recruit
    if (r) {
      for (const sid of rec.recruitedStreamIds ?? []) {
        try {
          r.unsubscribe(sid)
        } catch (e) {
          this.deps.digestDeps.log?.(`[intent] retire unsubscribe ${sid} 失败: ${(e as Error).message}`)
        }
      }
      if (rec.channelId) {
        try {
          r.removeChannel(rec.channelId)
        } catch (e) {
          this.deps.digestDeps.log?.(`[intent] retire 删频道 ${rec.channelId} 失败: ${(e as Error).message}`)
        }
      }
      // 回退动作已发出（unsubscribe/removeChannel 尝试过，失败只记 log 不回滚）——记录跟着清空，
      // 不留死 id：万一意图被重新招源（目前无此路径，但别给将来埋一个"看着还挂着"的假象）。
      if (rec.recruitedStreamIds?.length || rec.channelId) {
        this.deps.store.put(id, { recruitedStreamIds: [], channelId: undefined })
      }
    }
    return this.deps.store.get(id)
  }

  /** 调度入口：active 且到期（或从未消化）、退避未到期的逐个跑，单个失败不打断其余。 */
  async scanDue(): Promise<string[]> {
    const now = Date.now()
    const due = this.deps.store.list().filter(
      (r) =>
        r.status === 'active' &&
        (!r.digestBackoffUntil || r.digestBackoffUntil <= now) &&
        (!r.lastDigestAt || r.lastDigestAt + r.cadenceHours * 3600_000 <= now)
    )
    const ran: string[] = []
    for (const r of due) {
      try {
        await this.digestNow(r.id)
        ran.push(r.id)
      } catch {
        /* 已发事件，继续下一个 */
      }
    }
    return ran
  }
}
