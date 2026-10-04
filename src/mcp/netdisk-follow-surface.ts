/**
 * 追更 / 同步 / 撤销这三件事**给 agent 的那一份投影**——面板那一份（HTTP 路由）不走这里，
 * 照旧拿完整对象。
 *
 * 和 `reconcile-surface.ts` 同一条理由：这里的每条规则都是「一次回执占多少上下文」的闸门。
 * 三个被投影掉的大字段，各自都能单独把一次回执顶到几十 KB：
 *  - `ShareRow.seenFiles` / 一条分享的整棵文件树（一条剧集分享几百个文件，每个带 fid+token）；
 *  - `FollowRunRecord.revisited/searched/saved` 的逐条明细（一轮跑完能有上百行）；
 *  - `MappingSet.entries`（一部长剧几百条，每条带指纹与订正历史）。
 * 投影全在这里、都有测试钉着，且**截断一律显式说出来**——模型拿半份当全份是静默答错
 * （docs/AGENT-TOOLING.md §9）。
 */
import { isUnaired } from '../netdisk/follow/plan.ts'

/** 一条分享验活最多带回多少个文件名。不是配置项：它是上下文闸门（200 × 约 60 字节 ≈ 12KB）。 */
export const SHARE_FILES_MAX = 200
/** 追更 view 最多带回几轮历史。更早的轮次在绑定页上，模型判「这条追更活着吗」用不到第 6 轮。 */
export const FOLLOW_RUNS_MAX = 5
/** 每季最多列几条缺集。缺 20 集以上时"缺了多少"比"逐个是哪几集"更要紧，数字仍然是全的。 */
export const SYNC_MISSING_PER_SEASON = 20
/** 孤儿文件采样条数（`orphanFiles` 报的是全量数字）。 */
export const SYNC_ORPHAN_SAMPLE = 10

/** `unsupported` 不是分享客户端报的，是**我们这一侧**的一档：这个盘（或这条链接）我们压根验不了。
 *  它必须和 `not-usable`（验过了、这条分享死了）分开——混成一格，模型就会把一条其实好好的
 *  百度分享报成"已失效"，用户据此把它删了。 */
export type ShareValidity = 'alive' | 'not-usable' | 'needs-login' | 'unknown' | 'unsupported'

export interface ShareInspectInput {
  netdisk: string
  pwdId: string
  validity: ShareValidity
  reason?: string
  files: readonly { path: string; size: number }[]
}

export interface ShareInspectView {
  netdisk: string
  pwdId: string
  validity: ShareValidity
  reason?: string
  total: number
  files: { path: string; size: number }[]
  truncated: boolean
  seasonsSeen?: string[]
}

const SEASON_MARKS = [/第\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*季/g, /\bS(\d{1,2})(?=[Ee]?\d|\b)/g]

/**
 * 分享里出现过哪些季的字样。**只报看到的字面，不做归一**：它的用途是让模型看出"这条分享其实
 * 是第 2 季，而我缺的是第 3 季"，而把「第三季」和「S03」归一成同一个数，恰恰会把这个矛盾抹掉。
 */
export function seasonsSeenIn(files: readonly { path: string }[]): string[] {
  const seen = new Set<string>()
  for (const f of files) {
    for (const re of SEASON_MARKS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(f.path))) seen.add(m[0].replace(/\s+/g, ''))
    }
  }
  return [...seen].sort()
}

export function projectShareInspect(input: ShareInspectInput): ShareInspectView {
  const files = input.files.slice(0, SHARE_FILES_MAX).map((f) => ({ path: f.path, size: f.size }))
  const seasons = seasonsSeenIn(input.files)
  return {
    netdisk: input.netdisk,
    pwdId: input.pwdId,
    validity: input.validity,
    ...(input.reason ? { reason: input.reason } : {}),
    total: input.files.length,
    files,
    // 截断必须自己说出来：模型拿半份清单当全份，会据此断言"这条分享里没有第 12 集"。
    truncated: input.files.length > files.length,
    ...(seasons.length ? { seasonsSeen: seasons } : {}),
  }
}

