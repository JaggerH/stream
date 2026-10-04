import type Database from 'better-sqlite3'
import type { MappingStore } from '../mapping-store.ts'
import type { NetdiskService } from '../sync.ts'
import type { MappingSet } from '../types.ts'
import type { EventInput } from '../../events/store.ts'
import type { VideoSearchResult, Release } from '../../video/types.ts'
import { parseShareLink } from '../../video/parse.ts'
import { ShareLedger, FollowRunLedger } from './ledger.ts'
import { PendingShareLedger } from './pending-shares.ts'
import { normalizeLandingDir } from '../save-binding.ts'
import { missingAired, nextCheckAt, rankCandidates, pickFiles, type Candidate } from './plan.ts'
import type { FollowRunRecord, FollowCandidate, ShareClient, ShareRow, ShareTreeFile } from './types.ts'
// 类型 only：`AdjudicationRun` 的实值实现在 `adjudicate/service.ts`，那边反过来运行时 import
// 本文件的 `landingPathOf`——`import type` 编译期整段擦除，不构成运行时循环依赖。
import type { AdjudicationRun } from '../adjudicate/service.ts'

export interface FollowDeps {
  db: Database.Database
  store: MappingStore
  netdisk: Pick<NetdiskService, 'sync' | 'bind' | 'matchExternalFiles' | 'bindingForTmdb'>
  shares: ShareClient
  /** 资源搜索（批量路）。thunk：搜索域比网盘域晚挂。 */
  videoSearch: () => ((q: string) => Promise<VideoSearchResult>) | undefined
  mkdir: (path: string) => Promise<void>
  /** 绑定级归位（`ReconcileService.executeBinding`）。结构类型，别 import 整个 ReconcileService。
   *  缺席 = 跳过归位那一步（记一行 `archive: 归档器未装配`，不算故障、也不冻退避）。 */
  reconcile?: {
    executeBinding: (id: string, opts: { losers: boolean; gated: boolean }) => Promise<{
      moved: number; deleted: number; renamed: number; removedDirs: number; errors: string[]; runId: string
      ledger: { gated?: { reason: string; detail: string } }
    }>
  }
  events?: { append: (e: EventInput) => unknown }
  now?: () => Date
  /** 转存后等文件上货架的间隔（可注入：单测给假的）。 */
  sleep?: (ms: number) => Promise<void>
  /**
   * 轮末裁决器（spec 2026-09-03-netdisk-llm-adjudicator §3）。结构类型，别 import 整个
   * `AdjudicationService`——追更这一层只用得上 `run` 这一个方法。**缺席 = 跳过**（记一行
   * `adjudicate: 裁决器未装配`不算——追更没有它照样成立，只是留下的 pending 卡/候选不会被
   * 自动裁一轮，不算故障、也不冻退避）。
   */
  adjudicate?: {
    run: (setId: string, opts: { trigger: 'follow' | 'manual'; losers: boolean; followCandidates?: FollowCandidate[] }) => Promise<AdjudicationRun>
  }
  log: (m: string) => void
}

/**
 * 分享内文件按父目录分组落地的目的地相对路径（`<subdir>/<分享内父目录>`，父目录为空则原样）。
 * **具名、只此一份**：`saveFrom` 的分组落地键与追更候选卡片带给裁决器的 `subdir` 必须是同一个
 * 算法，两处各算一遍就是两个脑——裁决器落账时按它拼出的落地路径要与文件实际落地的位置一致，
 * 否则 `is-episode` 决定钉的是一个文件从来没到过的路径，下一轮匹配永远命不中这枚 pin。
 */
export function landingSubdirFor(baseSubdir: string, sharePath: string): string {
  const parent = sharePath.includes('/') ? sharePath.slice(0, sharePath.lastIndexOf('/')) : ''
  return parent ? `${baseSubdir}/${parent}` : baseSubdir
}

/**
 * 分享内文件转存后的绝对落地路径：`<绑定认领目录>/<landingSubdirFor 算出的那个 subdir>/<文件名>`。
 * **只算路径，不做任何 I/O**——裁决器（`adjudicate/service.ts`）用它给追更候选的 `is-episode`
 * 决定钉上正确的绝对路径，与真正转存时文件落地的位置必须是同一个拼法。
 */
export function landingPathOf(dirPath: string, subdir: string, sharePath: string): string {
  const name = sharePath.slice(sharePath.lastIndexOf('/') + 1)
  return `${dirPath.replace(/\/$/, '')}/${subdir}/${name}`
}

