// src/intent/types.ts
/** 一个持久化的长期意图——订阅的单位从"源"升到"目的"（spec 2026-08-01）。 */
export interface IntentRecord {
  id: string
  /** 用户原话，不动 */
  goal: string
  /** LLM 立意图时生成的判定标准（白话：什么算相关、什么明确排除）——消化的地基 */
  criteria: string
  /** 潜在意图（"可能有小孩/从业者"）——一期只存不用 */
  metadata?: string
  /** 意图名下的源（招源落的订阅 + 手动绑的已有流） */
  streamIds: string[]
  /** 巡检周期，默认 24 */
  cadenceHours: number
  status: 'active' | 'retired'
  createdAt: number
  /** 上一轮消化完成时刻（调度判 due 用） */
  lastDigestAt?: number
  /** 意图专属频道（首次招源成功时懒创建；见 phase2 spec §1） */
  channelId?: string
  /** 由招源创建的流——retire 回退清单；查重复用的已有流不入 */
  recruitedStreamIds?: string[]
  /** 连续消化失败轮数（errors===judged 的轮；phase2 spec §3） */
  digestFailStreak?: number
  /** 退避截止（epoch ms）；scanDue 未到期跳过，0/缺省 = 无退避 */
  digestBackoffUntil?: number
}

/** 消化账本一条：判过的 item。判定失败的不入账本（下轮自然重试）。 */
export interface LedgerEntry {
  relevant: boolean
  summary?: string
  at: number
}

/** 键 = itemId。账本即增量游标：一轮只消化不在账本中的 item。 */
export type Ledger = Record<string, LedgerEntry>

export interface DigestOutcome {
  judged: number
  relevantNew: number
  errors: number
  /** 本轮因 maxJudged 截断而没轮到的条数——账本天然断点，下轮会接着判。 */
  remaining: number
  /** 本轮消化窗口(windowSize)已满且窗口内全为未判条目的 stream——意味着窗口外可能有更旧的
   *  条目被永久漏判（见 ARCHITECTURE.md § Intent）。 */
  windowSaturated: string[]
}
