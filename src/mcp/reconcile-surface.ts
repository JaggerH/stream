/**
 * 整理裁决面**给 agent 的那一份投影**——面板那一份（HTTP 路由）不走这里，照旧拿完整 plan。
 *
 * 为什么单独一个模块：这里的每条规则都是「一次回执占多少上下文」的闸门，而闸门失效的样子是
 * **静默的**——回执太大 → DSH 的 tool-result 修剪把它腰斩 → 模型手里是半份清单却以为是全份，
 * 照着裁完就以为收工了。活体（2026-08-25「凹凸电波」）就是这样：`reconcile_status` 回了 162KB /
 * 491 条，进上下文时被砍成 29KB，模型裁了开头 28 条、剩下 463 条它根本没看见。
 *
 * 所以三条规则，都在这里、都有测试钉着：
 *  1. `suspect-dir` 归组——它本来就是**一条目录级判断**，不是 N 个独立问题（见 `groupSuspectDirs`）。
 *  2. 逐条清单封顶 + **截断显式说出来**（`pendingTotal` / `pendingTruncated`），绝不静默省略。
 *  3. 裁决收批量，一条坏的不放倒整批（见 `applyReconcileDecisions`）。
 */

import { createHash } from 'node:crypto'

/** 一条裁决。批量与单条是同一个形状——单条就是 1 元素的那种。 */
export type ReconcileDecisionInput = {
  verdict?: 'is-episode' | 'not-episode' | 'prefer' | null
  leftKey?: string
  path?: string
  keptPath?: string
  loserPath?: string
}

/** 落一条裁决要用到的那几个原语（`ReconcileService` 的窄切面）。取窄切面是为了让这层能被单独
 *  测——也顺带保证它只碰 `setXxx`，不会绕开账本回填直接写 DecisionStore（MATCHING.md）。 */
export interface ReconcileDecisionSink {
  setPreferred(keptPath: string, loserPath: string, preferred: boolean): void
  setIsEpisode(leftKey: string, path: string, value?: boolean): void
  setNotEpisode(leftKey: string, path: string): void
}

/** agent 面一次最多带回多少条待裁决卡片。**不是配置项**：它是"一次回执占多少上下文"的闸门，
 *  50 条 × 约 200 字节 ≈ 10KB，留足余量。要更多就翻页，别把闸门开大。 */
export const RECONCILE_PAGE_DEFAULT = 50
export const RECONCILE_PAGE_MAX = 200

export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : RECONCILE_PAGE_DEFAULT
  return Math.min(RECONCILE_PAGE_MAX, Math.max(1, n))
}

/** 熔断打在每条动作上的那个目录级标记（`plan.ts` 的 `suspectDirPass` 写，只有它写）。 */
export type SuspectMark = { dir: string; bad: number; total: number; priorVerdict: string }

/** 一条 pending 动作里这层用得着的部分。故意只声明用到的字段——多余的字段不该漏进回执。 */
export type PendingLike = {
  src: { path: string; size?: number; durationS?: number }
  reason?: string
  pendingKind?: string
  episode?: string
  collidesWith?: string
  conflictsWith?: string[]
  compare?: { authorityDurationS?: number; candidates?: unknown[] }
  suspect?: SuspectMark
}

export function suspectOf(a: PendingLike): SuspectMark | undefined {
  return a.suspect
}

export interface SuspectDirGroup {
  dir: string
  unrecognized: number
  scanned: number
  files: number
  sample: string[]
  hint: string
}