/** 转存后最多同步几轮、每轮间隔——夸克转存是异步任务，AList 再慢一拍。总预算约一分钟。 */
export const RESYNC_ATTEMPTS = 6
export const RESYNC_INTERVAL_MS = 10_000

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
const cnNum = (n: number) => (n <= 10 ? CN[n] : n < 20 ? `十${CN[n - 10]}` : String(n))
const seasonOf = (leftKey: string) => Number(/:S(\d+)E/.exec(leftKey)?.[1] ?? 0)
const matchedCount = (set: MappingSet) => set.entries.filter((e) => e.rightFile && (e.status === 'auto' || e.status === 'confirmed')).length

export class FollowService {
  private readonly shares: ShareLedger
  private readonly pending: PendingShareLedger
  private readonly runs: FollowRunLedger
  private readonly now: () => Date
  /** 此刻有哪几条绑定正在跑一轮。**进程内的一本名册**（不落库）：它防的是同一个进程里把同一条
   *  绑定开两轮（工具面 fire-and-return 之后，模型嫌慢再点一次就是这个形状），两轮并发会对着
   *  同一个目录转存 + 归档，账本和文件都要打架。 */
  private readonly running = new Set<string>()
  constructor(private readonly deps: FollowDeps) {
    this.shares = new ShareLedger(deps.db)
    this.pending = new PendingShareLedger(deps.db)
    this.runs = new FollowRunLedger(deps.db)
    this.now = deps.now ?? (() => new Date())
  }

