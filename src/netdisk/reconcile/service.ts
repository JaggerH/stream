// 装配层（spec §4）：config 落库（netdisk.db reconcile_shows）+ 扫来源/库目录 + 取权威(listLeft)
// + 调 planner/executor。观察档默认（autoExecute:false）——不确认过就不许真的动网盘文件。
import type Database from 'better-sqlite3'
import { basename } from 'node:path'
import { authorityStats, buildPlan, type AuthorityStats, type PlanAction, type PlanInput, type PlanOutcome, type RFile } from './plan.ts'
import { countsOf, type Counts as CountsShape } from './counts.ts'
import { EXT, makeIdentity, type EpisodeIdentity } from '../identity.ts'
import { identityRulesFromSpec } from '../match-spec.ts'
import { executePlan, undoMove, undoRun as undoRunActions, type ExecDeps } from './execute.ts'
import { DecisionStore, ProvenanceLog, type ProvenanceEntry } from './decisions.ts'
import { SuggestionLog, type SuggestionQuery, type SuggestionVerdict } from './suggestions.ts'
import { DurationCache, durationOf, SYNC_PROBE_BUDGET } from './duration.ts'
import { RunLedger, newRunId, type RunError, type RunRecord, type RunTrigger } from './ledger.ts'
import { gateAuthority, type GateReason, type GateVerdict } from './authority-gate.ts'
import { resolveSpec, type LeftEntry } from '../sync.ts'
import {
  fingerprintsFromLeft, groupByLeafFolder, matchBySeasonResolved,
  type FolderGroup, type SeasonFingerprint,
} from '../season-resolve.ts'
import type { AuthorityListing } from '../left-from-stream.ts'
import type { FileShelf } from '../shelf.ts'
import type { MappingLeft, MatchSpec } from '../types.ts'
import type { TaskOutcome } from '../../tasks/types.ts'
import type { EventInput } from '../../events/store.ts'

/**
 * 一条绑定的整理配置。**整理只干两件事**：把还没归属到绑定名下的文件搬进货架，以及把同一集攒下的
 * 落选副本删掉（spec 2026-07-31 §2）。所以它只持有「来源目录」——**货架地址不在这里**，各有自己的
 * 真相源：
 *  - 认领货架 = 绑定的落地目录（`binding.right.path`），播客影视通用；
 *  - 第二货架 = 订阅那条「下架 stream」扫的目录：下架集本身就是一条扫网盘的 stream，它是权威清单
 *    的补充来源，不是谁的附属货架。影视绑定没有这个概念，那一格就是空的。
 * 地址都在 `shelvesOf()` 里现解，不落这份配置——存一份拷贝就是第二个真相源。
 */
export interface ReconcileShowConfig {
  id: string // 'yile'
  label: string // '怡楽播客'
  bindingId: string // 权威来源:该绑定的 listLeft(left) 标题集
  /** 上游来源目录（只读扫描）。**可选**：不配 = 原地模式（影视那档退化配置）——没有暂存区、
   *  没有搬运，只对绑定目录自己的文件规划留哪份/删哪份。 */
  sourceDirs?: string[]
  subShows: { name: string; dir: string; numPattern: string }[]
  autoExecute: boolean // false=观察档（默认）：任务只报告
  /** 认集规则显式覆盖（数据，不回代码）。缺省 = 从 bindingId 绑定的 matchSpec 抽取；
   *  只在归档器需要与绑定不同口径时用（如绑定侧集号 1–3 位、归档器要三位零填充隔离两套编号）。 */
  identity?: { titleStrip?: string[]; epNumRegex?: string }
}

interface ReconcileConfigFile {
  shows: ReconcileShowConfig[]
}

export interface ExecResult {
  moved: number
  /** 只加 `SxxExx - ` 编号前缀的原地改名数（影视档才有）。与 `moved` 分开：它不挪窝。 */
  renamed: number
  deleted: number
  /** 本轮搬空后被清掉的分享子目录数（影视档才有，见 `ExecOptions.cleanupEmptiedDirs`）。 */
  removedDirs: number
  pending: number
  errors: string[]
  /** 本轮的运行账（spec §4）——每个进入本轮的文件一行 + 守恒律 + 错误行。 */
  ledger: RunRecord
  /**
   * 本轮的 id，**恒等于 `ledger.runId`**：这一轮写下的每条溯源行都盖着它，
   * `undoRun(runId)` 靠它把一轮当整体撤回来。单独摆一格是给调用方少一次 `.ledger.` 的钻取
   * ——追更循环那一侧要把它记进 `follow_runs`。
   */
  runId: string
}

/** `executeShow` / `executeBinding` 的开关。两个都缺省 = 人工那条路（照删确认档、不过闸）。 */
export interface ExecuteOptions {
  /** 允许删确认档（`delete-loser` / `replace`）。缺省 true；定时轮传 false（见 `ExecOptions.losers`）。 */
  losers?: boolean
  /**
   * 过权威清单健康闸。**无人值守的调用方（追更循环）必须传 true**：它背后没有人眼确认，
   * 而清单一缩水，库里已认领的文件会被整批判成"清单里没有它"。被闸时不执行、只记一条
   * `preview` 账（带 `gated`），下一轮照旧拦，出口是人工执行一次。
   */
  gated?: boolean
}

/** 只读的权威清单视图（见 `ReconcileService.authority`）：清单本身 + 账本同一口径的三个数，
 *  外加清单自己对"全不全"的申报（`truncated`）和取数口的名字（`source`）——数字旁边写尺子。 */
export interface AuthorityView {
  entries: LeftEntry[]
  stats: AuthorityStats
  /** 清单被上限截断了，后面还有——**缺席**表示"全"，别写 false。 */
  truncated?: true
  source: string
}

/** 清单 → 只读视图。三扇 authority 门共用一份，省得各拼各的（漏带 `truncated` 不会有人报警）。 */
function viewOf(listing: AuthorityListing): AuthorityView {
  return {
    entries: listing.entries,
    stats: authorityStats(listing.entries),
    source: listing.source,
    ...(listing.truncated ? { truncated: true as const } : {}),
  }
}

export interface PreviewResult {
  plan: (PlanAction & { key: string })[]
  counts: Counts
  /** 本轮两个货架的地址 + 来源目录——**给 UI 判"这个路径是库里的还是来源里的"**。清单里每一行都要
   *  同时摆出删哪份、留哪份，而光看一条网盘路径分不出它属于哪边；判据是目录前缀，只有后端手里有。
   *  前端别拿 `compare.candidates[].inLib` 顶替：那个字段说的是"此刻在认领货架上"，第二货架上的
   *  文件也是 false。 */
  shelves: Shelves
  sourceDirs: string[]
  ledger: RunRecord
  /** 多季绑定：绝对目录 → 判出的季号（`null` = 判不出）。裁决器的季一致性闸吃它；单季/播客/电影缺席。
   *  JSON 友好的对象而不是 Map——这份回执会原样出 HTTP。 */
  seasonOfDir?: Record<string, number | null>
}

export interface ReconcileBinding {
  id: string
  left: MappingLeft
  /** 落地目录 = **认领货架**的真相源（P8）：绑定认下的文件就落在这儿。 */
  right: { path: string }
  matchSpec?: MatchSpec
  /** 绑定的配对表——归档器只取其中**人工订正过**的那些当 pin（`rightFile` 是相对子路径，
   *  这一层负责拼上货架地址变成绝对路径）。人裁过的机器不许翻案，而归档器过去根本不知道
   *  它存在：钉死 A→ep1、归档器重算认为 B→ep1，就把 A 当"清单里没有它"搬去下架。 */
  entries?: { leftKey: string; rightFile: string | null; corrected?: unknown }[]
}

/** 货架地址（现解，不落配置）。`secondary` 缺席 = 这条绑定没有第二货架（影视），
 *  认不出的文件原地不动。 */