/** 验一条分享的入参：整条链接，或 网盘 + 分享 id 两件套。 */
export interface ShareVerifyInput {
  link?: string
  netdisk?: string
  pwdId?: string
}

/** 验不了的那一档的回执。**不抛异常**：抛出去在工具面上就是一条红色报错，模型会当成"这一步
 *  失败了"去重试或改参数，而真相是"这条我们本来就验不了，该让用户自己动手"。 */
export interface UnsupportedShare {
  netdisk?: string
  pwdId?: string
  validity: 'unsupported'
  reason: string
}

export type ShareTarget = { ok: true; netdisk: string; pwdId: string } | { ok: false; result: UnsupportedShare }

/**
 * 这条要验的分享落在谁头上——**在打网络之前就把三种"验不了"分开**：
 *
 *  1. 链接根本不是网盘分享（典型是 `video_search` 里 `needsResolve:true` 那种中转页地址）；
 *  2. 是分享链接，但那个盘我们没有客户端（今天只有夸克）；
 *  3. 什么都没给（调用方的编程错误）—— 只有这一种抛。
 *
 * 前两种以前都是抛异常（`inspectShare` 对不支持的盘直接 throw）。工具面上这两种和"这条分享
 * 死了"、"服务炸了"长得一模一样，模型会去重试、去换参数、或者干脆报告"链接失效"——而正确的
 * 下一句是「这个盘我们验不了，你自己转存一下」或「先 video_resolve 拿到真链接」。
 */
export function resolveShareTarget(
  input: ShareVerifyInput,
  deps: { supports: (netdisk: string) => boolean; parseLink: (link: string) => { netdisk: string; pwd_id: string } | null },
): ShareTarget {
  const ref = input.link ? deps.parseLink(input.link) : null
  const netdisk = ref?.netdisk ?? input.netdisk
  const pwdId = ref?.pwd_id ?? input.pwdId
  if (!netdisk || !pwdId) {
    if (input.link) {
      return {
        ok: false,
        result: {
          validity: 'unsupported',
          reason: '不是网盘分享链接（video_search 里 needsResolve:true 的条目要先 video_resolve 拿到真链接）',
        },
      }
    }
    throw new Error('link，或 netdisk + pwdId，二选一必填')
  }
  if (!deps.supports(netdisk)) {
    return { ok: false, result: { netdisk, pwdId, validity: 'unsupported', reason: `只支持夸克分享；${netdisk} 的链接请让用户自己转存` } }
  }
  return { ok: true, netdisk, pwdId }
}

/** 一轮追更的账本行（`FollowRunRecord` 里投影用得着的那部分）。 */
export interface FollowRunLike {
  id: string
  at: string
  trigger: string
  missingAired: readonly string[]
  saved: readonly { pwdId: string; files: readonly string[] }[]
  synced: { matchedBefore: number; matchedAfter: number }
  archived?: { runId: string; moved: number; deleted: number; renamed: number; gated?: string }
  errors: readonly string[]
}

export interface FollowRunRow {
  id: string
  at: string
  trigger: string
  missingAired: number
  saved: number
  synced: { matchedBefore: number; matchedAfter: number }
  archived?: { runId: string; moved: number; deleted: number; renamed: number; gated?: string }
  errors: number
}

/** 一行 = 一轮。逐条明细（回访了哪些分享、搜了哪些词、转存了哪些文件名）留在绑定页上。 */
export function projectFollowRun(rec: FollowRunLike): FollowRunRow {
  return {
    id: rec.id,
    at: rec.at,
    trigger: rec.trigger,
    missingAired: rec.missingAired.length,
    saved: rec.saved.reduce((n, s) => n + s.files.length, 0),
    synced: rec.synced,
    ...(rec.archived ? { archived: rec.archived } : {}),
    errors: rec.errors.length,
  }
}

export interface FollowViewLike {
  follow?: { enabled: boolean; nextCheckAt?: string; lastCheckAt?: string; dryRuns: number }
  missingAired: readonly string[]
  upcoming: number
  shares: readonly { pwdId: string; netdisk: string; origin: string; validity?: string; lastCheck?: string }[]
  runs: readonly FollowRunLike[]
}

