// src/agent/search/service.ts
import type { SearchRunStore } from './run-store.ts'
import { runSearch, type SearchFlowDeps } from './flow.ts'
import type { DiscoveryDomain } from './domain.ts'
import type { NetdiskHit, RunRecord, SearchTarget, TrajectoryStep } from './types.ts'

/** 按域取值不同的那几个旋钮（见 `SearchAgentService.start` 的 `knobs`）。 */
export type RunKnobs = Partial<Pick<SearchFlowDeps<unknown>, 'earlyStop' | 'maxRounds' | 'maxHubsPerRound'>>

export interface SearchAgentDeps {
  store: SearchRunStore
  /** 默认档（网盘）。`start` 不传 domain 时用它。 */
  flowDeps: SearchFlowDeps<NetdiskHit>
}

/**
 * 这一趟到底摸了多大一片（spec §2.4）。**候选集不可能是全集，所以覆盖范围必须能说出口**——
 * 一份说不出出处的清单不许进支配运算：算出来的「已排除 X」会自信地印在卡上，而真正划算的
 * 那台可能压根没进过候选集。
 *
 * 全部从轨迹里数，不另记一份状态——轨迹本来就是复盘凭据，再存一份就有了两个会漂移的真相。
 */
export interface RunCoverage {
  /** 跑了几轮搜索。 */
  rounds: number
  /** 一共进了几个窝（fetch 步骤的 fetched 之和）。 */
  hubsFetched: number
  /** 名额不够、没开成的窝有几个——**它和 hubsFetched 必须并排出现**：只报"开了 5 个"
   *  读起来跟"一共就 5 个"一模一样，而真相可能是 41 个里只开了 5 个。 */
  hubsSkipped: number
  /** 从窝里抽出来多少条。 */
  extracted: number
  /** `check` 之后还算数的有多少条——**这个才是产出**，抽出量不是。 */
  kept: number
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

export function coverageOf(trajectory: TrajectoryStep[]): RunCoverage {
  const cov: RunCoverage = { rounds: 0, hubsFetched: 0, hubsSkipped: 0, extracted: 0, kept: 0 }
  for (const s of trajectory) {
    if (s.kind === 'search') cov.rounds++
    if (s.kind !== 'fetch') continue
    const o = (s.output ?? {}) as Record<string, unknown>
    cov.hubsFetched += num(o.fetched)
    cov.hubsSkipped += num(o.skipped)
    cov.extracted += num(o.extracted)
    cov.kept += num(o.kept)
  }
  return cov
}

/** Project a run for surfacing (spec §11): keep only topical (≥1) targets, dropping the 无关(0)
 *  noise — the full set stays in the store, so a low-context real link the LLM wrongly scored 0 is
 *  not truly lost (no feedback loop to catch it). `suppressed` = how many 0-score links were hidden.
 *  `coverage` 让回执自带出处（spec §2.4）。 */
export function surfaceRun(
  rec: RunRecord
): Omit<RunRecord, 'targets'> & { targets: SearchTarget[]; suppressed: number; coverage: RunCoverage } {
  const all = rec.targets ?? []
  const kept = all.filter((t) => t.topicality >= 1)
  return { ...rec, targets: kept, suppressed: all.length - kept.length, coverage: coverageOf(rec.trajectory) }
}

/**
 * T3 orchestrator for the Search Agent (mirrors ParseService): a serial queue of runs. Each run
 * executes the code-driven `runSearch` skeleton; every step appends to the run's persisted
 * trajectory (the replay substrate, spec §7.5). start() enqueues + returns immediately; the
 * caller polls get(runId).
 */
export class SearchAgentService {
  private readonly queue: string[] = []
  private running = 0
  /**
   * 每条 run 自己那份「域 + 旋钮」（`start` 传进来的）。**按 run 挂、不按服务挂**：商品档
   * 每次调用带着不同的约束（品类 / 价格区间），域是那批约束的载体，两条枚举 run 的域不是
   * 同一个对象。run 跑完就摘掉，别让它跟着服务活一辈子。
   */
  private readonly perRun = new Map<string, { domain?: DiscoveryDomain<unknown>; knobs?: RunKnobs }>()