export interface Shelves {
  claimed: string
  secondary?: string
}

/**
 * 归档器取权威清单的口。与绑定那支的 `ListLeft` 分家：这边回的是**带申报的清单对象**
 * （`entries` + `truncated` + `source`），因为归档器要拿"清单里没有它"当下架的结论——
 * 清单不全时那句话是错的，得先知道全不全。绑定那支不做这种推断，保持裸数组。
 */
export type ListAuthority = (left: MappingLeft) => Promise<AuthorityListing>

export interface ReconcileDeps {
  /** netdisk.db（openNetdiskDb）——整理的配置/裁决/账本/审计/时长缓存全在这一个库里。 */
  db: Database.Database
  alist: FileShelf
  listLeft: ListAuthority
  getBinding: (bindingId: string) => ReconcileBinding | undefined
  /**
   * **第二货架**的真相源（P8）：下架集本身就是一条 stream——扫某个网盘目录扫出来的（`alist` 成员），
   * 扫到的每个文件直接就是一条可播条目。这里把那条成员扫的目录取出来。
   *
   * 返回 undefined = 这个订阅还没有下架 stream。**那就没有第二货架**，不许退回"配置里存的那个路径"
   * ——没有 stream 扫的目录里，文件搬进去等于从用户眼前消失（不可播、不在任何清单里）。
   */
  offlineDirOf: (streamId: string) => string | undefined
  events?: { append: (e: EventInput) => unknown }
  /** 时长探测（可注入：单测给假的；生产缺省走 ffprobe）。 */
  probeDuration?: (url: string) => Promise<number | null>
  /** 时长缓存（可注入）。生产装配把它与绑定匹配的时长档共用同一份——同一批网盘文件，
   *  分两份等于把已经付过的 ffprobe 钱再付一遍。缺省 = 自己在 dataDir 下开一份。 */
  durationCache?: DurationCache
  /**
   * 季归属解析器（`NetdiskService.resolveSeasons` 的结构类型，Task 8）：叶子目录名 → 季号 | null。
   * **多季 tmdb 剧集绑定必须有它**，缺席时 `planFor` 直接抛 `ValidationError`——见那里的头注：
   * 退回单锅匹配会把跨季同期号的文件判成同一集，而那种错是无声的。
   *
   * 写成结构类型（不 import `NetdiskService`）：归档器只用得上这一个函数，把整个绑定服务拖进
   * 依赖只是为了一个签名。
   */
  resolveSeasons?: (setId: string, groups: FolderGroup[], fingerprints: SeasonFingerprint[]) => Promise<Map<string, number | null>>
  log: (m: string) => void
}

// `Counts` 与它的算法住在 `counts.ts`——那里的 `BUCKET` 由 `PlanAction['kind']` 派生，
// 加一类动作不更新就编译报错。这里只是转出去，别在本文件里另起一份手写投影。
type Counts = CountsShape

/** putConfig 校验失败——route 层映射为 400（非 404/500）。 */
export class ValidationError extends Error {}

/** 来源目录（缺省 = 原地模式，一个都没有）。别在各处写 `?? []`——漏一处就是"原地模式下
 *  仍去扫 undefined"这类静默错。 */
const sourceDirsOf = (show: ReconcileShowConfig): string[] => show.sourceDirs ?? []
/** 没 pin 就**不带这个字段**（不是带一个 undefined）——`SpecLeft` 那边只判"在不在"。 */
const pinnedRight = (path: string | undefined): { pinnedRight?: string } => (path ? { pinnedRight: path } : {})

/**
 * 这条绑定走不走多季影视模式（`PlanInput.seasonFolders` / `ExecOptions.cleanupEmptiedDirs`）。
 *
 * **抽成具名函数、只此一份**：两个消费点（规划器的落点规则、执行器的空目录清理）必须同答案——
 * 一边开一边不开的表现是"集搬进了季目录，而搬空的分享壳留在那儿"，两边单看都正常。
 */
export const seasonFoldersFor = (binding: ReconcileBinding): boolean =>
  binding.left.kind === 'tmdb' && binding.left.media === 'tv'

