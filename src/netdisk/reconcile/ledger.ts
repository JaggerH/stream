// 运行账本（spec 2026-07-30-duplicate-episode-decision-design §4）：每次 preview/execute 追加一条
// 运行记录，并原样进 API 响应。
//
// 它回答的是「这一轮到底发生了什么」——过去只能从后端 stdout 里翻，探测失败和 AList 报错压根没有
// 落点。三条规矩（都在类型里能看出来）：
//  1. **每个进入本轮的文件恰好一行**（含"库内被认领、原地不动"这种无动作行）。缺行不是省事，是
//     bug —— `conservation` 会自己招供（input === 各筐之和，代码里算，不等就原样返回 false）。
//  2. **错误是行，不是日志**：探测失败 / AList 报错进 `errors`，随响应可见。
//  3. **`basis` 机器可读**（`authority:<leftKey>` / `size-dup-of:<path>` / `redundant-free:<leftKey>`
//     = 那一集源站自己放得出、网盘这份是冗余 / `redundant-free-candidates:<key1,key2,…>` = 没人认领
//     这份文件，但证据指着的**那几集**源站全放得出（同样是冗余，只是"是哪一集"不必答）
//     / `no-duration-hit:<秒>` / `ambiguous:<reason>:<leftKey>`
//     / 下架货架复核那两条：`relisted:<leftKey>` = 源站重新上架、这份回流付费货架，
//     `shelf-copy-of:<正主路径>` = 货架上这份是那一集的另一份、正主已在付费货架 …），
//     前端与人都不解析中文句子——中文只出现在 pending 的 `reason` 里，那是给人读的措辞。
import type Database from 'better-sqlite3'
import type { SpecAmbiguity } from '../match-spec.ts'
import type { AuthorityStats } from './plan.ts'
import type { GateVerdict } from './authority-gate.ts'
import type { RowExplain } from '../match-engine/explain.ts'
import { randomUUID } from 'node:crypto'

/** 一个文件在本轮落进的筐（spec §3.2 四个筐 + 字节全等重复 + 人工豁免）。 */
export type LedgerVerdict = 'claimed' | 'offline' | 'copy' | 'hold' | 'dup' | 'exempt'

/**
 * 这条建议**是怎么来的**——推理的起点在哪一侧。两条来路在产品语义上是两件事，卡片上必须一眼可分：
 *  · `authority` **从权威清单出发**：某一集去清单里找自己的文件（"哪个文件是我？"）。
 *    认领、同集其余份、免费集冗余、集侧问不出来的那些，以及下架货架复核那一整趟，都是它。
 *  · `file` **从网盘文件出发**：没有任何一集认领这份文件，只能从它自己的证据边反推
 *    （"我该怎么办？"）。残差下架、证据冲突、候选全免费、时长未探到、字节全等、人裁过的那些。
 *
 * **它是构造时的事实，不是事后按 `basis` 前缀猜出来的**：每个产出点自己知道走的是哪条分支，
 * 就在那里标上。拿 `basis` 做前缀匹配等于把展示字段当协议用——文案一改就静默错位。
 */
export type DecisionOrigin = 'authority' | 'file'

export interface LedgerRow {
  path: string
  size: number
  durationS?: number
  verdict: LedgerVerdict
  /** 认到的那一集（权威清单的 leftKey/标题）。offline/hold 天然没有。 */
  episode?: string
  /** 机器可读的判据短标识，绝不是中文句子。 */
  basis: string
  /** 这一行**是从哪一侧推出来的**（见 `DecisionOrigin`）。老账本行没有它 → 读侧优雅降级，别猜。 */
  origin?: DecisionOrigin
  /** 本轮对它做什么：`none` / `move:<dir>` / `delete:<dupOf>` / `pending:<pendingKind>`。 */
  action: string
  /**
   * 这一行的**证据卡数据**（`match-engine/explain.ts`）——裁决层轨迹的切片，hover card 直渲。
   *
   * **缺席是常态**，读侧不许假设它存在：老账本行没有它；豁免/字节全等那两档跑在匹配器之前，
   * 那些文件压根没进过证据图，本来就没有轨迹。前端据此隐藏 ⓘ（优雅降级，绝不补算——
   * 前端自己算一遍就是第二个判定脑）。
   */
  explain?: RowExplain
}

export interface RunCounts {
  input: number
  claimed: number
  offline: number
  copy: number
  hold: number
  dup: number
  exempt: number
}