  constructor(private readonly deps: SearchAgentDeps) {
    // Orphaned running/queued rows from a previous process can never resume — mark them errored.
    // **一条 UPDATE，别回到「全表拉回来逐行看 status」**：那条路会解析每一行的 result，而 result
    // 这一列在活体上是 GB 级的（见 `failOrphanedRuns` 的头注，2026-09-22 真把后端炸得起不来）。
    deps.store.failOrphanedRuns()
  }

  /**
   * 起一条 run。`domain` 缺省 = 装配时那个网盘档；商品档由 `enumerate_candidates` 现造一个
   * 传进来（它带着这次的约束）。
   *
   * `knobs` 覆盖装配时那几个**按域取值不同**的旋钮。**换域必须把它们一起换掉**：
   * `flowDeps` 是照网盘档配的，`{...flowDeps, domain}` 会把网盘那套参数原样带进商品档。
   * 活体（2026-09-02）真栽过：`earlyStop.topical = 5` 被继承，枚举跑一轮凑够 5 条就
   * `stopped: 'early'` 收工，**73 个窝只开了 5 个**——而"提前收工的清单"正是这个功能
   * 存在的理由要消灭的那个东西。域换了、参数没换，没有一处会报错。
   */
  start<T>(
    goal: string,
    domain?: DiscoveryDomain<T>,
    knobs?: Partial<Pick<SearchFlowDeps<T>, 'earlyStop' | 'maxRounds' | 'maxHubsPerRound'>>
  ): RunRecord {
    // The queued snapshot is the "accepted" response — deterministic even though pump() may flip
    // the live row to 'running' synchronously. Callers poll get(runId) for live status.
    const rec = this.deps.store.create(goal, domain?.name ?? this.deps.flowDeps.domain.name)
    // 这一个 cast 是整条链上唯一的形状放宽：服务不认识候选长什么样（那正是域的职责），
    // 它只负责把域原样交给 runSearch。域自己内部是自洽的强类型。
    if (domain || knobs) {
      this.perRun.set(rec.runId, {
        domain: domain as unknown as DiscoveryDomain<unknown> | undefined,
        knobs: knobs as RunKnobs | undefined,
      })
    }
    this.queue.push(rec.runId)
    this.pump()
    return rec
  }

  get(runId: string): RunRecord | null {
    return this.deps.store.get(runId)
  }

  private pump(): void {
    while (this.running < 1 && this.queue.length) {
      const runId = this.queue.shift()!
      this.running++
      void this.run(runId).finally(() => {
        this.running--
        this.pump()
      })
    }
  }

  private async run(runId: string): Promise<void> {
    const rec = this.deps.store.get(runId)
    if (!rec) return
    this.deps.store.put(runId, { status: 'running' })
    try {
      const per = this.perRun.get(runId)
      const flowDeps = (
        per ? { ...this.deps.flowDeps, ...(per.domain ? { domain: per.domain } : {}), ...per.knobs } : this.deps.flowDeps
      ) as SearchFlowDeps<unknown>
      const outcome = await runSearch(rec.goal, flowDeps, (step) => this.deps.store.appendStep(runId, step))
      this.deps.store.put(runId, {
        status: 'done',
        // 两个域的 kept 都同时带着 fit 和 topicality（各自 check 里加的）；落库共用一格，
        // **靠记录上的 `domain` 才知道该按哪个形状读**。
        targets: outcome.targets as unknown as SearchTarget[],
        hubs: outcome.hubs,
        onboardable: outcome.onboardable,
        stopped: outcome.stopped,
      })
    } catch (e) {
      this.deps.store.put(runId, { status: 'error', error: String((e as Error).message) })
    } finally {
      this.perRun.delete(runId)
    }
  }
}