/**
 * 把 `suspect-dir` 那一堆折回它本来的样子：**一条目录级判断**。
 *
 * 熔断为了让面板逐行可读，把同一句判断复制到该目录下每一条动作上；agent 面照单全收就成了
 * "同一句话 N 份"（活体实测 137KB / 491 条里，六成是这句话的副本）。而且它对模型是个**假问题**：
 * 那 491 张卡片不是 491 个独立判断，是一个判断——"这个目录到底装的是什么"。摊开成 491 张，
 * 模型只会埋头逐条裁。
 *
 * **`hint` 让它先去看，别直接问人。** 这一条是活体教的：第一版 hint 写的是「先问用户这个目录
 * 指对了没有」，模型一字不差照做了——两次 `reconcile_status` 之后就停下来问人，而
 * `netdisk_browse` 明明在它那 60 个工具里。目录里装的是什么是**一眼可查的事实**，不是要人拍板
 * 的取舍；把它当问题抛回去，等于让用户替它做侦察。真去看那一眼（10 个子目录全是 plus /
 * 大醉酒馆 / 纪念专辑，一集正片都没有）才够得着真正的结论：**目录没指错，是这批内容压根不在
 * 节目单里**——而那个结论恰恰是原先两个出口（改绑定 / 逐条裁）都覆盖不到的第三种情况。
 */
export function groupSuspectDirs(pending: readonly PendingLike[]): SuspectDirGroup[] {
  const byDir = new Map<string, { mark: SuspectMark; files: string[] }>()
  for (const a of pending) {
    const mark = suspectOf(a)
    if (!mark) continue
    const g = byDir.get(mark.dir) ?? { mark, files: [] }
    g.files.push(a.src.path)
    byDir.set(mark.dir, g)
  }
  return [...byDir.values()].map(({ mark, files }) => ({
    dir: mark.dir,
    unrecognized: mark.bad,
    scanned: mark.total,
    files: files.length,
    sample: files.slice(0, 3),
    hint:
      `这一整个目录里 ${mark.bad}/${mark.total} 个文件认不出属于本节目，所以它下面 ${files.length} ` +
      `条动作全部按下没执行——这是一个目录级的问题，别逐条裁决它。` +
      `下一步是 netdisk_browse 这个目录看它到底装了什么，**先看再说，不要直接把这个问题抛给用户**` +
      `（目录里有什么是查得到的事实，不是要人拍板的取舍）。看完对号入座：` +
      `(a) 装的是别的节目 → 目录指错了，要改绑定；` +
      `(b) 装的是本节目、但全是番外/合辑/花絮，节目单里没有它们 → 目录没指错，是节目单不覆盖这批内容，` +
      `这时候搬运会把它们全判成下架，几乎肯定不是用户要的，把这个发现摆给用户让他决定这批内容怎么安置；` +
      `(c) 确实是本节目的正片、只是没匹配上 → 用 expandDir 取这一组逐条裁。` +
      `带着看到的东西去问用户，别空手问。`,
  }))
}

export interface ReconcileStatusOpts {
  expandDir?: string
  offset?: number
  limit?: number
  /** 将删清单的游标。**和 `offset` 是两个东西，别合并**：`offset` 归 `expandDir` 那一档，
   *  两个清单共用一个游标就会互相牵制——翻将删清单会顺手把待裁决那份也推走。 */
  deletesOffset?: number
}

/** 将删清单一次最多列几条。同 `RECONCILE_PAGE_DEFAULT`：这是上下文闸门，不是配置项
 *  （50 × 约 200 字节 ≈ 10KB）。截断由 `plannedDeletesTruncated` 说出来。 */
export const PLANNED_DELETES_MAX = 50

/** 计划里那几种"会少掉一份文件"的动作。字段名照 `plan.ts` 的 union 抄，故意只声明用得着的。 */
export type DeleteLike = {
  kind: string
  src: { path: string; size?: number }
  /** `delete-dup`：留下的那份。 */
  dupOf?: string
  /** `delete-loser`：留下的那份。 */
  keptPath?: string
  /** `replace`：被顶掉、要删的那份（**它才是消失的那个**，`src` 是留下的新正主）。 */
  oldPath?: string
  episode?: string
  /** 机器为什么选了这一份做正主（`quality-loser-of:…` / `size-dup-of:…` / `decision:prefer:…`）。 */
  basis?: string
  /** 并排对照数据，形状同 `plan.ts` 的 `CompareInfo`。**整坨不进回执**——只从里面按 path
   *  取两侧的体积与时长这四个标量（`candidates[]` 一条就几百字节，那是给面板的）。 */
  compare?: { authorityDurationS?: number; candidates?: { path?: string; size?: number; durationS?: number }[] }
}