/** 探测失败、AList 报错——一条一行，随响应可见（spec §4 规矩 2）。
 *  `stage` 与执行器的动作一一对应（`rename` 加编号前缀、`rmdir` 清搬空的分享子目录）：
 *  执行器新加一种动作就要在这里加一格，否则它的失败会被归到别的阶段名下，读账的人查错方向。 */
export interface RunError {
  path?: string
  stage: 'probe' | 'move' | 'rename' | 'delete' | 'rmdir'
  detail: string
}

/**
 * 这一轮**是谁发起的**：定时任务，还是人（面板 / API / 对话）。
 *
 * 它不是给人看的标签，是健康闸挑基线的判据（见 `latestAccepted`）：面板每展开一个节目就 POST 一次
 * 手动 preview，那一轮和定时轮长得一模一样，混在一起就没法回答"上一轮正常的时候清单是多少条"。
 */
export type RunTrigger = 'scheduled' | 'manual'

export interface RunRecord {
  runId: string
  at: string
  /** 哪个 show——reconcile_runs 是全局一张表，没有它读不出行属于谁。 */
  show: string
  mode: 'preview' | 'execute'
  /** 谁发起的。**老账本行没有它 → 读侧按 `manual` 算**（永不当基线）：把来路不明的一轮
   *  读成定时轮，就是拿一把不知道哪来的尺子去量，而存量库里全是这种行。 */
  trigger?: RunTrigger
  counts: RunCounts
  /** `input === claimed+offline+copy+hold+dup+exempt`。不等 = 账本自己报账不平，原样返回不遮掩。 */
  conservation: boolean
  /**
   * ② 播单这一区的验证点：覆盖率骤降 = feed 变了，先停手（spec §5）。
   *
   * **它同时是健康闸的基线**（`authority-gate.ts` 的 `prev`，由 `latestAccepted` 挑出哪一轮算数）
   * ——两个数就此来源独立：
   * 本轮的来自 `listLeft`，上一轮的来自这张表。落成同一个 `AuthorityStats` 不是省事，是为了
   * 「上一轮记的」和「本轮算的」逐字段可比；口径一分家，闸比的就是两把不同的尺子。
   */
  authority: AuthorityStats
  /** 定时轮被健康闸拦下：本轮 mode 是 preview、动作全部只记不做。手动执行的轮次永远没有它。 */
  gated?: GateVerdict
  rows: LedgerRow[]
  /**
   * 下架货架复核（`plan.ts` 的 `reviewSecondary`）。**独立小节，不并进 `rows`/`counts`**——
   * 那两样的守恒律说的是"进本轮主池的文件"，而下架文件按契约不进主池（P8），塞进去就把
   * 恒等式弄破了。`rows` 只有产生了动作的那几份；跑过没动的由 `checked` 交代。
   */
  secondaryReview?: { checked: number; rows: LedgerRow[] }
  errors: RunError[]
  /** 匹配器判不出的那些（leftKey + 在场候选 + 差在哪道门槛）。**归档器本轮不消费**，
   *  记在账上是为了先量：拆掉归档器那两个自建认领入口之前，得知道歧义有多少、什么形态。 */
  ambiguities?: SpecAmbiguity[]
}

/**
 * 判决书（explain）按 show 只保**最近 20 轮**，更老的轮剥掉 explain、其余字段原样保留。
 *
 * 为什么要裁：explain 让一轮账本从 ~76KiB 涨到 ~676KiB（2026-08-02 怡楽实测 8.9 倍），而本表
 * 只增不删——不裁一条线一年 GB 级。为什么敢裁：判决书服务"刚跑完这轮为什么这么判"，老轮次
 * 留结论（verdict/basis/counts）就够，真要翻旧案重跑一次 preview 就有新判决书。N=20 是用户拍板。
 */
export const EXPLAIN_RETAIN_RUNS = 20

/** netdisk.db 的 reconcile_runs 表。整轮一行——json 列已经是完整的一次运行，不需要二次关联；
 *  拆出的列（show/mode/conservation）是查询投影。 */
export class RunLedger {
  private readonly ins: Database.Statement
  private readonly tail: Database.Statement
  private readonly tailForShow: Database.Statement
  private readonly allForShow: Database.Statement
  private readonly staleExplain: Database.Statement
  private readonly rewrite: Database.Statement
  private readonly byRunId: Database.Statement