  private setOrThrow(setId: string): MappingSet {
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`unknown binding: ${setId}`)
    return set
  }

  /** 这条绑定能不能追更（只有 TMDb 剧集能）。`setEnabled` 那句报错和它是**同一个判据**——
   *  分家的表现是"开关开得上、view 却说不能追更"，而没有一处会喊。 */
  static followable(set: MappingSet): boolean {
    return set.left.kind === 'tmdb' && set.left.media === 'tv'
  }

  /** 这条绑定此刻是不是正在跑一轮（`startFollowRun` 的防重入闸门读它）。 */
  isRunning(setId: string): boolean {
    return this.running.has(setId)
  }

  /** 这个网盘我们有没有分享客户端（`shares.supports` 的公有薄封装，不是第二份名单）。 */
  supports(netdisk: string): boolean {
    return this.deps.shares.supports(netdisk)
  }

  setEnabled(setId: string, enabled: boolean): MappingSet {
    const set = this.setOrThrow(setId)
    if (!FollowService.followable(set)) throw new Error('只有 TMDb 剧集绑定能追更')
    set.follow = { ...(set.follow ?? { dryRuns: 0 }), enabled, ...(enabled ? { nextCheckAt: undefined } : {}) }
    this.deps.store.save(set)
    return set
  }

  /** 没绑定的剧要追：建作品目录 + 空绑定（follow 开）。已有绑定就只开开关。 */
  async ensureBinding(ref: { id: string; media: 'tv'; title: string; year?: number }, dirPath: string): Promise<MappingSet> {
    const existing = this.deps.netdisk.bindingForTmdb(ref.id, ref.media)
    if (existing) return this.setEnabled(existing.id, true)
    await this.deps.mkdir(dirPath)
    const set = await this.deps.netdisk.bind({ left: { kind: 'tmdb', ...ref }, dirPath })
    return set.follow?.enabled ? set : this.setEnabled(set.id, true)
  }

  /**
   * 验一条分享：还活着吗、里面有什么。**只读**——不落账本、不转存、不碰绑定。
   *
   * 它就是回访那一步用的同一个 `shares.list`（不是第二份判据）：一条分享在这里报 `alive`，
   * 追更循环看到的就是 `alive`。不支持的网盘要抛，不能报成 `not-usable`——"这个盘我们不认"
   * 和"这条分享死了"是两回事，混成一格调用方就会去删一条其实好好的分享。
   */
  async inspectShare(netdisk: string, pwdId: string, passcode?: string): ReturnType<ShareClient['list']> {
    if (!this.deps.shares.supports(netdisk)) throw new Error(`不支持的网盘：${netdisk}`)
    return this.deps.shares.list(netdisk, pwdId, passcode)
  }

  recordShare(setId: string, netdisk: string, pwdId: string, passcode: string | undefined, origin: 'manual' | 'search'): void {
    const prev = this.shares.get(setId, netdisk, pwdId)
    // 已有的行不重置来源/账本，但「这次补了个提取码」要收下——否则用户第二次录入等于白录。
    if (prev) { if (passcode && !prev.passcode) this.shares.upsert({ ...prev, passcode }); return }
    this.shares.upsert({ setId, netdisk, pwdId, ...(passcode ? { passcode } : {}), origin, addedAt: this.now().toISOString(), seenFiles: [], savedFids: [] })
  }

  /**
   * 转存成功那一刻记一条**待认领**分享（落点目录 + 分享坐标）。转存和建绑定是两次独立请求，
   * 那一刻常常还没有绑定可挂（用户没带 `bind`），而分享链接过完手就没了——不记，这条分享
   * 就再也进不了 `binding_shares`，下次同一部剧缺集还得把它重新搜一遍。
   *
   * 与 `recordShare` 的分工：那条是「已经知道归哪条绑定」，这条是「还不知道」。
   */
  recordPendingShare(netdisk: string, pwdId: string, passcode: string | undefined, dirPath: string): void {
    this.pending.record({ netdisk, pwdId, ...(passcode ? { passcode } : {}), dirPath, savedAt: this.now().toISOString() })
  }

  /**
   * 认领：这条绑定的落地目录命中哪几条待认领分享，就把它们领进 `binding_shares`（此后每轮回访）。
   * 返回领了几条。
   *
   * **为什么挂在这里、而不是挂在建绑定/rebind 的路由上**：绑定还能从 `ensureBinding`、导入包、
   * 转存闭环好几处产生，挂在某几个路由上必漏一处，而漏掉不报错——只是那条分享永远没人领。
   * 这里是所有消费者读账本之前的**同一道口**（每轮开跑 + `view`），一处就覆盖全部来路。
   */
  claimPendingShares(setId: string): number {
    const set = this.deps.store.get(setId)
    // 空 right.path = 还没认盘的 pending 绑定：没有落地目录可比，别拿空串去撞。
    if (!set?.right?.path) return 0
    const rows = this.pending.claim(normalizeLandingDir(set.right.path), this.now())
    for (const r of rows) this.recordShare(setId, r.netdisk, r.pwdId, r.passcode, 'manual')
    return rows.length
  }

  /** 跑了哪些 setId。单条整轮失败只记日志，不打断其余。 */
  async scanDue(): Promise<string[]> {
    const now = this.now().toISOString()
    const due = this.deps.store.list().filter((s) => s.follow?.enabled && this.dueAt(s) <= now)
    const ran: string[] = []
    for (const s of due) {
      try { await this.runOnce(s.id, 'scheduled'); ran.push(s.id) }
      catch (e) { this.deps.log(`[follow] ${s.id} 整轮失败：${(e as Error).message}`) }
    }
    return ran
  }

  /**
   * 这条绑定什么时候该查——**按当前分集现算，不信上一轮存下的数**。`nextCheckAt` 是纯函数，输入
   * 是「分集 + 无果轮数 + 上一轮时刻」；上一轮存下的值只是那一刻的答案，而分集会在两轮之间变：
   * 人手补上了缺集、裁决器认出了一集、TMDb 给未定档的集补了日期、或者今天恰好是播出日。装配期
   * 取的值是冻住的答案（AGENTS.md），这里同理——真事：喜剧之王单口季上一轮算成 24h 退避（当时
   * S02 还缺两集），当晚缺集被引擎配上、次日两集新播，按现状该当天 20:00 查，存下的数说次日深夜。
   * 现算出来与存下的不同就顺手写回，面板显示的「下次检查」才是真的。没排过（从没跑过一轮、或刚
   * 打开开关时 `setEnabled` 把 nextCheckAt 清掉）= 立刻到期，这条不变。
   */
  private dueAt(set: MappingSet): string {
    const f = set.follow!
    if (!f.nextCheckAt) return ''
    if (!f.lastCheckAt) return f.nextCheckAt
    // 锚在上一轮，「已播」按真正的今天判（见 `nextCheckAt` 头注）。
    const next = nextCheckAt({ entries: set.entries, dryRuns: f.dryRuns, now: new Date(f.lastCheckAt), today: this.now().toISOString().slice(0, 10) }).toISOString()
    if (next !== f.nextCheckAt) { set.follow = { ...f, nextCheckAt: next }; this.deps.store.save(set) }
    return next
  }

  view(setId: string): {
    follow?: MappingSet['follow']
    missingAired: string[]
    upcoming: number
    shares: Array<Pick<ShareRow, 'pwdId' | 'netdisk' | 'origin' | 'validity' | 'lastCheck'>>
    runs: FollowRunRecord[]
  } {
    const set = this.setOrThrow(setId)
    // 先领一遍：面板要能看见「我刚转存的那条分享已经归这条绑定了」，而不是等到下一轮才出现。
    this.claimPendingShares(setId)
    const today = this.now().toISOString().slice(0, 10)
    return {
      follow: set.follow,
      missingAired: missingAired(set.entries, today),
      upcoming: set.entries.filter((e) => !e.rightFile && !!e.airDate && e.airDate > today).length,
      shares: this.shares.list(setId).map(({ pwdId, netdisk, origin, validity, lastCheck }) => ({ pwdId, netdisk, origin, validity, lastCheck })),
      runs: this.runs.recent(setId, 10),
    }
  }

  /**
   * 一轮。**采集过程中的任何一步炸了都不向外抛**：变成 `rec.errors` 里的一行，`follow_runs` 照样
   * 落账、记录照样返回。理由是这条链路无人值守——抛出去只会变成日志里一行没人看的堆栈，而账本行
   * 会留在绑定页上。
   *
   * 唯一的例外在 try 之前：`setId` 不存在会抛。那是调用方的编程错误（不是运行时故障），
   * 没有账本行可落，也不该被当成"这轮没成"吞掉。
   */
  async runOnce(setId: string, trigger: 'scheduled' | 'manual'): Promise<FollowRunRecord> {
    // 在跑名册在**这一层**记，不在调用方：定时轮（`scanDue`）和工具面走的是同一个入口，
    // 名册记在任一侧都会漏掉另一侧那条路。
    this.running.add(setId)
    try {
      return await this.runRound(setId, trigger)
    } finally {
      this.running.delete(setId)
    }
  }

  private async runRound(setId: string, trigger: 'scheduled' | 'manual'): Promise<FollowRunRecord> {
    let set = this.setOrThrow(setId)
    const at = this.now().toISOString()
    const today = at.slice(0, 10)
    const errors: string[] = []
    const rec: Omit<FollowRunRecord, 'id'> = { setId, at, trigger, missingAired: [], revisited: [], saved: [], synced: { matchedBefore: 0, matchedAfter: 0 }, errors }
    const msg = (e: unknown) => (e as Error)?.message ?? String(e)
    let authFailed = false
    let authMessage = ''
    let syncFailed = false
    let resyncFailed = false
    // 「这轮没问到答案」——只有它冻住退避。errors 里还有另一类：问到了、答案是"这儿没有"
    // （典型是搜索没装配），那类必须让 dryRuns 照常涨，否则节奏永远停在基线上。
    let unanswered = false

    try {
      // 0. 认领待认领分享：先转存、过后才建绑定的那条路，分享就是在这一步进账本的（见
      //    `claimPendingShares`）。必须在第 2 步回访读账本之前，也必须在 sync 之前——sync
      //    炸了整轮就结束，而认领本身不依赖分集是不是新的。
      try { this.claimPendingShares(setId) } catch (e) { errors.push(`claim: ${msg(e)}`) }

      // 1. 算缺集（先 sync 拿最新的分集与配对）
      try { set = await this.deps.netdisk.sync(set) } catch (e) { errors.push(`sync: ${msg(e)}`); syncFailed = true }

      // 后面每一步都建立在「分集是新的」之上：这一口没打开就整轮结束，别拿陈旧的分集去搜、去退避。
      if (!syncFailed) {
        rec.synced.matchedBefore = matchedCount(set)
        let missing = missingAired(set.entries, today)
        rec.missingAired = missing
        const subdir = set.right.path.split('/').filter(Boolean).slice(-2).join('/')   // 'From Stream/tv-261471'

        const saveFrom = async (row: ShareRow, files: ShareTreeFile[], covers: string[]): Promise<void> => {
          // 按分享里的父目录分组落地：文件落进 `<作品目录>/<分享里的同名子文件夹>/`，不平铺到根。
          // 活体教训：根目录里已经躺着第 2 季的「第7期上」，第 3 季的「第7期上」平铺进来就撞名，
          // 而认集时靠的正是分享里那个「第三季」文件夹——落地一平铺，那条证据就没了。
          const groups = new Map<string, ShareTreeFile[]>()
          for (const f of files) {
            const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
            groups.set(parent, [...(groups.get(parent) ?? []), f])
          }
          for (const [, group] of groups) {
            const r = await this.deps.shares.save(row.netdisk, row.pwdId, {
              files: group.map((f) => ({ fid: f.fid, token: f.token, pdirFid: f.pdirFid })),
              subdir: landingSubdirFor(subdir, group[0]!.path),
              passcode: row.passcode,
            })
            if (!r.saved) {
              errors.push(`save ${row.pwdId} [${r.stage}]: ${r.message}`)
              // 登录态掉了：这一轮剩下的转存全都会撞同一堵墙，别再去敲了。
              if (r.stage === 'auth') { authFailed = true; authMessage = r.message; return }
              continue
            }
            rec.saved.push({ pwdId: row.pwdId, files: group.map((f) => f.path) })
            this.shares.upsert({ ...row, savedFids: [...new Set([...this.shares.get(row.setId, row.netdisk, row.pwdId)?.savedFids ?? row.savedFids, ...group.map((f) => f.fid)])] })
          }
          // 只要有一组转成了就把这些缺集从本轮待补里划掉——没转成的那组下一轮回访会重试（候选池是没转存过的文件）。
          if (rec.saved.some((s) => s.pwdId === row.pwdId)) missing = missing.filter((k) => !covers.includes(k))
        }
        // 本轮所有 pending 配对（分享有货、但置信度不够自动转存）——攒起来在轮末一并问裁决器
        // （spec §3 触发点之一：追更轮归档之后）。**这里只收集，不转存、不落账**——那是裁决器
        // 过闸之后的事（见轮末 `deps.adjudicate?.run` 那一段）。
        const followCandidates: FollowCandidate[] = []
        const candidateOf = async (
          key: string, files: ShareTreeFile[], share: { netdisk: string; pwdId: string; passcode?: string },
        ): Promise<Candidate> => {
          const r = await this.deps.netdisk.matchExternalFiles(set, files.map((f) => ({ name: f.path, size: f.size })))
          const assigned = new Map<string, string>()
          const byPath = new Map(files.map((f) => [f.path, f]))
          const pendingByFile = new Map<string, string[]>()
          for (const [k, a] of r.assignments) {
            // 「宁可漏拿，不乱拿」：只有 auto 的配对才算数，本函数自己不转存 pending 的。
            if (a.status === 'auto') { assigned.set(k, a.rightFile); continue }
            if (a.status === 'pending') {
              const list = pendingByFile.get(a.rightFile) ?? []
              list.push(k)
              pendingByFile.set(a.rightFile, list)
            }
          }
          for (const [relPath, candidateLeftKeys] of pendingByFile) {
            const f = byPath.get(relPath)
            if (!f) continue
            followCandidates.push({
              netdisk: share.netdisk, pwdId: share.pwdId, ...(share.passcode ? { passcode: share.passcode } : {}),
              file: f, subdir: landingSubdirFor(subdir, f.path), candidateLeftKeys,
            })
          }
          return { key, files, assigned }
        }

        if (missing.length) {
          // 2. 回访旧源。逐条独立 try：一条分享炸了不能带走其余的。
          for (const row of this.shares.list(setId)) {
            if (row.validity === 'not-usable' || !this.deps.shares.supports(row.netdisk)) continue
            let listed: Awaited<ReturnType<ShareClient['list']>>
            try { listed = await this.deps.shares.list(row.netdisk, row.pwdId, row.passcode) }
            catch (e) { errors.push(`list ${row.pwdId}: ${msg(e)}`); unanswered = true; continue }
            // unknown = 没验到（不是「验过了、不行」）：既不落 validity，也不算这轮的无果证据。
            if (listed.validity === 'unknown') { rec.revisited.push({ pwdId: row.pwdId, validity: 'unknown', newFiles: 0, picked: 0 }); continue }
            const seen = new Set(row.seenFiles.map((f) => f.fid))
            // `newFiles` 只是给人看的"这条分享比上次多了几个文件"。候选池是**没转存过的全部文件**，
            // 不是"没见过的"：上一轮见过但没配上（那时还没播）、或转存失败的文件，这轮照样要认——
            // 活体撞过：转存失败后文件已被记成 seen，回访永远跳过它，那条分享等于死了。认集很便宜。
            const newFiles = listed.files.filter((f) => !seen.has(f.fid)).length
            const unsaved = listed.files.filter((f) => !row.savedFids.includes(f.fid))
            const next: ShareRow = { ...row, lastCheck: at, validity: listed.validity, seenFiles: listed.files }
            this.shares.upsert(next)
            let picked = 0
            if (listed.validity === 'alive' && unsaved.length && missing.length && !authFailed) {
              try {
                const [choice] = pickFiles(
                  rankCandidates([await candidateOf(row.pwdId, unsaved, { netdisk: row.netdisk, pwdId: row.pwdId, ...(row.passcode ? { passcode: row.passcode } : {}) })], missing),
                  missing, 1,
                )
                if (choice) { picked = choice.files.length; await saveFrom(next, choice.files, choice.covers) }
              } catch (e) { errors.push(`revisit ${row.pwdId}: ${msg(e)}`); unanswered = true }
            }
            rec.revisited.push({ pwdId: row.pwdId, validity: listed.validity, newFiles, picked })
          }
        }

        if (missing.length && !authFailed) {
          // 3. 找新源
          const search = this.deps.videoSearch()
          if (!search) errors.push('search: 资源搜索未装配')
          else {
            // 缺集落在哪几季就搜哪几季（缺得多的先搜，最多 3 季）。只搜最小那一季是活体撞过的坑：
            // 第 2 季差三集决赛、第 3 季差九集，结果每轮都只搜第 2 季，第 3 季永远轮不到。
            const bySeason = new Map<number, number>()
            for (const k of missing) bySeason.set(seasonOf(k), (bySeason.get(seasonOf(k)) ?? 0) + 1)
            const seasons = [...bySeason.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([s]) => s)
            const title = set.left.title
            const queries = seasons.flatMap((season) => [`${title} 第${season}季`, `${title} 第${cnNum(season)}季`])
            const known = new Set(this.shares.list(setId).map((r) => `${r.netdisk}:${r.pwdId}`))
            const hits = new Map<string, { netdisk: string; pwdId: string; passcode?: string }>()
            for (const q of queries) {
              let res: VideoSearchResult
              try { res = await search(q) } catch (e) { errors.push(`search "${q}": ${msg(e)}`); unanswered = true; continue }
              const releases: Release[] = [...res.loose, ...res.shows.flatMap((s) => s.qualities.flatMap((b) => b.releases))]
              for (const rel of releases) {
                const ref = parseShareLink(rel.link)
                if (!ref || !this.deps.shares.supports(ref.netdisk) || known.has(`${ref.netdisk}:${ref.pwd_id}`)) continue
                const key = `${ref.netdisk}:${ref.pwd_id}`
                // 同一条分享被两个搜索结果带出来时，先到的提取码不能被后一条的空值抹掉。
                const passcode = hits.get(key)?.passcode || rel.password || undefined
                hits.set(key, { netdisk: ref.netdisk, pwdId: ref.pwd_id, ...(passcode ? { passcode } : {}) })
              }
            }
            const cands: Candidate[] = []
            const rows = new Map<string, ShareRow>()
            let alive = 0
            let failed = 0
            for (const hit of hits.values()) {
              const key = `${hit.netdisk}:${hit.pwdId}`
              let listed: Awaited<ReturnType<ShareClient['list']>>
              // 列不出来是「没验到」，得留一行——否则它和「验过了、不活」长得一模一样。
              try { listed = await this.deps.shares.list(hit.netdisk, hit.pwdId, hit.passcode) }
              catch (e) { errors.push(`list ${key}: ${msg(e)}`); unanswered = true; failed++; continue }
              if (listed.validity !== 'alive') continue
              alive++
              rows.set(key, { setId, netdisk: hit.netdisk, pwdId: hit.pwdId, ...(hit.passcode ? { passcode: hit.passcode } : {}), origin: 'search', addedAt: at, lastCheck: at, validity: 'alive', seenFiles: listed.files, savedFids: [] })
              try { cands.push(await candidateOf(key, listed.files, { netdisk: hit.netdisk, pwdId: hit.pwdId, ...(hit.passcode ? { passcode: hit.passcode } : {}) })) }
              catch (e) { errors.push(`match ${key}: ${msg(e)}`); unanswered = true; failed++; rows.delete(key) }
            }
            const chosen = pickFiles(rankCandidates(cands, missing), missing)
            rec.searched = { queries, hits: hits.size, alive, picked: chosen.length, failed }
            for (const c of chosen) {
              const row = rows.get(c.key)!
              this.shares.upsert(row)                       // 账本先落：分享从此有主
              if (!authFailed) await saveFrom(row, c.files, c.covers)
            }
          }
        }

        // 5. 同步 + 归位
        if (rec.saved.length) {
          // 转存是夸克那边的异步任务 + AList 的索引延迟：刚转完立刻同步，多半一个都看不到（活体：9 个文件
          // 转完 20 秒只见到 1 个）。多同步几轮，认出来了就停；全等完还没认出也照样往下走——账本会说清。
          const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
          for (let attempt = 0; attempt < RESYNC_ATTEMPTS; attempt++) {
            try { set = await this.deps.netdisk.sync(this.setOrThrow(setId)); resyncFailed = false }
            catch (e) { errors.push(`resync: ${msg(e)}`); resyncFailed = true; unanswered = true; break }
            if (matchedCount(set) > rec.synced.matchedBefore || attempt === RESYNC_ATTEMPTS - 1) break
            await sleep(RESYNC_INTERVAL_MS)
          }
        }
        // 5b. 归位（spec 2026-09-03-tv-season-archive §4）：认领的集搬进季文件夹、加编号前缀、同集落选副本删进回收站。
        //     `gated:true` 走定时轮同一道清单健康闸；`losers:true` 是用户拍板的无人介入。归档器按绑定互斥，
        //     与 netdisk-reconcile 不并发动同一目录。动了文件就再 sync 一次让 rightFile 跟上新路径。
        if (!this.deps.reconcile) errors.push('archive: 归档器未装配')
        else {
          try {
            const r = await this.deps.reconcile.executeBinding(setId, { losers: true, gated: true })
            rec.archived = { runId: r.runId, moved: r.moved, deleted: r.deleted, renamed: r.renamed, ...(r.ledger.gated ? { gated: r.ledger.gated.detail } : {}) }
            for (const e of r.errors) errors.push(`archive: ${e}`)
            if (r.moved + r.renamed + r.deleted > 0) {
              try { set = await this.deps.netdisk.sync(this.setOrThrow(setId)) }
              catch (e) { errors.push(`resync-after-archive: ${msg(e)}`); unanswered = true }
            }
          } catch (e) { errors.push(`archive: ${msg(e)}`); unanswered = true }
        }
        // 5c. 轮末裁决器（spec 2026-09-03-netdisk-llm-adjudicator §3 触发点 1）：归档之后，把归档
        // 待定卡与本轮判成 pending 的追更候选打包问一次模型，结论过代码闸后落决策账本；归档卡过闸
        // 的再跑一次 executeBinding，追更候选过闸的直接转存——两者都在裁决器内部完成（spec §6/§7）。
        // **缺席 = 跳过**（结构类型注入，`deps.adjudicate` 没装配不算故障，只是这条链路没接这一层）。
        if (this.deps.adjudicate) {
          try {
            const adj = await this.deps.adjudicate.run(setId, { trigger: 'follow', losers: true, followCandidates })
            rec.adjudicated = { runId: adj.runId, asked: adj.asked, applied: adj.applied, rejected: adj.rejected, unsure: adj.unsure, ...(adj.failed ? { failed: adj.failed } : {}) }
            // 归档卡过闸会重新 executeBinding、追更候选过闸会转存新文件——两者都可能让货架内容变化，
            // 重同步一次让节目单指着的路径与刚落定的决定对上号（同 5b 归档之后那一次的理由）。
            if (adj.applied > 0) {
              try { set = await this.deps.netdisk.sync(this.setOrThrow(setId)) }
              catch (e) { errors.push(`resync-after-adjudicate: ${msg(e)}`); unanswered = true }
            }
          } catch (e) { errors.push(`adjudicate: ${msg(e)}`); unanswered = true }
        }
        // resync 没跑成就没人知道转存的文件到没到货架上：拿转存前那个数，别用陈旧的分集算出一个假的「补上了」。
        rec.synced.matchedAfter = resyncFailed ? rec.synced.matchedBefore : matchedCount(set)
      }
    } catch (e) {
      errors.push(`round: ${msg(e)}`)
      unanswered = true
      // 账本行只留一句话；堆栈只有日志装得下，而这是唯一能定位「哪一步炸的」的东西。
      const stack = (e as Error)?.stack
      this.deps.log(`[follow] ${setId} round failed: ${msg(e)}${stack ? `\n${stack}` : ''}`)
    }

    // TMDb/AList 那一口没打开：账本落一行、通知照发（这轮出错了，不能静音），但不推进节奏、
    // 不动 dryRuns——下个周期原样再试。
    if (syncFailed) {
      const failed = this.runs.append(rec)
      this.notify(set, failed)
      return failed
    }

    // 节奏 + 状态
    const gained = rec.synced.matchedAfter > rec.synced.matchedBefore
    // 「无果」是一个结论，得先真的问到答案：问不到（列不出/搜不动/认集脑炸了/resync 没跑成）、
    // 或被登录态挡住，都是「没验到」，不退避。只是"答案为空"的那些错误行不算——否则一条常驻的
    // 错误（搜索没装配）就把节奏永远钉死在基线上。
    // 转存了文件却还没认出（夸克还在搬 / 名字认不出集号）也不是无果——东西已经到了，下一轮同步再认。
    const dry = rec.missingAired.length > 0 && !gained && !authFailed && !unanswered && rec.saved.length === 0
    const dryRuns = dry ? (set.follow?.dryRuns ?? 0) + 1 : gained ? 0 : (set.follow?.dryRuns ?? 0)
    // enabled 现读库里那份：一轮要跑一两分钟，中途有人把开关关了，不能被轮次开始时的快照改回去。
    const enabledNow = this.deps.store.get(setId)?.follow?.enabled ?? set.follow?.enabled ?? true
    set.follow = { enabled: enabledNow, dryRuns, lastCheckAt: at, nextCheckAt: nextCheckAt({ entries: set.entries, dryRuns, now: this.now() }).toISOString() }
    this.deps.store.save(set)
    const full = this.runs.append(rec)

    // 6. 通知（零缺集且零错误才不发——一轮出了错就得出声，哪怕它没缺集）
    if (rec.missingAired.length || rec.errors.length) this.notify(set, full)
    if (authFailed) {
      this.deps.events?.append({ type: 'follow.auth', severity: 'warn', title: '追更转存需要夸克登录态', body: authMessage, dedupeKey: 'follow-auth' } as EventInput)
    }
    return full
  }

  private notify(set: MappingSet, rec: FollowRunRecord): void {
    const ep = (k: string) => k.replace(/^.*:S0*(\d+)E0*(\d+)$/, 'S$1E$2')
    const got = rec.synced.matchedAfter - rec.synced.matchedBefore
    // 三种脸：补上了 / 没补上 / 压根没走到算缺集那一步（首次 sync 就炸）——最后一种只有错误可说。
    const savedN = rec.saved.reduce((n, s) => n + s.files.length, 0)
    // 四种脸：补上了 / 转了但还没认出（夸克还在搬、或文件名认不出集号）/ 没补上 / 压根没走到算缺集那一步
    const title = got > 0
      ? `《${set.left.title}》补了 ${got} 集`
      : savedN > 0
        ? `《${set.left.title}》转存了 ${savedN} 个文件，还没认出集`
        : rec.missingAired.length
          ? `《${set.left.title}》缺 ${rec.missingAired.length} 集，这轮没补上`
          : `《${set.left.title}》追更这轮出错`
    let body = got > 0 || savedN > 0
      ? `新到：${rec.saved.flatMap((s) => s.files).join('、')}${got === 0 ? '；下次同步再认一遍' : ''}`
      : rec.missingAired.length
        ? `缺 ${rec.missingAired.map(ep).join('、')}；回访 ${rec.revisited.length} 条分享、搜到 ${rec.searched?.alive ?? 0} 条可用${rec.errors.length ? `；错误 ${rec.errors.length} 条` : ''}`
        : rec.errors.join('；')
    const arch = rec.archived
    if (arch) body += arch.gated ? `；归档被闸：${arch.gated}` : (arch.moved + arch.deleted + arch.renamed > 0 ? `；归档：搬 ${arch.moved} · 删 ${arch.deleted} · 改名 ${arch.renamed}` : '')
    // 一轮没补上但也没出错，只是「还没等到」——那不是故障，别用 warn 把通知中心喂成噪音。
    this.deps.events?.append({ type: 'follow.round', severity: rec.errors.length ? 'warn' : 'info', title, body, dedupeKey: `follow:${set.id}` } as EventInput)
  }
}