export interface FollowShareRow {
  pwdId: string
  netdisk: string
  origin: string
  validity?: string
  lastCheck?: string
}

export interface FollowView {
  follow?: FollowViewLike['follow']
  missingAired: string[]
  upcoming: number
  shares: FollowShareRow[]
  /** 最近一轮**多带一份逐条错误**（`errorList`），更早的几轮只有计数。`run` 现在是
   *  fire-and-return，模型两分钟后回来读的就是这里——只给一个 `errors: 3`，它说不出哪儿卡住了。 */
  lastRuns: Array<FollowRunRow & { errorList?: string[] }>
}

export function projectFollowView(view: FollowViewLike): FollowView {
  return {
    ...(view.follow ? { follow: view.follow } : {}),
    // leftKey 本身就是模型要的东西（缺的是哪几集），不截断——一部剧的缺集是个位数到几十。
    missingAired: [...view.missingAired],
    upcoming: view.upcoming,
    // **逐格点名，不 `{...s}`**：账本行上还有 `seenFiles`（一条剧集分享几百个文件，每个带
    // fid+token）与 `savedFids`。今天 `view()` 恰好已经筛过一次，所以 spread 看起来是对的——
    // 而那正是这类缺陷的样子：投影这一层不该依赖上游筛没筛，上游哪天多带一格就是几十 KB
    // 静默灌进回执。
    shares: view.shares.map((s) => ({
      pwdId: s.pwdId,
      netdisk: s.netdisk,
      origin: s.origin,
      ...(s.validity ? { validity: s.validity } : {}),
      ...(s.lastCheck ? { lastCheck: s.lastCheck } : {}),
    })),
    lastRuns: view.runs.slice(0, FOLLOW_RUNS_MAX).map((r, i) => (i === 0 ? projectFollowRunResult(r) : projectFollowRun(r))),
  }
}

/** `netdisk_follow run` 的回执。**这一轮还没跑完**——它只是开了个头。 */
export interface FollowRunStarted {
  started: boolean
  setId: string
  alreadyRunning?: true
  note: string
}

export interface FollowRunner {
  isRunning: (setId: string) => boolean
  runOnce: (setId: string, trigger: 'manual') => Promise<unknown>
}

const RUN_NOTE =
  '一轮要 1–3 分钟：转存、多轮同步、归档。别再发第二次 run；过 2 分钟后用 action:"view" 看 lastRuns[0]。'

/**
 * 开一轮追更并**立刻返回**。
 *
 * 为什么不等它跑完：一轮里光"转存后多轮重同步"就有 6 轮 × 10 秒 ≈ 50 秒下限，加上搜索、转存、
 * 归档，实测量级是分钟。而工作台一次工具调用的超时是 200 秒——等下去的结局是超时报错，可那一轮
 * **还在后台跑着**：模型手里是一条"失败了"，磁盘上是一次真的转存 + 真的删副本。这比慢坏得多。
 *
 * 于是回执讲的是"开了没有"，不是"结果怎样"；结果去 `view` 的 `lastRuns[0]` 拿（账本行本来就
 * 落在那儿）。`docs/AGENT-TOOLING.md` §3.3 的「别让模型轮询」在这里的落法是**告诉它过两分钟
 * 回来看一次**，不是让它每隔几秒问一遍。
 *
 * 重复开是这条路上最贵的错：两轮并发对着同一条绑定转存 + 归档，账本和文件都要打架。所以先问
 * `isRunning`——那是 `FollowService` 自己那一份在跑名册，不是这里另记一本。
 */
export function startFollowRun(runner: FollowRunner, setId: string, onError: (e: unknown) => void): FollowRunStarted {
  if (runner.isRunning(setId)) {
    return {
      started: false,
      alreadyRunning: true,
      setId,
      note: '这条绑定已经有一轮在跑了，没有再开一轮。等它跑完（通常 1–3 分钟）再用 action:"view" 看 lastRuns[0]。',
    }
  }
  // 故意不 await：调用方要的是"开了"。整轮内部已经把每一步的错误落进账本行，这里的 catch 只
  // 兜住那唯一会外抛的一种（setId 不存在）与真正的意外——不能让它变成一条没人接的 rejection。
  void runner.runOnce(setId, 'manual').catch(onError)
  return { started: true, setId, note: RUN_NOTE }
}