  constructor(db: Database.Database) {
    this.ins = db.prepare('INSERT OR REPLACE INTO reconcile_runs (run_id, at, show, mode, conservation, json) VALUES (?, ?, ?, ?, ?, ?)')
    this.tail = db.prepare('SELECT json FROM reconcile_runs ORDER BY rowid DESC LIMIT ?')
    this.tailForShow = db.prepare('SELECT json FROM reconcile_runs WHERE show = ? ORDER BY rowid DESC LIMIT ?')
    // 无上限：`latestAccepted` 要能翻到任意久之前那一条被接受的行（见它的头注）。逐行 iterate，
    // 命中即停，所以"没有 LIMIT"不等于"每次读全表"。
    this.allForShow = db.prepare('SELECT json FROM reconcile_runs WHERE show = ? ORDER BY rowid DESC')
    // 窗口先按"该 show 的全部轮次"数（新→旧跳过保留窗），再在窗外找仍带 explain 的——
    // LIKE 只是粗筛省 JSON.parse，真正的判定在 pruneExplain 里逐行做。
    this.staleExplain = db.prepare(
      `SELECT rowid, json FROM (
         SELECT rowid, json FROM reconcile_runs WHERE show = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?
       ) WHERE json LIKE '%"explain":%' LIMIT 8`,
    )
    this.rewrite = db.prepare('UPDATE reconcile_runs SET json = ? WHERE rowid = ?')
    this.byRunId = db.prepare('SELECT json FROM reconcile_runs WHERE run_id = ?')
  }

  append(record: RunRecord): void {
    this.ins.run(record.runId, record.at, record.show, record.mode, record.conservation ? 1 : 0, JSON.stringify(record))
    this.pruneExplain(record.show)
  }

  /** 每次 append 顺手剥一批（≤8 轮）——正常节奏下窗外每次只新增一轮，批量上限是给存量自愈用的。 */
  private pruneExplain(show: string): void {
    const stale = this.staleExplain.all(show, EXPLAIN_RETAIN_RUNS) as { rowid: number; json: string }[]
    for (const r of stale) {
      const rec = JSON.parse(r.json) as RunRecord
      let touched = false
      for (const row of rec.rows) if (row.explain) { delete row.explain; touched = true }
      for (const row of rec.secondaryReview?.rows ?? []) if (row.explain) { delete row.explain; touched = true }
      if (touched) this.rewrite.run(JSON.stringify(rec), r.rowid)
    }
  }

  /**
   * 健康闸的基线：**最近一轮"被接受过"的运行**，不是最近一轮运行。两种算被接受：
   *  · 定时轮且没被闸——机器自己认可了那份清单并照它动了文件；
   *  · 人工执行——人看过预览、点了执行，那一眼就是确认。
   *
   * 手动 preview 与被闸住的轮次都不算。两条都不是洁癖：
   *  · 面板每展开一个节目就 POST 一次手动 preview，它记的是**缩水后**的数字；拿它当基线，
   *    下一轮就是"缩水 vs 缩水 = 没变化"，闸等于不存在（用户点一下就把闸关了）。
   *  · 闸住的那一轮同理——认它，一次真实的永久缩水只会被拦一晚，第二晚照样整库搬空。
   *    代价是永久缩水会每晚都拦，**这正是要的**：出口是人工执行一次，不是等它自己忘掉。
   *
   * **往回翻整段历史，不设回看窗。** 每被闸一晚就多一条"不算数"的行，窗口一有上限，基线迟早被
   * 这些行挤出去——`prev` 变成 undefined，闸自己放行，而且是**拦得越久越容易失守**，没有一处会喊。
   * 行只增不删、一个节目一天一条，逐行倒着扫到命中为止的代价可以忽略（`iterate` 命中即停）。
   */
  latestAccepted(show: string): RunRecord | undefined {
    for (const row of this.allForShow.iterate(show) as Iterable<{ json: string }>) {
      const rec = JSON.parse(row.json) as RunRecord
      if ((rec.trigger === 'scheduled' && !rec.gated) || (rec.trigger === 'manual' && rec.mode === 'execute')) return rec
    }
    return undefined
  }

  /** 最近的运行，新→旧。删除不可逆，审计入口就是它。 */
  /** 按 runId 取那一轮。整轮撤销要先知道它动的是哪条绑定（才锁得对）——溯源行只记路径，答不了这个。 */
  get(runId: string): RunRecord | undefined {
    const row = this.byRunId.get(runId) as { json: string } | undefined
    return row ? (JSON.parse(row.json) as RunRecord) : undefined
  }

  list(opts: { show?: string; limit?: number } = {}): RunRecord[] {
    const limit = opts.limit ?? 50
    const rows = (opts.show ? this.tailForShow.all(opts.show, limit) : this.tail.all(limit)) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as RunRecord)
  }
}

export function newRunId(): string {
  return randomUUID().slice(0, 8)
}