export interface PlannedDelete {
  kind: 'delete-dup' | 'delete-loser' | 'delete-redundant' | 'replace'
  /** 会消失的那份文件。 */
  path: string
  /** 留下的那份。`delete-redundant` 没有——留下的不是另一个文件，是源站自己。 */
  keptPath?: string
  episode?: string
  /** 会消失那份的体积 / 时长。 */
  sizeBytes?: number
  durationS?: number
  /** 留下那份的体积 / 时长。**判「是不是同一集」靠 `durationS` 两侧精确相等，不靠体积**——
   *  时长坏值（探测失败那种几十小时）不会碰巧相等，而体积本来就该不一样。 */
  keptSizeBytes?: number
  keptDurationS?: number
  /** 机器选正主的依据，原样带出来。 */
  basis?: string
}

const DELETE_KINDS = new Set(['delete-dup', 'delete-loser', 'delete-redundant', 'replace'])

/**
 * 把计划里每一条"会少掉一份文件"的动作摊成 `{删哪份, 留哪份}` 一对。
 *
 * **为什么必须在回执里**：`reconcile_execute` 的描述要求模型执行前核对"每条删除留下的是同一集
 * 的另一份"，而在此之前 `reconcile_status` 只回 `counts` 里的几个数字——那句要求指向一份**它拿
 * 不到的数据**，模型只能假装核对过，或者停下来问用户一个它本该自己看的事实。删是这里唯一
 * 走不回来的动作（`reconcile_undo_run` 撤不了删），所以宁可占这点上下文。
 *
 * `replace` 反着来：消失的是 `oldPath`（被顶掉的旧正主），`src` 是留下的那份。抄反了，模型核对
 * 的就是另一件事，而两边都长得挺像。它的 `sizeBytes` 只能从 `compare.candidates` 里按 `oldPath`
 * 取——计划的 `src.size` 是留下那份的体积，拿它冒充"要删那份多大"是编数字。
 *
 * **四个标量（`durationS` / `keptSizeBytes` / `keptDurationS` / `basis`）不是锦上添花。**
 * 没有它们，"这两份是同一集吗"在这份回执上**无法求值**：留下那份的体积和时长一个都不在，
 * 而两侧 `durationS` 精确相等才是最硬的那条证据。活体（2026-09-03《喜剧之王单口季》）里模型
 * 只能绕去 HTTP 面拿完整 plan 才核得动 59 条删除。**找不到候选就缺席该字段，绝不填 0**——
 * 一个编出来的 0 会被读成"这份是空文件"。
 */
export function collectPlannedDeletes(plan: readonly DeleteLike[]): PlannedDelete[] {
  const out: PlannedDelete[] = []
  for (const a of plan) {
    if (!DELETE_KINDS.has(a.kind)) continue
    const replace = a.kind === 'replace'
    const path = replace ? a.oldPath : a.src.path
    if (!path) continue
    const keptPath = replace ? a.src.path : (a.keptPath ?? a.dupOf)
    const candidate = (p?: string) => (p ? a.compare?.candidates?.find((c) => c.path === p) : undefined)
    const gone = candidate(path)
    const kept = candidate(keptPath)
    const goneSize = replace ? gone?.size : (a.src.size ?? gone?.size)
    out.push({
      kind: a.kind as PlannedDelete['kind'],
      path,
      ...(keptPath ? { keptPath } : {}),
      ...(a.episode ? { episode: a.episode } : {}),
      ...(typeof goneSize === 'number' ? { sizeBytes: goneSize } : {}),
      ...(typeof gone?.durationS === 'number' ? { durationS: gone.durationS } : {}),
      ...(typeof kept?.size === 'number' ? { keptSizeBytes: kept.size } : {}),
      ...(typeof kept?.durationS === 'number' ? { keptDurationS: kept.durationS } : {}),
      ...(a.basis ? { basis: a.basis } : {}),
    })
  }
  return out
}