/** 目录前缀重叠判定（同 plan.ts sourcePriority 的 '/'-边界比较风格）：a===b，或 a 是 b 的祖先/子孙目录。 */
function dirOverlaps(a: string, b: string): boolean {
  if (a === b) return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

export class ReconcileService {
  private config: ReconcileConfigFile = { shows: [] }
  private readonly decisions: DecisionStore
  private readonly suggestions: SuggestionLog
  private readonly provenance: ProvenanceLog
  private readonly runs: RunLedger
  private readonly durations: DurationCache | undefined
  private readonly persistConfig: (shows: ReconcileShowConfig[]) => void

  constructor(private readonly deps: ReconcileDeps) {
    this.decisions = new DecisionStore(deps.db, deps.alist.id)
    this.suggestions = new SuggestionLog(deps.db)
    this.provenance = new ProvenanceLog(deps.db)
    this.runs = new RunLedger(deps.db)
    // 时长缓存：探过一次就永不重探（key = 路径+字节数）。alist 不给直链就整个跳过探测。
    this.durations = deps.alist.rawUrl ? (deps.durationCache ?? new DurationCache(deps.db)) : undefined
    const clear = deps.db.prepare('DELETE FROM reconcile_shows')
    const ins = deps.db.prepare('INSERT INTO reconcile_shows (id, ord, json) VALUES (?, ?, ?)')
    this.persistConfig = deps.db.transaction((shows: ReconcileShowConfig[]) => {
      clear.run()
      shows.forEach((s, i) => ins.run(s.id, i, JSON.stringify(s)))
    })
    const rows = deps.db.prepare('SELECT json FROM reconcile_shows ORDER BY ord').all() as { json: string }[]
    this.config = { shows: rows.map((r) => JSON.parse(r.json) as ReconcileShowConfig) }
  }

  /** 落盘形状（整理自己拥有的字段）。UI 的「读→改→整份写回」走它。 */
  getConfig(): ReconcileConfigFile {
    return this.config
  }

  /**
   * 给界面看的读模型：配置 + **现解出来的货架地址**。地址不落配置（P8），但用户得看得见
   * "东西会搬去哪"；解不出来时把原因原样带上——那句话就是他该去补哪一样东西的指路。
   */
  getConfigView(): { shows: (ReconcileShowConfig & { shelves: Shelves | null; shelvesProblem?: string })[] } {
    return {
      shows: this.config.shows.map((s) => {
        try {
          const shelves = this.shelvesOf(s)
          this.assertShelvesUsable(s, shelves) // 解出来但不能用（重叠）也是要让用户看见的问题
          return { ...s, shelves }
        } catch (e) {
          return { ...s, shelves: null, shelvesProblem: e instanceof Error ? e.message : String(e) }
        }
      }),
    }
  }

  /** 货架能解就解（用于写入期校验/展示）；解不出来返回 null——**不当错误**：配置可以先于
   *  绑定与下架 stream 存在，真正拦人的时机是 preview/execute（那时 `shelvesOf` 会抛并指路）。 */
  shelvesIfResolvable(show: ReconcileShowConfig): Shelves | null {
    try {
      return this.shelvesOf(show)
    } catch {
      return null
    }
  }

  putConfig(cfg: ReconcileConfigFile): void {
    for (const show of cfg.shows) {
      // 货架还解不出来（绑定/下架 stream 尚未就位）→ 放行：配置可以先写，真正拦人的时机是运行前。
      // 解得出来就必须当场校验，别等他保存完、下一轮预览才炸。
      const shelves = this.shelvesIfResolvable(show)
      if (shelves) this.assertShelvesUsable(show, shelves)
      // show.identity 是从磁盘/API 落进来的数据覆盖，不可信——不可编译的正则要在这里挡下来,
      // 否则错误会在每次 preview/execute 时深埋在 new RegExp 里冒出来（见 match-spec.ts validateSpec 同款校验）。
      if (show.identity) {
        for (const re of show.identity.titleStrip ?? []) {
          try {
            new RegExp(re)
          } catch {
            throw new ValidationError(`show '${show.id}': identity.titleStrip has an uncompilable regex: ${re}`)
          }
        }
        if (show.identity.epNumRegex !== undefined) {
          try {
            new RegExp(show.identity.epNumRegex)
          } catch {
            throw new ValidationError(`show '${show.id}': identity.epNumRegex is uncompilable: ${show.identity.epNumRegex}`)
          }
        }
      }
      // 跨 show：同一片网盘区域被两个 show 认领 → 先跑的把文件搬走,后跑的面对空目录会把
      // "全没了"读成"全下架"。来源目录撞上别的 show 的库 → 把别人库里的文件当自己的来源搬走。
      // 认领(一次点击)让误指目录变容易,必须在写入时挡死,不能等 plan 阶段。
      for (const other of cfg.shows) {
        if (other.id === show.id) continue
        const otherShelves = this.shelvesIfResolvable(other)
        const otherDirs = [
          ...sourceDirsOf(other),
          ...(otherShelves ? [otherShelves.claimed, ...(otherShelves.secondary ? [otherShelves.secondary] : [])] : []),
        ]
        for (const src of sourceDirsOf(show)) {
          for (const dir of otherDirs) {
            if (dirOverlaps(src, dir)) {
              throw new ValidationError(
                `show '${show.id}': sourceDir '${src}' overlaps show '${other.id}' 的目录 '${dir}' — 两个节目不能认领同一片网盘区域`,
              )
            }
          }
        }
      }
    }
    // 只写整理自己拥有的字段。存量文件里的 libPaid/libOffline（货架地址的旧拷贝）在这里被剥掉——
    // 留着就是第二个真相源，早晚和绑定/下架 stream 分家（P8）。
    this.config = {
      shows: cfg.shows.map((s) => ({
        id: s.id,
        label: s.label,
        bindingId: s.bindingId,
        sourceDirs: sourceDirsOf(s),
        subShows: s.subShows,
        autoExecute: s.autoExecute,
        ...(s.identity ? { identity: s.identity } : {}),
      })),
    }
    this.persistConfig(this.config.shows)
  }

  /**
   * 按 show id 找配置，**找不到就再按订阅 id 和显示名各试一次**。
   *
   * 为什么要这三档：对话那一侧手里拿到的是**订阅 id**（`@` 引用插进草稿的是
   * `「名字」(stream:<id>)`），而这个函数要的是 **show id**。两者今天常常相等（show id 由
   * streamId 派生），但那是巧合不是契约——撞名时 show id 会带数字后缀，那一刻就对不上了。
   * 活体实测（2026-08-25）：模型先拿显示名试、失败，再列一次清单，第三次才蒙对。
   *
   * **失败时把清单摆出来**，别只说一句 `unknown show`：调用方（人或模型）唯一需要的就是
   * "那到底该传什么"，报出来它下一步就对了，不用再多跑一轮列清单。
   */
  private showOrThrow(showId: string): ReconcileShowConfig {
    const byId = this.config.shows.find((s) => s.id === showId)
    if (byId) return byId
    // 订阅 id：整理配置本身不记订阅，得绕道绑定（同 app 侧 `showsForStream` 的判据）。
    const byStream = this.config.shows.find((s) => {
      const binding = this.deps.getBinding(s.bindingId)
      return binding?.left.kind === 'stream' && binding.left.streamId === showId
    })
    if (byStream) return byStream
    const byLabel = this.config.shows.find((s) => s.label === showId)
    if (byLabel) return byLabel
    const known = this.config.shows.map((s) => s.id).join(', ') || '（一个都没有）'
    throw new Error(`unknown show: ${showId}——可传 show id / 订阅 id / 节目名。现有 show：${known}`)
  }

  /**
   * 扫目录 → **未过滤**的全部文件名（绝对路径 + 字节数）。这是本轮唯一一次列目录，媒体池由
   * `mediaOnly` 从它筛出来——列两遍就是同一批目录出两趟网，还可能拿到两份不一致的快照。
   *
   * 季归属吃的是**这一份**，不是筛过的那一份：季号常年只写在 `.zip`/`.nfo`/`.txt` 这类非媒体
   * 文件名里（`folderContext.extraFiles` 与 `nestedCleanNameSeason` 扫的路径段都吃它）。筛过再问，
   * 线索在进门口就被扔了，而判出来的 `null` 还会以文件夹名为键写进 `llmSeasonCache` 被同步那侧
   * 复用——两边从此各判各的，没有一处会喊。
   */
  private async scanAllNames(dirs: string[]): Promise<{ name: string; size: number }[]> {
    const out: { name: string; size: number }[] = []
    for (const dir of dirs) {
      // refresh=true 强制 AList 回源:对账式「只相信现状」,30 分钟目录缓存会让预览拿到
      // 移动进行中的冻结快照——首轮活体实测:二轮预览的库视图停在 200/304,产出 4 条幻影 move
      // 并撞出 403 同名冲突。夜间任务不差这点列表耗时。
      const files = await this.deps.alist.listDirRecursive(dir, 5, true)
      for (const f of files) {
        if (f.isDir) continue
        out.push({ name: `${dir}/${f.name}`, size: f.size })
      }
    }
    return out
  }

  /**
   * 本轮的文件池。**非媒体文件在这里就被挡在流水线外**（字幕 `.ass/.srt`、封面图、
   * `.nfo/.txt/.zip`…）：判定层的每一条判据（时长、码率、认集身份）都是为音视频设的，喂给它们
   * 只会产出噪音——活体的负缓存里 16 个"探不到时长"的全是这类文件，每轮都占一行 `hold` 问句。
   *
   * 挡在**进池这一步**而不是判定层，是因为这里是唯一的入口：三个货架都从这一个函数进来，挡一次
   * 全覆盖，而且它们不进池 = **不进账本行**（`input` 计数不含它们，守恒照样成立）= 永不被搬、
   * 永不被删。判据复用共享认集层的 `EXT`（音频 + 视频扩展名并集）——"什么算媒体文件"只该有一份清单。
   */
  private mediaOnly(all: { name: string; size: number }[]): RFile[] {
    const out: RFile[] = []
    let skipped = 0
    for (const f of all) {
      if (!EXT.test(f.name)) { skipped++; continue }
      out.push({ path: f.name, name: basename(f.name), size: f.size })
    }
    if (skipped > 0) this.deps.log(`[reconcile] 跳过 ${skipped} 个非媒体文件（字幕/图片/说明档——不匹配、不搬、不删）`)
    return out
  }

  private async scanFiles(dirs: string[]): Promise<RFile[]> {
    return this.mediaOnly(await this.scanAllNames(dirs))
  }

  /**
   * 补时长（带缓存）。逐个串行——探测走网盘直链，并发拉高只会招限流，而缓存命中后整轮几乎不发请求。
   *
   * 两条边界：**新探测受 `SYNC_PROBE_BUDGET` 约束**（首轮几百个文件全探会把一轮拖到十分钟级），
   * 预算外的原样带过 → planner 判 `hold`，下轮续探，缓存只增不减、几轮收敛；**探失败进 `errors`**
   * ——「错误是行，不是日志」（spec §4）。负缓存（探过且失败）不再重复报错，它的 `hold` 行自带
   * `basis:no-duration`。
   */
  private async withDurations(files: RFile[], errors: RunError[]): Promise<RFile[]> {
    const cache = this.durations
    if (!cache) return files
    const out: RFile[] = []
    let fresh = 0
    for (const f of files) {
      const cached = cache.get(f.path, f.size)
      if (cached !== undefined) {
        out.push(cached === null ? f : { ...f, durationS: cached })
        continue
      }
      if (fresh >= SYNC_PROBE_BUDGET) { out.push(f); continue } // 预算外：本轮当未知，不落负缓存
      fresh++
      const durationS = await durationOf(f, {
        rawUrl: (p) => this.deps.alist.rawUrl!(p),
        cache,
        probe: this.deps.probeDuration,
        log: this.deps.log,
      })
      if (durationS === null) errors.push({ path: f.path, stage: 'probe', detail: '探不到时长（凭证/网络/编码）——本轮按未知处理' })
      out.push(durationS === null ? f : { ...f, durationS })
    }
    return out
  }

  /** 绑定存在性是唯一真相源——不存在就抛错，别用 `?.` 静默降级到默认规则（一处判定，两处消费）。 */
  private bindingOrThrow(show: ReconcileShowConfig): ReconcileBinding {
    const binding = this.deps.getBinding(show.bindingId)
    if (!binding) throw new Error(`unknown binding: ${show.bindingId}`)
    return binding
  }

  /**
   * 货架地址，从各自真相源现解（P8）——整理不持有它们。**只解析，不判好坏**：解析失败
   * （没绑定 / 绑定没落地目录 / 订阅该有下架 stream 却没有）与"地址解出来了但不能用"（重叠）
   * 是两件事，混在一个函数里会让调用方分不清"还没配好"和"配错了",前者可以放行、后者必须拦。
   *
   * 解不出来就抛，**不许猜、不许退回配置里的旧值**：搬文件不可逆，地址错一个字就是把文件搬进
   * 一个没人扫的目录（用户那边直接消失）。报错文案要指到该去补哪一样东西。
   *
   * **影视绑定（`left.kind === 'tmdb'`）没有第二货架**，那不是缺配置：它压根没有"下架"这个
   * 概念，认不出的文件原地不动即可，所以 `secondary` 留空、不报错。
   */
  shelvesOf(show: ReconcileShowConfig): Shelves {
    const binding = this.bindingOrThrow(show)
    const claimed = binding.right?.path
    if (!claimed) {
      throw new ValidationError(`show '${show.id}': 绑定 '${show.bindingId}' 没有落地目录——认领的文件无处可去，先给它绑一个网盘目录`)
    }
    if (binding.left.kind !== 'stream') return { claimed }
    const secondary = this.deps.offlineDirOf(binding.left.streamId)
    if (!secondary) {
      throw new ValidationError(
        `show '${show.id}': 这个订阅还没有「下架」来源——下架集本身是一条扫网盘目录的 stream，` +
          `没有它，判为下架的文件搬过去就没人扫得到（等于消失）。先给订阅加一条扫下架目录的来源。`,
      )
    }
    return { claimed, secondary }
  }

  /** 地址解出来了，还得能用：来源目录不许和任一货架重叠。**运行前和写入时各查一次**——
   *  写入时查是为了当场退回给正在填表的人，运行前查是因为货架地址在别处（绑定/下架 stream）
   *  可以随时被改，配置这边不会收到通知。 */
  private assertShelvesUsable(show: ReconcileShowConfig, shelves: Shelves): void {
    for (const src of sourceDirsOf(show)) {
      // 下架目录落在来源目录里 = 把暂存区当货架：整理把文件搬进自己下一轮要扫的地方来回打转，
      // 而且那条 stream 会把还没整理的暂存文件当成正式条目。
      if (shelves.secondary && dirOverlaps(src, shelves.secondary)) {
        throw new ValidationError(
          `show '${show.id}': 下架 stream 扫的是 '${shelves.secondary}'，和来源目录 '${src}' 重叠——` +
            `来源是待搬走的暂存区，不能同时当货架。把那条 stream 指到真正的下架目录。`,
        )
      }
      if (dirOverlaps(src, shelves.claimed)) {
        throw new ValidationError(
          `show '${show.id}': 来源目录 '${src}' 与认领货架 '${shelves.claimed}' 重叠——会把库内文件当成自己的来源搬走`,
        )
      }
    }
  }

  /** 共享认集器：绑定的 matchSpec 是规则真相源，show.identity 是显式覆盖（spec §3）。
   *  它只做**分组键**（人工豁免按它存、字节全等重复按它判同集）——"这个文件是哪一集"归匹配器。 */
  private identityFor(show: ReconcileShowConfig): (name: string) => EpisodeIdentity {
    const binding = this.bindingOrThrow(show)
    const rules = identityRulesFromSpec(binding.matchSpec)
    return makeIdentity({
      titleStrip: show.identity?.titleStrip ?? rules.titleStrip,
      epNumRegex: show.identity?.epNumRegex ?? rules.epNumRegex,
    })
  }

  /**
   * 一轮的现状采集 + 判定。**匹配用的谱与绑定同步同一份**（`resolveSpec`）——两份就是两个脑（P7）。
   *
   * 来源文件与认领货架文件**一起进匹配池**：库内那份是不是这一集，同样只能由匹配器说。第二货架
   * 不进池（它的契约是"文件自己就是一集，不配对"），只用来判字节全等重复和同名占位；没有第二
   * 货架（影视）时那一侧就是空的。
   */
  private async planFor(
    show: ReconcileShowConfig,
    identity: (name: string) => EpisodeIdentity,
  ): Promise<{ outcome: PlanOutcome; errors: RunError[]; shelves: Shelves; listing: AuthorityListing; seasonOfDir?: Map<string, number | null> }> {
    const binding = this.bindingOrThrow(show)
    const shelves = this.shelvesOf(show)
    this.assertShelvesUsable(show, shelves) // 货架地址在别处，随时可能被改成不能用的——每轮现查
    const errors: RunError[] = []
    // 人工订正的 pin：绑定里存的是相对子路径，归档器这一侧的右侧是绝对路径，必须拼上认领货架
    // 地址——不拼就永远匹配不上，而且是**静默**失效（配不上又不报错）。
    const pinned = new Map(
      (binding.entries ?? [])
        .filter((e) => e.corrected && e.rightFile)
        .map((e) => [e.leftKey, `${shelves.claimed.replace(/\/$/, '')}/${e.rightFile!}`]),
    )
    // `needsSupply` 必须原样带过来（**包括缺席**：`...(e.needsSupply != null ? ... : {})` 让"清单
    // 答不上来"保持缺席，归档器那边按保守档补成"要供货"）。漏掉这一行不会有任何单测报警——
    // 两头的用例各测各的，中间这一跳没人看——表现是清单明说"源站自己放得出"、归档器却当它没说。
    const listing = await this.deps.listLeft(binding.left)
    const authority = listing.entries.map((e) => ({
      leftKey: e.leftKey, title: e.title, durationS: e.durationS, paid: e.paid,
      ...(e.needsSupply != null ? { needsSupply: e.needsSupply } : {}),
      ...(pinnedRight(pinned.get(e.leftKey))),
    }))
    const sourceDirs = sourceDirsOf(show)
    // 来源与认领货架列的是**未过滤**的那一份：媒体池由 `mediaOnly` 从它筛出来，而季归属吃的是
    // 整份（季线索常年只在 `.zip`/`.nfo` 这类名字里，见 `scanAllNames` 头注）。第二货架不参与
    // 季归属（播客才有它，没有季这回事），照旧直接要筛过的。
    const [sourceAll, claimedAll, libSecondaryFiles] = await Promise.all([
      this.scanAllNames(sourceDirs),
      this.scanAllNames([shelves.claimed]),
      shelves.secondary ? this.scanFiles([shelves.secondary]) : Promise.resolve([]),
    ])
    const rawSourceFiles = this.mediaOnly(sourceAll)
    const rawLibClaimed = this.mediaOnly(claimedAll)
    // 三侧共用一份探测预算，**顺序就是优先级**：来源（本轮真正等着落位的）→ 认领货架（就是绑定
    // 的右侧目录，匹配器早探过，基本全是缓存命中，同一张 durations 表）→ 下架货架（每轮回头看
    // 那一趟要用，见 `plan.ts` 的 `reviewSecondary`：没有时长它就只剩名字链）。
    // 下架排最后：预算真被前两侧吃光时，代价是复核这一轮少认几份，而不是主池少落位几份。
    const probed = await this.withDurations([...rawSourceFiles, ...rawLibClaimed, ...libSecondaryFiles], errors)
    const claimedEnd = rawSourceFiles.length + rawLibClaimed.length
    const partition = await this.seasonPartitionedMatch(binding, shelves.claimed, [...sourceAll, ...claimedAll], listing)
    const outcome = buildPlan({
      authority,
      sourceFiles: probed.slice(0, rawSourceFiles.length),
      libClaimedFiles: probed.slice(rawSourceFiles.length, claimedEnd),
      libSecondaryFiles: probed.slice(claimedEnd),
      subShows: show.subShows.map((s) => ({ name: s.name, dir: s.dir, numPattern: new RegExp(s.numPattern) })),
      dirs: shelves,
      verdictFor: (key) => this.decisions.verdictFor(key),
      notEpisode: (leftKey, path) => this.decisions.isNotEpisode(leftKey, path),
      // 问句的另一半答案。按 leftKey 现问——那个键是 buildPlan 自己从权威清单推出来的。
      pinnedFor: (leftKey) => this.decisions.pinnedFor(leftKey) ?? undefined,
      // 第二货架上「比不出高下」那一档的人裁答案（`buildPlan` 只在 unknown 那一格问它）。
      preferredOf: (a, b) => this.decisions.preferredOf(a, b) ?? undefined,
      sourcePriority: sourceDirs,
      sourceDirs,
      identity,
      matchSpec: resolveSpec(binding),
      // 货架自述表：规划器按它降级（无回收站 → 所有删进确认档；不区分大小写 → 占位按折叠名比）。
      // **从货架自己身上取**，不在这里按来源类型硬写——那正是这张表要消灭的那个 if。
      shelf: this.deps.alist.traits,
      // 多季影视模式只对 **tmdb 剧集**绑定开（spec 2026-09-03 §1）：电影没有季集，播客那一支
      // 连 leftKey 都不是季集号形状。判据写在这一处，别散到规划器里——它只认这一个布尔。
      ...(seasonFoldersFor(binding) ? { seasonFolders: true as const } : {}),
      // 同步与归档必须同一条分区路，否则跨季同期号的文件被判成同一集（活体 2026-09-03
      // 脱口秀 52/128 行错判）。缺席 = 单季/播客/电影，照旧一锅匹配。
      // `unresolvedSeasonDirs` 必须跟着一起给：判不出季的文件夹整段没进匹配器，规划器得知道
      // 它们是"没判过"而不是"没人要"，否则那些文件会掉进 `unhandled:` 兜底。
      // `seasonOfDir` 同样跟着一起给：纯享剪辑不属于任何一集、拿不到 leftKey，它落到哪一季的
      // 纯享货架只能从"它此刻待着的文件夹属于哪一季"来。漏了这一项的表现是纯享文件静默留在
      // 原地——预览里少一条动作，没有任何一处会喊。
      ...(partition
        ? { match: partition.match, unresolvedSeasonDirs: partition.unresolvedSeasonDirs, seasonOfDir: partition.seasonOfDir }
        : {}),
    })
    // 清单原样带出去：`truncated` 是健康闸的入参之一，`outcome.authority` 里没有它
    // （它说的是"这份清单全不全"，不是"清单里有几条"）。
    return { outcome, errors, shelves, listing, ...(partition ? { seasonOfDir: partition.seasonOfDir } : {}) }
  }

  /**
   * 多季剧集绑定的匹配裁决器：先把季归属问出来（走 `deps.resolveSeasons`，与同步共用同一份
   * `llmSeasonCache`），再把绑好的 `matchBySeasonResolved` 交给规划器。
   *
   * **同步与归档必须同一条分区路，否则跨季同期号的文件被判成同一集**（活体 2026-09-03 脱口秀
   * 52/128 行错判：第 2 季的「第2期上」被归档器判成第 3 季那一集的落选副本，要 replace /
   * delete-loser——删掉的是另一季那一集唯一的文件）。两季期号一样、标题几乎一样、季号只写在
   * 文件夹名里，一锅裁决分不开。
   *
   * 返回 undefined = 不分区（单季绑定 / 电影 / 播客），照旧走 `matchSpec` 那条路。
   *
   * 键的口径：`resolveSeasons` 收的是**相对认领货架根**的目录名（与同步一致，缓存才互相命中），
   * 而规划器那侧右侧文件名是**绝对路径**，所以答案要转回绝对目录再传下去。
   *
   * **认领货架之外的来源目录不进解析器**（原地模式外才有）：那份缓存的键是"相对认领货架根的
   * 叶子目录"，塞一个绝对路径进去既污染绑定上那份缓存、同步那侧也永远命不中。它们直接以
   * `null` 进答案表 —— 判不出季 = 整段不参与匹配、原地不动，账本上有自己那一行。
   *
   * `files` 收的是**未过滤**的全部文件（含 `.zip`/`.nfo`）：季线索常年只在这类名字里，
   * 见 `scanAllNames` 头注。匹配器那一侧看到的仍然只有筛过的媒体文件，两者是两回事。
   */
  private async seasonPartitionedMatch(
    binding: ReconcileBinding,
    claimed: string,
    files: { name: string; size: number }[],
    listing: AuthorityListing,
  ): Promise<{ match: PlanInput['match']; unresolvedSeasonDirs: Set<string>; seasonOfDir: Map<string, number | null> } | undefined> {
    if (!seasonFoldersFor(binding)) return undefined
    const fingerprints = fingerprintsFromLeft(listing.entries)
    if (fingerprints.length <= 1) return undefined // 单季：没有跨季撞车这回事，不必分区
    if (!this.deps.resolveSeasons) {
      throw new ValidationError('多季绑定归档需要季归属解析器（resolveSeasons 未接线）——不许退回单锅匹配，那会把跨季同期号的文件判成同一集')
    }
    const root = claimed.replace(/\/$/, '')
    const inRoot: { name: string; size: number }[] = []
    const outOfRootDirs = new Set<string>()
    for (const f of files) {
      if (f.name.startsWith(`${root}/`)) inRoot.push({ name: f.name.slice(root.length + 1), size: f.size })
      else outOfRootDirs.add(f.name.slice(0, f.name.lastIndexOf('/')))
    }
    const groups = groupByLeafFolder(inRoot)
    const seasonOfRel = await this.deps.resolveSeasons(binding.id, groups, fingerprints)
    const seasonOfFolderAbs = new Map<string, number | null>(
      [...seasonOfRel].map(([rel, s]) => [rel === '' ? root : `${root}/${rel}`, s] as const),
    )
    for (const dir of outOfRootDirs) seasonOfFolderAbs.set(dir, null)
    // 活体核对用的那一行：季归属判错时，预览里的错落点全从这里能追回去。
    this.deps.log(`[reconcile] 季归属：${[...seasonOfFolderAbs].map(([d, s]) => `${d}→${s == null ? '未定' : `S${String(s).padStart(2, '0')}`}`).join('、')}`)
    const spec = resolveSpec(binding)
    return {
      match: (l, r) => matchBySeasonResolved(spec, l, r, seasonOfFolderAbs),
      unresolvedSeasonDirs: new Set([...seasonOfFolderAbs].filter(([, s]) => s == null).map(([d]) => d)),
      // 同一张表，规划器那侧还要用它给纯享剪辑定季（见 `PlanInput.seasonOfDir`）。
      seasonOfDir: seasonOfFolderAbs,
    }
  }

  /**
   * 落一条运行记录到 `reconcile_runs` 并原样返回（进 API 响应）——「错误是行，不是日志」。
   *
   * `trigger` 由**调用点**给，不在这里从 `mode` 猜：定时轮和人工都能是 preview/execute 两种 mode，
   * 猜出来的答案会在面板展开（手动 preview）那一格恰好反过来，而健康闸正是拿它挑基线的。
   */
  private recordRun(show: ReconcileShowConfig, mode: 'preview' | 'execute', trigger: RunTrigger, outcome: PlanOutcome, errors: RunError[], gated?: GateVerdict, runId?: string): RunRecord {
    const record: RunRecord = {
      // 执行那条路上 runId **必须先于执行生成**并原样传进来：溯源行盖的就是它，
      // 账本这边另铸一个的话，`undoRun(ledger.runId)` 会查到一条空的运行——撤不回任何东西，
      // 而且不报错（那个 id 在库里确实找不到行）。
      runId: runId ?? newRunId(),
      at: new Date().toISOString(),
      show: show.id,
      mode,
      trigger,
      counts: outcome.counts,
      conservation: outcome.conservation,
      authority: outcome.authority,
      ...(gated ? { gated } : {}),
      rows: outcome.rows,
      // 没有第二货架的绑定（影视）压根没跑过这一趟，字段整个缺席——别落一条 `checked: 0` 的空账。
      ...(outcome.secondaryReview.checked ? { secondaryReview: outcome.secondaryReview } : {}),
      errors,
      ...(outcome.ambiguities.length ? { ambiguities: outcome.ambiguities } : {}),
    }
    this.runs.append(record)
    return record
  }

  private countsFor(plan: PlanAction[], shelves: Shelves): Counts {
    return countsOf(plan, shelves)
  }

  private execDeps(runId?: string): ExecDeps {
    // decisions 必接：整理的搬运会改路径，而决定行的组合键里拼着路径（掉钉，见 migratePath 头注）。
    return {
      alist: this.deps.alist, provenance: this.provenance, decisions: this.decisions, log: this.deps.log,
      ...(runId ? { runId } : {}),
    }
  }

  /**
   * 一条绑定同一时刻只有一轮在跑（spec 2026-09-03 §4）。
   *
   * **两个入口会同时抄起同一条绑定**：定时轮 `netdisk-reconcile` 和追更循环 `netdisk-follow`。
   * 两轮交错的表现不是报错，是「A 规划时看到的现状，动手时已经被 B 改掉了」——幻影 move、
   * 目标目录 403 撞名、以及最坏的一种：B 刚把文件搬进季目录，A 手里那份旧快照仍认为它在分享
   * 子目录里，于是把"清单里没有它"的结论安在一份其实已经归好位的文件上。
   *
   * 键是 **bindingId 不是 showId**：两个 show 可以指着同一条绑定，而真正被并发改坏的是网盘那一片。
   * 链在上一个 promise 之后（失败也接着排，`catch` 掉前一轮的错——它是前一轮调用方的事）；
   * 收尾时若 map 里还是自己就删掉，免得这张表随绑定数只增不减。
   */
  private readonly locks = new Map<string, Promise<unknown>>()

  private withBindingLock<T>(bindingId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(bindingId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.locks.set(bindingId, next)
    return next.finally(() => {
      if (this.locks.get(bindingId) === next) this.locks.delete(bindingId)
    })
  }

  async preview(showId: string): Promise<PreviewResult> {
    return this.previewShow(this.showOrThrow(showId))
  }

  /**
   * **整理管线眼里的权威清单**（节目单），只读：不扫网盘、不规划、不动文件。取数走的是
   * `planFor` 一模一样的那条路（`listLeft(binding.left)`），所以它答的就是规划当时看到的
   * 那份清单；pin 不带——那是匹配层的输入，不改变清单成员。
   *
   * 这扇门是给探针 / 排错 / 将来的 hover card 用的：**要查权威清单一律从这里读**。
   * 别拿 `/api/items` 顶替——那条路上挂着播放投影（付费集在网盘没配上时，整条音频被换成一张
   * 封面图，时长与 track_id 随之消失），它回答的是"前端此刻看到什么"，不是"库里存了什么"。
   * 照它判断必然得出假结论，真事故：21 条付费集被误判"无时长"（2026-08-02）。
   */
  async authority(showId: string): Promise<AuthorityView> {
    return this.authorityOf(this.showOrThrow(showId))
  }

  /** 同上，按绑定取（影视那档原地模式没有 show 配置，见 `showForBinding`）。 */
  async authorityForBinding(bindingId: string): Promise<AuthorityView> {
    return this.authorityOf(this.showForBinding(bindingId))
  }

  /**
   * 同上，**直接按订阅取**——不要求这条流已经配过整理、也不要求它有绑定。
   *
   * 它服务的正是「还什么都没配」那一刻的问题：**这条订阅该用整理还是该挂载**。答案是
   * `stats.needsSupply`（源站放不出来的集数）：>0 才有东西要从网盘配上去。上面两扇门都答不了它
   * ——都得先有配置，而配置正是用户还没决定要不要建的那个东西。
   *
   * 走的是同一个 `listLeft`，所以清单口径与整理真跑起来时看到的完全一致（这也是不另写一份计数的
   * 原因：两份口径 = 两个真相源）。
   */
  async authorityForStream(streamId: string): Promise<AuthorityView> {
    // `title` 是绑定上给人看的名字，取清单这条路一个字都不读它（读的只有 streamId）——
    // 这里没有绑定，也就没有名字可给，留空。
    return viewOf(await this.deps.listLeft({ kind: 'stream', streamId, title: '' }))
  }

  private async authorityOf(show: ReconcileShowConfig): Promise<AuthorityView> {
    return viewOf(await this.deps.listLeft(this.bindingOrThrow(show).left))
  }

  /** 观察档也可显式调（首轮用户确认后）。 */
  async execute(showId: string): Promise<ExecResult> {
    return this.executeShow(this.showOrThrow(showId))
  }

  /**
   * **任意一条绑定的整理**（不需要在整理面板里配过 show）：合成一份"原地模式"的临时配置走同一条
   * planFor/preview/execute。影视的一键去重就是这个——播客整理的退化配置（无暂存区、无第二货架），
   * 不是平行实现。账本照落，`show` 字段记 `binding:<id>` 以便回查。
   */
  async previewBinding(bindingId: string): Promise<PreviewResult> {
    return this.previewShow(this.showForBinding(bindingId))
  }

  async executeBinding(bindingId: string, opts: ExecuteOptions = {}): Promise<ExecResult> {
    return this.executeShow(this.showForBinding(bindingId), opts)
  }

  /** `showOrThrow` 的布尔版——"这个串指得到一条 show 吗"。工具面据此在 show 与绑定之间分诊
   *  （`resolveReconcileRef`）；**必须复用同一个判据**，另写一份 = 两边对同一个名字答案不一样。 */
  hasShow(ref: string): boolean {
    try {
      this.showOrThrow(ref)
      return true
    } catch {
      return false
    }
  }

  showForBinding(bindingId: string): ReconcileShowConfig {
    const binding = this.deps.getBinding(bindingId)
    if (!binding) throw new Error(`unknown binding: ${bindingId}`)
    return {
      id: `binding:${bindingId}`,
      label: binding.left.title,
      bindingId,
      sourceDirs: [], // 原地模式：只对绑定目录自己的文件规划留哪份/删哪份
      subShows: [],
      autoExecute: false,
    }
  }

  private async previewShow(show: ReconcileShowConfig): Promise<PreviewResult> {
    // 预览也进锁：它读的是"此刻网盘长什么样"，而另一轮执行正在改它——不锁就会拿到一份
    // 搬到一半的快照，给人看的清单里出现幻影（那正是 refresh=true 想躲掉的同一类问题）。
    return this.withBindingLock(show.bindingId, async () => {
      // 认集器只造一次、复用在 plan 和 key 上——同一份规则，没有分叉的余地，重造第二份纯粹是浪费。
      const identity = this.identityFor(show)
      const { outcome, errors, shelves, seasonOfDir } = await this.planFor(show, identity)
      // UI 豁免走 decisions 端点需要按集身份传 key（不是文件名）——预览响应顺带附上,
      // 前端不许自己重算集身份（唯一真相源是共享认集器）。
      const withKey = outcome.actions.map((a) => ({ ...a, key: identity(a.src.name).key }))
      return {
        plan: withKey,
        counts: this.countsFor(outcome.actions, shelves),
        shelves,
        sourceDirs: sourceDirsOf(show),
        ledger: this.recordRun(show, 'preview', 'manual', outcome, errors),
        ...(seasonOfDir ? { seasonOfDir: Object.fromEntries(seasonOfDir) } : {}),
      }
    })
  }

  private async executeShow(show: ReconcileShowConfig, opts: ExecuteOptions = {}): Promise<ExecResult> {
    return this.withBindingLock(show.bindingId, async () => {
      const { outcome, errors, shelves, listing } = await this.planFor(show, this.identityFor(show))
      // runId **先于执行**生成：溯源行要盖着它，账本也要报同一个，`undoRun` 才有整轮可撤。
      const runId = newRunId()
      // 无人值守那条路（追更循环）过闸：基线是"最近一轮被接受过的"，不是"上一轮"（见 latestAccepted）。
      const gate = opts.gated
        ? gateAuthority(this.runs.latestAccepted(show.id)?.authority, outcome.authority, listing.truncated === true)
        : null
      if (gate) {
        // 闸住不是"跳过"：照样落一条 preview 账，每条本该执行的动作都在里面，用户看得见躲过了什么。
        // trigger 记 `scheduled` —— 它就是定时/无人值守那条路，下一轮的基线判据才认得出它不算数。
        const ledger = this.recordRun(show, 'preview', 'scheduled', outcome, errors, gate, runId)
        return {
          moved: 0, deleted: 0, renamed: 0, removedDirs: 0,
          pending: this.countsFor(outcome.actions, shelves).pending,
          errors: [], ledger, runId,
        }
      }
      const res = await executePlan(outcome.actions, this.execDeps(runId), {
        losers: opts.losers ?? true,
        // 分享转存落进 `<作品目录>/<分享子文件夹>/`，认领的集搬进季目录后那个壳就空了。
        // 只有影视档有这个形状——播客的来源目录是用户自己的暂存区，不许顺手删。
        ...(seasonFoldersFor(this.bindingOrThrow(show)) ? { cleanupEmptiedDirs: { root: shelves.claimed } } : {}),
      })
      const ledger = this.recordRun(show, 'execute', opts.gated ? 'scheduled' : 'manual', outcome, [...errors, ...execErrors(res.errors)], undefined, runId)
      return { ...res, ledger, runId }
    })
  }

  async undo(provenanceId: string): Promise<void> {
    await undoMove(provenanceId, this.execDeps())
  }

  /**
   * 这一轮动的是哪条绑定。**从账本反查，不从溯源行的路径猜**：溯源行只记路径，猜绑定猜错的代价
   * 是锁错一条（等于没锁）；而账本每一轮都记着 `show`，`binding:<id>` 那种是原地模式合成的配置。
   * 撤销与"执行完再同步一次"两处共用它——两边各写一份反查迟早分家。
   */
  bindingOfRun(runId: string): string | undefined {
    const show = this.runs.get(runId)?.show
    if (!show) return undefined
    if (show.startsWith('binding:')) return show.slice('binding:'.length)
    return this.config.shows.find((s) => s.id === show)?.bindingId
  }

  /**
   * 整轮撤销：这一轮盖着 `runId` 的溯源行按写入倒序走回去（move 搬回、rename 改回、rmdir 重建；
   * delete 撤不了，只计进 `skipped`——回收站得用户自己捞）。
   *
   * **进按绑定的那把锁**：它改的是和执行同一片网盘。不锁的表现不是报错——撤销把文件搬回分享
   * 子目录的同一刻，另一轮执行手里那份快照仍认为它在季目录里，于是幻影 move、撞名 403，
   * 以及最坏的那种：把"清单里没有它"的结论安在一份其实已经归好位的文件上（同 `withBindingLock` 头注）。
   * 绑定反查不到（账本里没有这一轮）时照旧裸撤——撤回用户点过的那些行比因为查不到而拒绝要紧，
   * 但要在日志里说清为什么没锁。
   */
  async undoRun(runId: string): Promise<{ undone: number; skipped: number }> {
    const bindingId = this.bindingOfRun(runId)
    if (!bindingId) {
      this.deps.log(`[reconcile] undoRun ${runId}: 账本里查不到这一轮属于哪条绑定，本次撤销不进绑定锁`)
      return undoRunActions(runId, this.execDeps())
    }
    return this.withBindingLock(bindingId, () => undoRunActions(runId, this.execDeps()))
  }

  /** 运行账本，新→旧（审计/排错的读口）。**健康闸的基线不从这儿读**——它要的是"最近一轮被接受的"，
   *  走 `RunLedger.latestAccepted`（手动预览、被闸的轮次都不算基线）。 */
  listRuns(opts: { show?: string; limit?: number } = {}): RunRecord[] {
    return this.runs.list(opts)
  }

  listProvenance(limit?: number): ProvenanceEntry[] {
    return this.provenance.list(limit)
  }

  setDecision(key: string, verdict: 'exempt' | 'tombstone' | null, note?: string): void {
    if (verdict === 'exempt') this.decisions.exempt(key, note ?? '')
    else if (verdict === 'tombstone') this.decisions.tombstone(key)
    else this.decisions.revoke(key)
  }

  /**
   * 人裁「这**份**文件不是那一集」（`duration-collision` 的出口）。**只写账本，不动文件**：
   * 下一轮预览里它按"清单里没有它"走第二货架，那条 move 照样要人点执行。
   * 组合键由 `DecisionStore` 拼——前端只回传它从预览里拿到的 `collidesWith` + `src.path`。
   */
  setNotEpisode(leftKey: string, path: string, on = true, note?: string): void {
    this.decisions.setNotEpisode(leftKey, path, on, note)
    if (on) this.suggestions.answer(path, 'not-episode', leftKey)
  }

  /**
   * 人裁「这份文件**就是**那一集」——同一个问句的另一半答案。**只写账本，不动文件**：
   * 它下一轮变成匹配层的 pin，认领与搬运照常由匹配器 → 归档器那条唯一的路走完，
   * 该出的 move 仍在预览里等人点。
   *
   * `note` 透传给 `DecisionStore`——裁决器（`adjudicate/service.ts`）用它落 `llm:<runId>`，
   * 人工调用不传，落 null。
   */
  setIsEpisode(leftKey: string, path: string, on = true, note?: string): void {
    this.decisions.setIsEpisode(leftKey, path, on, note)
    if (on) this.suggestions.answer(path, 'is-episode', leftKey)
  }

  /**
   * 整批撤回裁决器某一轮写下的决定（`note` 前缀 `llm:<runId>`）——「模型裁的」随时能一把抹掉，
   * 不牵动人工那些。返回撤了几条，供 HTTP/MCP 回执报数。
   */
  revokeAdjudication(runId: string): number {
    return this.decisions.revokeByNotePrefix(`llm:${runId}`)
  }

  /**
   * 人裁「这两份留哪一份」（第二货架上比不出高下那一档的出口）。**只写账本，不动文件**：
   * 下一轮预览里它变成一条 `delete-loser`/`replace`，照样进「将删清单」等人点确认。
   *
   * 两侧都要传，组合键由 `DecisionStore` 拼——这条决定只对**这一对**成立，留下那份将来
   * 不在了它就自动失效（否则一条保护性的决定会退化成删除依据）。
   */
  setPreferred(kept: string, loser: string, on = true): void {
    this.decisions.setPreferred(kept, loser, on)
  }

  listDecisions() {
    return this.decisions.list()
  }

  /**
   * 「AI 建议 vs 人最终选择」的账本 + 全表汇总。
   *
   * **只读得到历史数据**：AI 那半截的写入方已经没有了（判读搬进了对话——模型自己拿
   * `netdisk_transcribe` 听、自己判、用决定端点落账），所以这张表不再长新行。人那半截照旧由
   * `setIsEpisode`/`setNotEpisode` 回填，存量里还没答的行仍答得上。
   */
  listSuggestions(q?: SuggestionQuery) {
    return this.suggestions.list(q)
  }

  /** 全部 show：autoExecute? execute : preview；汇总通知（每 show 一条 dedupeKey:reconcile:<show>）。 */
  async runScheduled(): Promise<TaskOutcome> {
    const lines: string[] = []
    // `gated` 在这里不是冗余：这一格的 `counts` 记的是**本该动的**那些，`autoExecute` 记的是配置，
    // 两者在闸住的那一轮和真执行的那一轮长得一模一样——只读 detail 的人会当搬运真发生了。
    const detail: Record<string, { counts: Counts; claimed: number; secondary: number; autoExecute: boolean; runId: string; gated?: GateReason }> = {}
    for (const show of this.config.shows) {
      // 一个 show 的货架解不出来（绑定没了 / 还没有下架 stream / 地址撞了来源）不该拖垮整轮：
      // 它自己那条通知如实报出去,别的 show 照跑。**不许跳过后静默**——静默等于这个节目从此不再整理
      // 而没人知道。
      // **规划到执行之间必须一直握着这条绑定的锁**：中间被追更循环插进来搬走几份，
      // 我们手里这份快照就成了幻影（见 withBindingLock 头注）。所以整段进一次锁，
      // 通知/汇总那些纯读的收尾留在锁外。
      let planned
      try {
        planned = await this.withBindingLock(show.bindingId, async () => {
          const p = await this.planFor(show, this.identityFor(show))
          const counts = this.countsFor(p.outcome.actions, p.shelves)
          // 健康闸：本轮清单和**最近一轮被接受过的**那一轮账本里记的比一次（两个数来源独立）。
          // 基线不是"上一轮"——面板每展开一个节目就 POST 一次手动 preview，它记的是缩水后的数字；
          // 被闸住的那一轮同理。认它们当基线，闸就变成缩水 vs 缩水 = 放行（判据见 `latestAccepted`）。
          // 只挡定时轮的执行——观察档本来就不动文件，闸不闸没区别，所以只在 autoExecute 上求值。
          const prev = this.runs.latestAccepted(show.id)?.authority
          const gate = show.autoExecute ? gateAuthority(prev, p.outcome.authority, p.listing.truncated === true) : null
          // runId 先于执行生成，溯源行与账本共用它——定时轮写下的行同样要能整轮撤回。
          const runId = newRunId()
          if (show.autoExecute && !gate) {
            // 定时轮**永不**自动执行确认档（`delete-loser` / `replace`，spec §5）：删不可逆，比搬运高
            // 一档，必须有人在预览里看过一眼"删这份、留那份"才算数。autoExecute 管的是搬运与字节全等重复。
            const res = await executePlan(p.outcome.actions, this.execDeps(runId), {
              losers: false,
              ...(seasonFoldersFor(this.bindingOrThrow(show)) ? { cleanupEmptiedDirs: { root: p.shelves.claimed } } : {}),
            })
            p.errors.push(...execErrors(res.errors))
          }
          const mode = show.autoExecute && !gate ? 'execute' : 'preview'
          return { counts, gate, outcome: p.outcome, record: this.recordRun(show, mode, 'scheduled', p.outcome, p.errors, gate ?? undefined, runId) }
        })
      } catch (e) {
        const title = `${show.label}：整理跑不了——${e instanceof Error ? e.message : String(e)}`
        lines.push(title)
        this.deps.events?.append({ type: 'netdisk.reconcile', severity: 'warn', title, dedupeKey: `reconcile:${show.id}` })
        continue
      }
      const { counts, gate, outcome, record } = planned
      const claimed = counts.moveClaimed
      const secondary = counts.moveSecondary
      if (gate) {
        // 闸住的那一轮**照样落账**（上面那条 preview 记录，本该执行的动作一条不少），通知里把
        // 「本来会动多少」原样说出来——只说"清单变了"，用户判断不了这一轮到底躲过了什么。
        const title = `${show.label}：清单变了（${gate.detail}），本轮只观察不动——${counts.move} 条搬运、${counts.deleteRedundant} 条删除都没做`
        lines.push(title)
        // 一个动作都没有 = 这一闸没拦下任何东西，没什么可告警的。空清单那一档天天如此（一条刚建、
        // 还没采集完的订阅就长这样），逐夜 warn 是纯噪音，而噪音会把真拦下了整库搬运的那一条淹掉。
        // 账照落、summary 照说——只是不去敲通知中心。
        if (Object.values(counts).some((n) => n > 0)) {
          this.deps.events?.append({ type: 'netdisk.reconcile', severity: 'warn', title, dedupeKey: `reconcile:${show.id}` })
        }
        detail[show.id] = { counts, claimed, secondary, autoExecute: show.autoExecute, runId: record.runId, gated: gate.reason }
        continue
      }
      const verb = show.autoExecute ? '归档' : '观察到'
      // 账本不平是**机制自己报的账**，不是猜的——直接进通知抬头，别只躺在 reconcile_runs 里。
      const warn = outcome.conservation ? '' : `，账本不平（${outcome.counts.input} 个文件对不上各筐之和）`
      // 换正主要单独说:它是"等你点头"的建议,混进 pending 数里用户不知道有几条其实已经有结论了。
      const swap = counts.replace > 0 ? `，${counts.replace} 条建议换正主` : ''
      // 冗余删也要单独说:这一档**定时轮真的会删**（不进确认档），不说出来就是背着人删文件。
      const redundant = counts.deleteRedundant > 0 ? `，${counts.deleteRedundant} 份免费集副本${show.autoExecute ? '已删' : '待删'}` : ''
      // 下架货架回头看:动了它才说。这一趟每轮都跑，逐轮报"复核 N 份、0 条"是纯噪音。
      const reviewed = outcome.secondaryReview.rows.length
      const review = reviewed > 0 ? `，下架货架复核出 ${reviewed} 条回流/清理` : ''
      const title = `${show.label}：${verb} ${counts.move} 条（付费 ${claimed}/下架 ${secondary}），${counts.pending} 条待定${swap}${redundant}${review}${warn}`
      lines.push(title)
      detail[show.id] = { counts, claimed, secondary, autoExecute: show.autoExecute, runId: record.runId }
      this.deps.events?.append({ type: 'netdisk.reconcile', severity: 'info', title, dedupeKey: `reconcile:${show.id}` })
    }
    return { summary: lines.join('；') || '无归档 show 配置', detail }
  }
}

/**
 * `executePlan` 的错误串 → 账本的错误行。前缀是它自己写的
 * （`delete <path>: …` / `rename <path>: …` / `rmdir <dir>: …` / `move A→B: …`）。
 *
 * **执行器加一种动作，这里就要加一行**：`move` 是兜底，漏了不会报错——改名失败会被记成
 * "搬运失败"，读账的人照着去查目标目录撞名，而真因在源目录的名字上。
 */
const ERROR_STAGES = [['delete ', 'delete'], ['rename ', 'rename'], ['rmdir ', 'rmdir']] as const

function execErrors(errors: string[]): RunError[] {
  return errors.map((detail) => ({
    stage: ERROR_STAGES.find(([prefix]) => detail.startsWith(prefix))?.[1] ?? ('move' as const),
    detail,
  }))
}