/** 最近那一轮：行还是那一行，**错误逐条给全**——它是这一轮唯一说得清"哪儿卡住了"的东西。 */
export function projectFollowRunResult(rec: FollowRunLike): FollowRunRow & { errors: number; errorList: string[] } {
  return { ...projectFollowRun(rec), errorList: [...rec.errors] }
}

export interface SyncEntryLike {
  leftKey: string
  leftTitle: string
  rightFile: string | null
  status: string
  airDate?: string
}

export interface SyncSetLike {
  id: string
  left: { title: string }
  entries: readonly SyncEntryLike[]
  coverage?: { right?: { orphan?: number }; orphanFiles?: readonly string[] }
}

export interface SyncSeasonRow {
  season: number
  matched: number
  /** 分母 = 已播出的集（含已配上的）。还没播的不在这儿，见 `unaired`。 */
  total: number
  /** 还没播（airDate 在 today 之后、或 TMDb 尚未定档）且没拿到的集数——占位，不是缺货。 */
  unaired: number
  /** 已播出、还没拿到的集（每季封顶，见 `missingTruncated`）。 */
  missing: { leftKey: string; title: string; airDate?: string }[]
  missingTruncated: boolean
}

export interface SyncView {
  setId: string
  title: string
  bySeason: SyncSeasonRow[]
  orphanFiles: number
  orphanSample: string[]
}

/** `tmdb:1399:S02E07` → 2；订阅流那种 `item:<id>` 没有季，归 0（"这条绑定只有一季"的退化档）。 */
export function seasonOfLeftKey(leftKey: string): number {
  return Number(/:S(\d+)E/i.exec(leftKey)?.[1] ?? 0)
}

/**
 * 一次重新认盘的结果。**逐条 entry 一个都不给**：一部长剧几百条，每条带指纹/订正历史，
 * 整份灌进回执就是几十 KB。模型要的是"哪一季还缺哪几集"，那正是这份按季汇总。
 */
export function projectSync(set: SyncSetLike, today: string): SyncView {
  const bySeason = new Map<number, { matched: number; total: number; unaired: number; missing: SyncSeasonRow['missing'] }>()
  for (const e of set.entries) {
    const season = seasonOfLeftKey(e.leftKey)
    const row = bySeason.get(season) ?? { matched: 0, total: 0, unaired: 0, missing: [] }
    // 分子分母与 `progressOf` 同一把尺（`follow/plan.ts`）：还没播的集不进分母、也不算缺。
    // 这里逐条走一遍而不是调它，是因为缺集清单要在同一趟里攒出来。
    if (e.rightFile && (e.status === 'auto' || e.status === 'confirmed')) { row.matched += 1; row.total += 1 }
    else if (isUnaired(e, today)) row.unaired += 1
    else { row.total += 1; row.missing.push({ leftKey: e.leftKey, title: e.leftTitle, ...(e.airDate ? { airDate: e.airDate } : {}) }) }
    bySeason.set(season, row)
  }
  const orphanFiles = set.coverage?.orphanFiles ?? []
  return {
    setId: set.id,
    title: set.left.title,
    bySeason: [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([season, r]) => ({
        season,
        matched: r.matched,
        total: r.total,
        unaired: r.unaired,
        missing: r.missing.slice(0, SYNC_MISSING_PER_SEASON),
        // 同 §9：截掉了多少必须显式，否则模型把 20 条当成"就缺这些"。
        missingTruncated: r.missing.length > SYNC_MISSING_PER_SEASON,
      })),
    orphanFiles: set.coverage?.right?.orphan ?? orphanFiles.length,
    orphanSample: orphanFiles.slice(0, SYNC_ORPHAN_SAMPLE),
  }
}