/** 指纹认得出「这份 plan 还是不是我核过的那份」的那几格：动作种类 + 源路径 + 它的落点/对家。
 *  排序后才哈希——动作顺序变了不算 plan 变了（规划器的遍历序不是契约）。 */
type FingerprintablePlanAction = {
  kind: string
  src?: { path?: string }
  dstDir?: string
  newName?: string
  keptPath?: string
  dupOf?: string
  oldPath?: string
}

/**
 * 一份 plan 的稳定指纹（sha256 前 16 位）。
 *
 * **为什么要它**：核清单和真正执行之间隔着几分钟到几十分钟（逐条核 59 条删除、等用户点头），
 * 而这中间追更跑一轮就会转存新文件——`reconcile_execute` 拿到的是**重新规划**的那份，不是被核过
 * 的那份。在此之前"先预览再执行"只是纪律，没有闸：没有任何机制保证"我核的就是它执行的"。
 *
 * `status` 与 `execute` **必须调同一个函数**：两份实现漂移的表现是指纹永远对不上（或永远对得上），
 * 两边单看都正常。
 */
export function planFingerprint(plan: readonly FingerprintablePlanAction[]): string {
  const lines = plan
    .map((a) => {
      const other = a.dstDir ?? a.newName ?? a.keptPath ?? a.dupOf ?? a.oldPath ?? ''
      return `${a.kind} ${a.src?.path ?? ''} ${other}`
    })
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/**
 * 执行前那道可选的闸：`expectFingerprint` 给了就重算当前 plan 的指纹，对不上**一步都不走**。
 *
 * 不传就照旧——而且**连 preview 都不跑**：那是一次真的重新规划（读网盘、跑匹配），白跑一次是
 * 实打实的代价，不能拿来当"反正没坏处"的默认动作。
 */
export async function runReconcileExecute<R>(
  deps: { previewPlan: () => Promise<readonly FingerprintablePlanAction[]>; execute: () => Promise<R> },
  expectFingerprint?: string,
): Promise<R> {
  if (expectFingerprint) {
    const now = planFingerprint(await deps.previewPlan())
    if (now !== expectFingerprint) {
      throw new Error(`plan changed since preview (expected ${expectFingerprint}, now ${now}) — run reconcile_status again`)
    }
  }
  return deps.execute()
}

/**
 * 投影的输入：一次 preview 的产物。
 *
 * **这里没有「建议统计」那一格，是有意删掉的。** 它曾经在（`rec.listSuggestions().summary`），
 * 而 `SuggestionQuery` 里压根没有 show 这一维——于是一个**全局**数字挂在了按节目的回执上：
 * 活体实测四个节目返回的是同一份 `{total:12, agreed:7, open:5}`。模型据此读出"这个节目有 5 条
 * 待答建议"，实际是全库 5 条，而且没有任何一处会报错。**一个看起来有作用域、其实没有的数字，
 * 比没有这个数字坏得多。** 真要看建议采纳率有面板和 HTTP 路由（那边本来就传 query）。
 */
export interface ReconcileStatusInput {
  counts: unknown
  pending: readonly PendingLike[]
  /** 整份计划——只用来抽将删清单（`collectPlannedDeletes`）。`pending` 那一格仍单独传：它是
   *  调用方已经筛过的那一份，两处的形状本来就不同（这里只认删，那里只认待裁决）。 */
  plan?: readonly DeleteLike[]
}

export function projectReconcileStatus(input: ReconcileStatusInput, opts?: ReconcileStatusOpts): Record<string, unknown> {
  const { counts, pending } = input
  const limit = clampLimit(opts?.limit)
  const offset = Math.max(0, Math.trunc(opts?.offset ?? 0))
  const suspectDirs = groupSuspectDirs(pending)

  // 展开某一个熔断目录 = 另一个问题（"这一组里逐条都是什么"），逐条给、并且分页。
  if (opts?.expandDir) {
    const group = suspectDirs.find((g) => g.dir === opts.expandDir)
    if (!group) {
      throw new Error(
        `expandDir '${opts.expandDir}' 不是本次的熔断目录` +
          (suspectDirs.length ? `——有的是：${suspectDirs.map((g) => g.dir).join(' / ')}` : '（本次没有熔断目录）'),
      )
    }
    const rows = pending.filter((a) => suspectOf(a)?.dir === opts.expandDir)
    const page = rows.slice(offset, offset + limit)
    return {
      counts,
      expanded: {
        dir: group.dir,
        unrecognized: group.unrecognized,
        scanned: group.scanned,
        total: rows.length,
        offset,
        returned: page.length,
        hasMore: offset + page.length < rows.length,
      },
      // 组已经说过那半句目录级判断了，逐条只留自己那一份：原判定 + 判断所需的三个数。
      pending: page.map((a) => ({
        file: a.src.path,
        sizeBytes: a.src.size,
        durationS: a.src.durationS,
        pendingKind: 'suspect-dir',
        priorVerdict: suspectOf(a)!.priorVerdict,
      })),
    }
  }

  const cards = pending.filter((a) => !suspectOf(a))
  const shown = cards.slice(0, limit)
  const deletes = collectPlannedDeletes(input.plan ?? [])
  // NaN 过不了 Math.max——它会切出一份空清单且 truncated:false，正是这个模块要防的"安静的半份"。
  const rawDeletesOffset = opts?.deletesOffset
  const deletesOffset = Number.isFinite(rawDeletesOffset) ? Math.max(0, Math.trunc(rawDeletesOffset as number)) : 0
  const deletesShown = deletes.slice(deletesOffset, deletesOffset + PLANNED_DELETES_MAX)
  return {
    counts,
    // 完整 plan 会把几十条例行搬运灌进上下文——agent 要裁决的只有 pending；
    // 搬运/删除类只报数字（counts），细节人要看去面板（证据展示保留在那儿）。
    pending: shown.map((a) => ({
      file: a.src.path,
      sizeBytes: a.src.size,
      durationS: a.src.durationS,
      pendingKind: a.pendingKind,
      episode: a.episode,
      leftKey: a.collidesWith,
      authorityDurationS: a.compare?.authorityDurationS,
      candidates: a.compare?.candidates,
      reason: a.reason,
    })),
    // 截断必须自己说出来。默认那份被 DSH 的 tool-result 修剪腰斩过一次，模型手里是半份清单
    // 却以为是全份——它照着裁完就以为收工了。宁可少给，也要让"还有"是显式的。
    pendingTotal: cards.length,
    pendingTruncated: cards.length > shown.length,
    // 将删清单：execute 之前要核对的那一份（`collectPlannedDeletes` 头注讲了为什么它必须在）。
    // 搬运仍然只报数字——搬走的文件找得回来，删掉的找不回来。
    // 截断有出路，出路必须写在回执上：`deletesOffset` 是这份清单**自己**的游标。曾经这里只
    // 有一个 `plannedDeletesTruncated`，而唯一的 `offset` 归 expandDir 那档——超过 50 条删除
    // 的绑定，剩下那几条在工具面上**没有任何办法**看到，而规则又（正确地）禁止声称核过。
    plannedDeletes: deletesShown,
    plannedDeletesTotal: deletes.length,
    plannedDeletesOffset: deletesOffset,
    plannedDeletesTruncated: deletesOffset + deletesShown.length < deletes.length,
    // 预览与执行之间那道闸的钥匙（`planFingerprint` 头注讲了为什么纪律不够）。
    planFingerprint: planFingerprint((input.plan ?? []) as readonly FingerprintablePlanAction[]),
    suspectDirs,
  }
}

/**
 * `reconcile_status` / `reconcile_execute` 的 `show` 到底指谁。
 *
 * **两种左侧，一个动词。** 播客那档在整理配置里有一条 show（id / 订阅 id / 节目名都能指到它）；
 * 影视那档（tmdb 绑定）**没有 show 配置**——它走的是 `showForBinding` 合成的原地模式。工具面
 * 此前只认前者，于是一条剧集绑定在模型手里根本没法归档：它拿得到 setId（`netdisk_bindings`），
 * 而每一次 `reconcile_status` 都答"unknown show"。
 *
 * 判据顺序是刻意的，别调换：
 *  1. `binding:<id>` 显式前缀 —— 说得最清楚的那种，不再问 show 那一侧（不存在的绑定由
 *     `showForBinding` 抛，错误话术是那一层的）。
 *  2. 裸串先问 show —— **既有行为一个字不改**：show id / 订阅 id / 节目名照旧优先。
 *  3. show 那侧不认、而它是一条绑定 id —— 走绑定。
 *  4. 两侧都不认 —— 仍然当 show 交下去，好让报错是 `showOrThrow` 那句带"现有 show 有哪些"的。
 *
 * `hasShow` 必须是 `ReconcileService` 自己那一个判据（`showOrThrow` 的布尔版），**不许在这里
 * 重写一份**：两份判据分家的表现是"名字明明对着却 unknown show"，而没有一处会喊。
 */
export function resolveReconcileRef(
  ref: string,
  deps: { hasShow: (r: string) => boolean; hasBinding: (r: string) => boolean },
): { kind: 'show' | 'binding'; id: string } {
  if (ref.startsWith('binding:')) return { kind: 'binding', id: ref.slice('binding:'.length) }
  if (deps.hasShow(ref)) return { kind: 'show', id: ref }
  if (deps.hasBinding(ref)) return { kind: 'binding', id: ref }
  return { kind: 'show', id: ref }
}

export interface ReconcileDecideResult {
  ok: boolean
  decided: number
  failed: number
  errors?: { index: number; target: string; error: string }[]
}

/**
 * 落一批裁决。单条写法（四个字段摊在顶层）继续受理——它是同一件事的 1 元素形态，两条路汇进
 * 同一个 `apply`，不会一边修好另一边留着老 bug。
 *
 * **一条坏的不放倒整批**：批量的意义就是少走几十个来回，一条打回全部等于没批量。打回的那几条
 * 带 index + 目标，模型据此只重发它们。
 */
export function applyReconcileDecisions(
  sink: ReconcileDecisionSink,
  input: ReconcileDecisionInput & { decisions?: ReconcileDecisionInput[] },
): ReconcileDecideResult {
  const apply = (d: ReconcileDecisionInput) => {
    if (d.keptPath && d.loserPath) {
      sink.setPreferred(d.keptPath, d.loserPath, d.verdict === 'prefer')
      return
    }
    if (!d.leftKey || !d.path) throw new Error('leftKey and path are required together（或改传 keptPath+loserPath）')
    if (d.verdict === 'is-episode') sink.setIsEpisode(d.leftKey, d.path)
    else if (d.verdict === 'not-episode') sink.setNotEpisode(d.leftKey, d.path)
    else if (d.verdict === null) sink.setIsEpisode(d.leftKey, d.path, false)
    else throw new Error(`verdict '${d.verdict}' 不能配 leftKey+path（prefer 走 keptPath+loserPath）`)
  }

  const list = input.decisions?.length ? input.decisions : [input]
  const errors: { index: number; target: string; error: string }[] = []
  let decided = 0
  list.forEach((d, index) => {
    try {
      apply(d)
      decided += 1
    } catch (e) {
      errors.push({ index, target: d.path ?? d.loserPath ?? '(未指明)', error: e instanceof Error ? e.message : String(e) })
    }
  })
  return { ok: errors.length === 0, decided, failed: errors.length, ...(errors.length ? { errors } : {}) }
}
