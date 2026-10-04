// src/agent/search/types.ts

/** Run lifecycle: queued → running → done | error (mirrors ParseStatus). */
export type RunStatus = 'queued' | 'running' | 'done' | 'error'

/** One step of the code-driven loop — the four-field replay unit (spec §7.5):
 *  input = what the controller saw; decision = tool+args / keywords / "done";
 *  output = raw + normalized result; note = why we moved on (scores / stop reason). */
export interface TrajectoryStep {
  seq: number
  /** `stage` 是非发现类 job（购买决策）的阶段进度：一步一条，note 是人话。 */
  kind: 'seed' | 'search' | 'classify' | 'fetch' | 'verify' | 'score' | 'expand' | 'rank' | 'result' | 'stage'
  input?: unknown
  decision?: unknown
  output?: unknown
  note?: string
  at: string
}

/** One raw web search result (the discovery entry, spec §6 step 1). */
export interface WebHit {
  title: string
  url: string
  snippet?: string
}

/** How a web hit is classified (spec §6 step 2). */
export type HitKind = 'netdisk' | 'hub' | 'noise'

/** A discovered aggregation hub — a TG channel / community post / 剧集站 that hoards this class of
 *  resource. The window into "where the stuff lives"; itself a candidate to onboard (spec §4 B轴). */
export interface Hub {
  url: string
  title?: string
  /** telegram | community | site */
  kind: string
}

/** 候选的通用壳（spec 2026-09-01 §2.1）：任何域的候选都有的两格。网盘字段在 NetdiskHit。 */
export interface Hit {
  title?: string
  snippet?: string
}

/** 网盘档自己的候选：一条网盘分享链。link / netdisk / password / sourceId / files 全是网盘概念。 */
export interface NetdiskHit extends Hit {
  link: string
  /** netdisk kind: quark / baidu / aliyun / … (from release.sourceType) */
  netdisk: string
  password?: string
  sourceId: string
  /**
   * What the share ACTUALLY contains, read out of it by netdisk.share.verify. Absent = never
   * verified (no Provider for that netdisk, or verification was off) — NOT "empty": a dead
   * share is dropped before it ever gets here, so an absent `files` must never read as a verdict.
   * These names beat `snippet` as the topicality signal: the snippet is whatever text happened to
   * sit near the link in some hub post, while a file list is the resource itself.
   */
  files?: string[]
}

/** Output of the classify joint: direct netdisk links pulled out, hubs found, and new category
 *  vocabulary learned from this round's hits (feeds the next round — the "会学" loop, spec §4/§6). */
export interface Classified {
  directLinks: NetdiskHit[]
  hubs: Hub[]
  vocab: string[]
}

/** A hit with its LLM topicality judgement (0–3). */
export interface ScoredHit extends NetdiskHit {
  topicality: number
}

/** A concrete acquisition target returned to the caller (= a ranked scored hit). */
export type SearchTarget = ScoredHit

/** 停在哪（Task 2，spec §2.5 ②）：**收敛和截断必须分得开**——前者是「覆盖到这个程度」，
 *  后者是「没挖完就被掐了」，对下游"覆盖范围"的含义完全相反（spec §2.4）。
 *  `interrupted` 是第三种"没挖完"：中途挂了、按已攒下的收尾——**它绝不能被读成正常结束**。 */
export type StopReason = 'early' | 'converged' | 'truncated' | 'dry' | 'interrupted'

export interface SearchOutcome<T> {
  /** 按域排序后的候选（网盘档：夸克优先 + 切题分；rank 外提在 flow，spec §2.1）。 */
  targets: Array<T & { fit: number }>
  /** discovered aggregation hubs — the聚集地 worth onboarding (spec §4 B轴). */
  hubs: Hub[]
  /** hub urls + productive candidate leads — candidates to onboard (v1: flag only). */
  onboardable: string[]
  /** early=早停够数｜converged=边际产出趋零｜truncated=跑满 maxRounds｜dry=扩源干涸｜
   *  interrupted=中途某一轮挂了，按已攒下的收尾（清单是残的）。 */
  stopped: StopReason
}

export interface RunRecord {
  runId: string
  goal: string
  /**
   * 这一条 run 跑的是哪个发现域（`netdisk` | `catalog`）。**它是读 `targets` 的前提**——
   * 两个域的候选形状不同（网盘档是 link/netdisk/files，商品档是 model/price/hubUrls），
   * 落库共用一格。存量记录没有这列，读出来缺省按 `netdisk`（它们全都是）。
   */
  domain: string
  status: RunStatus
  trajectory: TrajectoryStep[]
  targets?: SearchTarget[]
  /** discovered aggregation hubs (structured — url + kind), persisted alongside targets. */
  hubs?: Hub[]
  onboardable?: string[]
  /** 停在哪。**「收敛」和「跑满轮次被截断」对覆盖范围的含义相反**（spec §2.4），
   *  所以它必须落库、必须进回执，不能只在进程内活一次。 */
  stopped?: StopReason
  error?: string
  /**
   * 非发现类 job 的**最终产物**（购买决策档 = `DecisionReceipt`）。发现类的产物是 `targets`/`hubs`，
   * 这一格空着。形状随 `domain` 变——读它之前先看 `domain`，和 `targets` 一个道理。
   */
  result?: unknown
  updatedAt: string
}
