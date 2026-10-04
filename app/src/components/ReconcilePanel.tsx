import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Loader2, Settings, Sparkles, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './acrylic/dialog.tsx'
import { Item, ItemContent, ItemTitle, ItemGroup, ItemDescription } from './acrylic/item.tsx'
import { Button } from './acrylic/button.tsx'
import { Badge } from './acrylic/badge.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './acrylic/select.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './acrylic/tooltip.tsx'
import { toast } from './acrylic/sonner.tsx'
import { DedupePreview, type DedupeGroup } from './DedupePreview.tsx'
import { ActionCard, buildActionRows, explainLookup, fmtBytes, splitSwapHolds, whereIn, type ActionRow } from './reconcile-action-row.tsx'
import { kbpsBaselineOf } from './reconcile-verdict-chain.ts'
import { reclaimedBytes } from './reconcile-exec-summary.ts'
import { AiTrackRecord } from './reconcile-ai-batch-bar.tsx'
import { api, ApiError, type Connection } from '../lib/api.ts'
import { askOpenReconcile, askReconcile } from '../lib/askExtract.ts'
import { showsForStream } from '../lib/reconcileShows.ts'
import type { MappingSet, ReconcilePlanAction, ReconcilePreview, ReconcileShowConfig, SuggestionSummary } from '../lib/types.ts'

// slug / 货架地址派生（`<挂载根>/From Stream/<节目名>/付费` 与它的同级「下架」）**已经搬去后端**
// （`src/netdisk/reconcile/open.ts`）——那四步现在是一个原子动作，前端不再自己编排一份。

/**
 * 「整理」面板。呈现围着**两个问题**组织,不围内部机制:
 *  ① 机器已经确定的动作(移动/删重复)——列出来给你过目,一键执行;
 *  ② 机器拿不准的——按"你要回答什么"分组,每条把证据并排摆好,按钮就是答案本身
 *    (「是同一集,删网盘这份」/「不同集,别再提醒」),不让用户翻译系统术语。
 * 分组键是后端的 pendingKind(机器可读),绝不解析中文理由字符串。
 *
 * **版面按「用户要做什么」分三层,不按机器的判定种类平铺**（判定分组本身没变,只是怎么摆变了）:
 *  一层 **要动手的**——「可以自动完成」(过目+执行) 与「要你决定」(并排对照,你来选);
 *  二层 **要注意的**——⚠ 目录疑似认领错误:唯一一条"你得去改配置"的告警,不折叠;
 *  三层 **只是状态**——等下轮落位 / 还在探时长:用户对它们无事可做,收成一行「处理中 N」。
 * 抬头把动机（可省多少 GiB）和两个待办数放在第一眼,「认领的文件夹」这类一次性配置收进齿轮。
 * 六块等权平铺过一次,用户的原话是「又多又杂又难看」——权重全一样 = 没有权重。
 */
export function ReconcilePanel({
  apiBase = '',
  open,
  onOpenChange,
  streamId,
  streamTitle,
  bindingId,
}: {
  apiBase?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 限定到某个订阅：只在该订阅名下的 show 里选（按 bindingId 关联的网盘绑定的 left.streamId 判归属）,
   *  一条都没有就转呈「还没配过整理」那一档,而不是回落到「全部 show 里挑第一个」——不然会把
   *  别的订阅的整理计划端给这个订阅的用户看。不传 = 沿用旧行为(不区分订阅,shows[0] 默认,>1 个给 Select)。 */
  streamId?: string
  /** 订阅的显示名。「还没配过整理」那一档发给 AI 的那一句里用它称呼这条订阅（模型面认的是 id）。 */
  streamTitle?: string
  /**
   * **按绑定整理**（影视那一档）：没有 show 配置，直接对着一条绑定跑同一条管线（后端合成一份
   * 「原地模式」的退化配置——无暂存区、无第二货架）。
   *
   * 传了它就进这一档：不读整理配置、不选节目、不出「还没配过整理」那一档（那些都是 show
   * 的东西）。**待决卡、逐张裁决、AI 帮听照旧**——它们只吃 preview 的产出，与配置从哪来无关，
   * 而影视那边正堆着一批待决卡够不着这些能力。与 `streamId` 互斥。
   */
  bindingId?: string
}) {
  const conn: Connection = { baseUrl: apiBase }
  /** 按绑定这一档：目标是绑定而不是 show，配置层整层不参与。 */
  const byBinding = !!bindingId
  const [shows, setShows] = useState<ReconcileShowConfig[] | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [showId, setShowId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ReconcilePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  /** 「让 AI 听完这些」那一批的进度与结果。`null` = 这个 show 没起过。 */
  /** 历史一致率（AI 建议 vs 人最终选择）。**全局的，不分 show**——门槛看的是这套判读整体准不准。 */
  const [trackRecord, setTrackRecord] = useState<SuggestionSummary | null>(null)

  // streamId 限定视图专用:该订阅名下的网盘绑定(权威清单来源,归档器拿它当认集清单)。
  const [bindings, setBindings] = useState<MappingSet[] | null>(null)
  const [bindingsError, setBindingsError] = useState<string | null>(null)
  const [bindingsRetryTick, setBindingsRetryTick] = useState(0)

  // loadConfig 会被并发调用(打开时的 effect、以及配置在别处被改动后的刷新),两处都可能被后来者超车——
  // 单个调用局部的 `alive` 标记盖不住"另一次 loadConfig 调用"这种情况,必须用组件自己持有的
  // 世代号:每次调用领一个新号,回来时号对不上当前最新号就丢弃,不管是谁发起的、慢了多久。
  const configReqRef = useRef(0)
  const loadConfig = useCallback(() => {
    const reqId = ++configReqRef.current
    setConfigError(null)
    setShows(null)
    return api.reconcile.config(conn)
      .then((r) => { if (configReqRef.current === reqId) setShows(r.shows); return r.shows })
      .catch((e: unknown) => {
        if (configReqRef.current === reqId) {
          setConfigError(e instanceof ApiError && e.status === 503 ? '归档服务未接线' : '加载归档配置失败')
        }
        throw e
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase])

  useEffect(() => {
    if (!open) return
    // 按绑定这一档不读配置：它没有 show，读回来也只会喂给下面那些「选哪个节目 / 要不要转呈
    // 向导」的判断，白烧一次请求还可能把 configError 顶到界面上（整理服务在、show 配置为空
    // 也照样能按绑定跑）。
    if (byBinding) return
    let alive = true
    loadConfig().catch(() => {})
    if (streamId) {
      setBindingsError(null)
      setBindings(null)
      api.netdisk.list(conn)
        .then((list) => { if (alive) setBindings(list) })
        .catch((e: unknown) => {
          if (!alive) return
          // 绑定是"这个订阅到底有没有配置"的判据来源——取不到时绝不能当「没有绑定」处理,
          // 那会把「还没配过整理」那一档端出来,用户点下去就让 AI 又开一轮、建出重复的配置。
          // 留 bindings=null(不落 []),呈现独立的错误态 + 重试,原始报错只进控制台。
          console.error('加载网盘绑定失败', e)
          setBindingsError(e instanceof ApiError ? '加载网盘绑定失败' : '加载网盘绑定失败：网络异常')
        })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, apiBase, streamId, byBinding, loadConfig, bindingsRetryTick])

  // streamId 限定视图:只看这个订阅名下、bindingId 对得上的 show;不限定则沿用全量列表。
  // 归属判据走 `showsForStream`——网盘面板那一块摘要下的是同一个判断,两份会各自漂。
  const effectiveShows = useMemo(() => {
    if (!streamId) return shows
    if (!shows) return null
    return showsForStream(shows, bindings ?? [], streamId)
  }, [shows, streamId, bindings])

  // 还没配 show(streamId 限定视图下)。有没有绑定不再分两种：`reconcile_open` 一个动作里
  // 建/复用绑定都办了,两种情况的出路是同一句话——「让 AI 整理」。
  const needsSetup = !!streamId && bindings != null && effectiveShows != null && effectiveShows.length === 0

  useEffect(() => {
    if (effectiveShows && effectiveShows.length > 0 && (!showId || !effectiveShows.some((s) => s.id === showId))) {
      setShowId(effectiveShows[0].id)
    }
  }, [effectiveShows, showId])

  /** silent = 后台核对:保留现有内容,结果到了悄悄替换——绝不用 spinner 顶掉用户正在看的列表。 */
  const runPreview = useCallback((id: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    setPreviewError(null)
    ;(byBinding ? api.reconcile.previewBinding(conn, id) : api.reconcile.preview(conn, id))
      .then((r) => setPreview(r))
      .catch((e: unknown) => {
        if (opts?.silent) return // 后台核对失败不打断——下次打开自然重来
        setPreview(null)
        setPreviewError(e instanceof ApiError ? e.message : '预览失败')
      })
      .finally(() => { if (!opts?.silent) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, byBinding])

  /**
   * 这一轮整理对着谁——show 还是一条绑定。下面所有「跑一次」的动作（预览 / 执行 / AI 那一批的
   * 键）都认它，别再各自读 `showId`：漏一处的表现是那个动作还对着 show 跑，而按绑定这一档
   * 根本没有 show，于是静默什么都不发生。
   */
  const targetId = bindingId ?? showId

  useEffect(() => {
    if (open && targetId) runPreview(targetId)
  }, [open, targetId, runPreview])

  const auto = preview?.plan.filter((a) => a.kind !== 'pending') ?? []
  const pending = preview?.plan.filter((a) => a.kind === 'pending') ?? []
  // ① 同一集有多个文件——回答"留哪份"。`replace` 待定（下架货架上已有同一集、两份比不出高下）
  // 问的就是这件事:并排看一眼这几份,哪个音质好/哪个才是这一集。
  // **按集身份归组**:后端是一个文件一条 pending,同一集的几份若拆成几行、每行重复同样的 reason,
  // 而"另一份是什么"根本没在行里,那个问句就无法回答。归组后一组一行、组内并排列出全部候选
  // （时长/大小/码率/路径），判断所需的东西一次给全
  // （spec 2026-07-30-duplicate-episode-decision-design §4）。
  const versionGroups = useMemo(() => {
    const byKey = new Map<string, ReconcilePlanAction>()
    for (const a of pending) {
      // `duration-collision`（时长撞上某一集、名字完全不沾）问的也是"并排看一眼，这是不是那一集",
      // 证据同样在 compare 里——它要的就是这块并排版面，落进下面「认不出」那一组等于把证据藏了。
      // `evidence-conflict`（证据指向好几集）同理,而且更该在这儿:它取代的正是"静默搬去下架",
      // 落进「认不出」那一组就等于换了个地方继续不说话。
      if (a.pendingKind !== 'replace' && a.pendingKind !== 'duration-collision' && a.pendingKind !== 'evidence-conflict') continue
      // 同集多条只留一条当代表（compare 里已含全部候选）。**`evidence-conflict` 不归组**:
      // 它的 key 是集身份、问的却是"这份文件属于谁",同 key 的两份文件各有各的证据,
      // 合成一行会把其中一份连同它的证据一起吞掉。
      if (a.pendingKind === 'evidence-conflict') { byKey.set(`${a.key}|${a.src.path}`, a); continue }
      if (!byKey.has(a.key)) byKey.set(a.key, a)
    }
    return [...byKey.values()]
  }, [pending])
  // ②-a 目录疑似认领错误——后端判的是"这整个目录跟本节目对不上",不是"这一条文件没时长",
  // 必须单独一组:陈述、reason、出路都不一样,混进「认不出」会把「改错来源目录」的问题
  // 误导成「机器判不了这个文件,不再提醒就好」。
  const suspectDir = pending.filter((a) => a.pendingKind === 'suspect-dir')
  // ②-c 等位(`swap-hold`):已经认领、时长齐全,只是货架上同集/同名的旧份还占着位置。
  // **它不再自成一块**——那一块和「可以自动完成」之间的因果只存在于代码里(第一块里那几条删除
  // 执行完、这几条就自动落位了),界面上一个字没提,用户读不出两块有关系。现在按**占位者在不在
  // 本轮计划里**分流(`splitSwapHolds`):
  //  · 在 → 挂到腾位的那条动作上当后果(↳「执行后 X 随即搬入」),它本来就是那条动作的结果;
  //  · 不在 → 真卡住了(位置被本轮不动的文件占着),进「要你决定」。**绝不静默丢掉**——
  //    后端那句"等它腾空后下一轮自然落位"对它是假话,没人会去腾。
  const swapHold = pending.filter((a) => a.pendingKind === 'swap-hold')
  const { unblocks, stranded } = useMemo(() => splitSwapHolds(auto, swapHold), [preview])
  // ②-b 剩下的(连时长都拿不到)。「多份」那一组按 pendingKind 排除,不按上面那份归组后的代表行
  // ——归组只留了每集一条,拿它做 includes 会把同集的其余几条漏到「认不出」里。
  // 保持兜底语义:将来后端加了新的 pendingKind,宁可落在这里被看见,也别静默消失。
  const unknown = pending.filter(
    (a) => a.pendingKind !== 'suspect-dir' && a.pendingKind !== 'replace'
      && a.pendingKind !== 'swap-hold' && a.pendingKind !== 'duration-collision'
      && a.pendingKind !== 'evidence-conflict',
  )
  // `unknown` 再按 pendingKind 拆两类：`season-unresolved`（判不出季）有一件用户能立刻去做的事
  // （给文件夹起个带季号的名字）,和"还在探时长"那种纯等待混成一句会把这条出路藏起来——
  // 折叠行分两句、展开后各自一组,后端给的 reason 就带着那句"该怎么办"。
  const seasonUnresolved = unknown.filter((a) => a.pendingKind === 'season-unresolved')
  const durationPending = unknown.filter((a) => a.pendingKind !== 'season-unresolved')
  /** 「要你决定」摆的全部：并排择一那几组 + 卡住的等位。后者不是问句,但它同样只有人能解开
   *  （去处置占位的那份）,而且再没有别的地方摆它了——一等公民只剩两块,状态那块不收它。 */
  const decideActions = useMemo(() => [...versionGroups, ...stranded], [versionGroups, stranded])

  // 三层里的后两层默认收起——它们不是"要动手的",展开是用户主动要看细节时的事。
  const [statusOpen, setStatusOpen] = useState(false)
  const [suspectOpen, setSuspectOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)

  /**
   * 抬头那句「可省 X」——**用户的原始动机**（网盘快满了才来整理），所以摆在第一眼。
   *
   * 哪一类动作会让多少字节消失,由 `EXEC_ACTIONS`（reconcile-exec-summary.ts）逐类说了算——
   * 和确认弹窗那句「预计释放 X」同一把尺,两处不可能再各算各的。
   */
  const reclaimBytes = useMemo(() => reclaimedBytes(auto), [auto])

  /** 「目录疑似认领错误」按**目录**数,不按文件数:后端是一个文件一条,而用户要去确认的是目录。 */
  const suspectDirCount = useMemo(
    () => new Set(suspectDir.map((a) => dirOf(a.src.path))).size,
    [suspectDir],
  )

  /**
   * 抬头摘要：可省多少 · 几项可自动完成 · 几项要你定 · ⚠ 几个目录要你确认。
   * 为 0 的那段整段省略；全为 0 说「没有要你动手的」。
   */
  const summaryParts = useMemo(() => {
    const parts: ReactNode[] = []
    // 「可省」比另外两个数重一档:另外两个是任务量,它才是用户为什么要来这一趟。
    if (reclaimBytes != null) parts.push(<span key="reclaim" className="font-medium text-foreground">可省 {fmtBytes(reclaimBytes)}</span>)
    if (auto.length > 0) parts.push(<span key="auto">{auto.length} 项可自动完成</span>)
    if (decideActions.length > 0) parts.push(<span key="decide">{decideActions.length} 项要你定</span>)
    // 告警也得在摘要里露头:主区一长,那段告警就在折线以下,抬头不说 = 用户压根不知道有这回事。
    if (suspectDirCount > 0) parts.push(<span key="suspect" className="text-destructive">{suspectDirCount} 个目录要你确认</span>)
    return parts
  }, [reclaimBytes, auto.length, decideActions.length, suspectDirCount])

  /** 本地摘行:操作成功后行**立即消失**,不重载整个面板——重载会用 spinner 顶掉列表打断操作。
   *  服务端状态已由各自请求落定,本地视图只需要跟上,不需要整轮重新核对。 */
  /** 拉一次历史一致率。**失败就静默留着上一次的数**——它是参考读数，弹一屏红条盖住正在读的卡更糟。 */
  const refreshTrackRecord = () =>
    api.reconcile.suggestions(conn, { limit: 1 })
      .then((r) => setTrackRecord(r.summary))
      .catch(() => {})
  /** 开面板拉一次历史一致率。**不跟着 targetId 走**：它统计的是这套判读整体准不准，不分 show。 */
  useEffect(() => { if (open) void refreshTrackRecord() }, [open, apiBase])

  // —— 「这一轮从哪儿捡、搬去哪儿」：只读呈现（齿轮里）——
  // **看得见是必要的**：用户得知道机器在盯哪几个文件夹,否则"为什么这些文件没动"无从判断。
  // **改不了是刻意的**：换目录 = 开新的一轮整理,那条路只有一条(对话 → `reconcile_open`)。
  // 别在这里长回一个编辑器——它会是第二个写回口,而且比后端那条少一半校验与回滚。
  const currentShow = useMemo(
    () => (effectiveShows ?? []).find((s) => s.id === showId) ?? null,
    [effectiveShows, showId],
  )

  // 「可以自动完成」的每一条 = 一张 ActionCard，形状由 `reconcile-action-row.tsx` 说了算——和「将删清单」
  // 同一份渲染。两处摆的是同一批 plan action，各写一套必然分叉：将删清单先改了形状之后，用户日常
  // 看的这里还是旧的两行 truncate 形状，同一条动作在两个地方长得不一样。
  // 「库内/来源」徽标要货架地址与来源目录：预览响应自带（后端现解），老响应缺席时退回 show 配置里
  // 那份；两边都没有就整格不显示（绝不猜）。
  // ⓘ 证据卡的数据来自本轮账本行（主池 + 下架复核两处）。老响应没有 rows → 恒查不到 → 不出 ⓘ。
  // 本轮码率基线（中位数）。**两处账本行都要数进来**：主池与下架复核那一趟——复核的行走的是
  // 它自己那张证据图，漏掉一半会让基线偏。缺 explain 的行不参与（`kbpsBaselineOf` 自己滤）。
  const kbpsBaseline = useMemo(
    () => kbpsBaselineOf(
      [...(preview?.ledger?.rows ?? []), ...(preview?.ledger?.secondaryReview?.rows ?? [])]
        .map((r) => r.explain?.file.kbps),
    ),
    [preview],
  )
  const rowOpts = {
    where: whereIn(preview?.shelves ?? currentShow?.shelves, preview?.sourceDirs ?? currentShow?.sourceDirs),
    groupLabel: currentShow?.label,
    explainOf: explainLookup(preview),
    // ↳ 这条动作腾出的位置上等着的那几份——「可以自动完成」里那条删除/搬运据此说出自己的后果。
    unblocks,
    // 码率反常那条信号的**唯一生产方**。它只能在这里算：判据是"同批别的文件是多少"，而"同批"
    // 只有拿着整份 preview 才数得出来——一张卡自己看不见别的卡。不传的话那条信号永远不出现，
    // 且不会有任何报错（它是可选的）。
    kbpsBaseline,
  }
  const autoRows = buildActionRows(auto, rowOpts)
  // 「要你决定」的每一条也是同一张 ActionCard——它摆的是同一批 plan action，问的是同一个问题的
  // 另一半（这几份里哪个是这一集），只是答案由人给。以前这里另写了一套 Item 排版，同一条动作在
  // 同一个弹窗里长成两副样子，两边的 ✓ 还各指一个意思（那边"时长命中"、这边"留下"）。
  // 行与动作要能对上（按钮回传 collidesWith + 路径），所以两者配对着走，不是各排各的。
  const decideRows = decideActions.map((a) => ({ action: a, row: buildActionRows([a], rowOpts)[0] }))
    .filter((x): x is { action: ReconcilePlanAction; row: ActionRow } => !!x.row)
  // 来源目录的编辑草稿与写回**已撤**：来源目录是一次性进料，改它等于开新的一轮整理，
  // 那条路只有一条（对话里说一句 → `reconcile_open`）。留一个前端写回口就是第二个入口，
  // 而它比后端那条少一半校验与回滚。

  // —— 扫全部绑定去重 ——
  // 整理面板的 show 配置只覆盖配过的节目；影视绑定压根不进这份配置。**同一集攒了几份**这件事
  // 每条绑定都会发生，所以这里直接按绑定扫（后端合成退化配置跑同一条管线）。串行：一条一条来,
  // 每条的结果立刻进清单——网盘 API 有限流,并发拉高只会招错误,而且用户能看着它一条条长出来。
  const [dedupeOpen, setDedupeOpen] = useState(false)
  const [dedupeGroups, setDedupeGroups] = useState<DedupeGroup[]>([])
  const [dedupeScanning, setDedupeScanning] = useState(false)
  const [dedupeExecuting, setDedupeExecuting] = useState(false)
  const [dedupeExecuted, setDedupeExecuted] = useState(false)

  const scanAllBindings = async () => {
    setDedupeOpen(true)
    setDedupeGroups([])
    setDedupeExecuted(false)
    setDedupeScanning(true)
    try {
      const list = await api.netdisk.list(conn)
      for (const set of list) {
        const base = { bindingId: set.id, label: set.left?.title || set.right?.path || set.id }
        try {
          const preview = await api.reconcile.previewBinding(conn, set.id)
          setDedupeGroups((cur) => [...cur, { ...base, preview }])
        } catch (e) {
          // 一条算不出来（货架解析问题/绑定目录没了）不拦别的绑定——原因如实进清单那一行。
          setDedupeGroups((cur) => [...cur, { ...base, preview: null, error: e instanceof ApiError ? e.message : String(e) }])
        }
      }
    } catch (e) {
      toast.error('加载网盘绑定失败', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setDedupeScanning(false)
    }
  }

  /** 确认后逐条执行（同样串行）。只执行真有删除行的那些绑定——没东西删还去打一次 execute
   *  纯属白跑一轮全目录扫描。 */
  const executeAllBindings = async () => {
    setDedupeExecuting(true)
    let deleted = 0
    let failed = 0
    for (const g of dedupeGroups) {
      const hasDeletes = (g.preview?.plan ?? []).some(
        (a) => a.kind === 'delete-dup' || a.kind === 'delete-loser' || a.kind === 'delete-redundant' || a.kind === 'replace',
      )
      if (!hasDeletes) continue
      try {
        const result = await api.reconcile.executeBinding(conn, g.bindingId)
        deleted += result.deleted
        failed += result.errors.length
        setDedupeGroups((cur) => cur.map((x) => (x.bindingId === g.bindingId ? { ...x, result } : x)))
      } catch (e) {
        failed++
        const message = e instanceof ApiError ? e.message : String(e)
        setDedupeGroups((cur) => cur.map((x) => (x.bindingId === g.bindingId ? { ...x, resultError: message } : x)))
      }
    }
    setDedupeExecuting(false)
    setDedupeExecuted(true)
    toast.success(`去重完成：删除 ${deleted} 份`, { description: failed > 0 ? `${failed} 条出错，详情见清单` : undefined })
  }


  // —— 「还没配过整理」那一档 ——
  // **别在这里长出一个配置表单**（来源目录 / 付费库 / 下架库 / 名称那种），两个理由：
  //
  //  · **来源目录不该被"存"起来**——它是一次性进料，不是常驻配置（spec 2026-08-25 §1）；
  //  · 开一次整理是四步且顺序不能乱（建目录 → 建绑定 → 补下架来源 → 写配置，任一步失败要整体
  //    回滚），它在后端已经是一个原子动作（`reconcile_open`）。前端再编排一份就是第二个实现，
  //    而它一定比后端那份少一半回滚——留下的是绑定建了、下架来源没补那种半截状态。
  //
  // 现在这一档只回答"这是什么、点哪儿开始"。

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {/* 抬头 = 这是谁的整理 + 一句摘要指标。节目名进标题:面板是从某个订阅点进来的,
            "我在整理哪个节目"不该靠下面那个 Select 去认。pr-8 给右上角那个关闭 X 让位。 */}
        <DialogHeader className="space-y-1 pr-10">
          <div className="flex items-center justify-between gap-2">
            {/* 按绑定这一档没有 show，名字由调用方给（影视是作品名）——标题只写「整理」等于
                让用户对着一屏文件名猜自己在整理哪一部。 */}
            <DialogTitle>整理{currentShow ? ` · ${currentShow.label}` : byBinding && streamTitle ? ` · ${streamTitle}` : ''}</DialogTitle>
            {/* 抬头右侧这一排放的都是**面板级的口子**（不属于下面任何一层）：一次性配置的
                「认领的文件夹」、跨全库的「扫全部绑定去重」。后者原来自己占一整行，夹在摘要和
                主区之间上下都是空白——它不属于三层里的任何一层，摆在正文里就永远像块残留。 */}
            <div className="flex shrink-0 items-center gap-1">
              {/* 「让 AI 整理」——面板上唯一的整理动作（spec 2026-08-24-conversational-reconcile
                  §3.4）:组一句带 show 上下文的话发进对话列(卡片→对话上下文桥的第一个落地实例),
                  裁决与执行都在那边进行。按绑定档(影视)没有 show 配置,agent 的三工具都按 show
                  寻址,所以那一档不出这个按钮。 */}
              {currentShow && (
                <Button
                  size="mini"
                  variant="default"
                  onClick={() => void askReconcile(conn, currentShow.id, currentShow.label)}
                >
                  <Sparkles /> 让 AI 整理
                </Button>
              )}
              {/* 「扫全部绑定」是跨全库的动作。按绑定这一档是从一部作品点进来的，在那儿摆一个
                  会去动别的作品的按钮，是个不该有的走火口。 */}
              {!byBinding && (
                <Button size="mini" variant="ghost" disabled={dedupeScanning} onClick={() => void scanAllBindings()}>
                  {dedupeScanning ? <Loader2 className="animate-spin" /> : <Trash2 />} 扫全部绑定去重
                </Button>
              )}
              {/* 齿轮和自带的关闭 X 同灰同大小、还挨着（实测间距 19px）,误点代价却不对称。
                  X 是 Dialog 自带的关闭键,不动它;这边补一句 tooltip 说清自己是什么,
                  抬头的 pr 再放宽一点把两者拉开。 */}
              {currentShow && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button icon size="small" variant="ghost" aria-label="来源目录" onClick={() => setSourcesOpen(true)}>
                      <Settings />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>来源目录——整理从哪几个文件夹搬东西</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
          {preview && !needsSetup && (
            <p data-testid="reconcile-summary" className="text-[12px] text-muted-foreground">
              {/* 「没有要你动手的」而不是「没有要处理的」:同屏下面可能正摆着一行「处理中 5」,
                  说"没有要处理的"字面上和它打架——这句要说的本来就是"没有需要你出手的那部分"。 */}
              {summaryParts.length === 0
                ? '没有要你动手的'
                : summaryParts.map((node, i) => <Fragment key={i}>{i > 0 && ' · '}{node}</Fragment>)}
            </p>
          )}
        </DialogHeader>

        {configError ? (
          <p className="px-1 py-6 text-center text-[12px] text-muted-foreground">{configError}</p>
        ) : streamId && bindingsError ? (
          <div className="flex flex-col items-center gap-2 px-1 py-8 text-center text-[12px] text-muted-foreground">
            <p>{bindingsError}</p>
            <Button variant="ghost" size="small" onClick={() => setBindingsRetryTick((t) => t + 1)}>重试</Button>
          </div>
        ) : streamId && bindings === null ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 正在核对网盘绑定…
          </div>
        ) : needsSetup ? (
          // 还没配过整理。**这里曾经是一个四格表单**（来源目录 / 付费库 / 下架库 / 名称，
          // 外加一套派生规则），已经撤掉——来源目录本来就不是常驻配置，是一次性进料，
          // 让用户在表单里"存"它才是那个错（spec 2026-08-25-reconcile-as-conversation §1）。
          // 现在这一步归对话：AI 问你要整理哪个目录，然后 `reconcile_open` 一次把货架、绑定、
          // 下架来源、配置四样原子地摆好。
          <div className="flex flex-col gap-3 px-1 py-2">
            <p className="text-[12px] text-muted-foreground">
              这条订阅还没配过整理。整理是把网盘里的散文件认到节目单上的某一集——源站还列着、
              但放不出来的那些集靠它补音频。
            </p>
            {/* 两个概念长得像、容易混:这里连的是「付费集没声音」——源站还挂着这一集,只是放不出来,
                网盘文件补的是音频。源站压根不再提供的集(下架)是另一件事,走「添加来源」挑
                「网盘目录（音频）」把那个目录当成一条来源加进来,会给订阅新增条目,不是给已有条目
                补音频。一句话分清,不展开机制。 */}
            <p className="text-[12px] text-muted-foreground">
              源站已经不再提供的集是另一回事，用「添加来源」把那个网盘目录当成一条来源加进来。
            </p>
            <Button
              size="small"
              variant="default"
              className="self-start"
              onClick={() => void askOpenReconcile(conn, streamId!, streamTitle ?? streamId!)}
            >
              <Sparkles /> 让 AI 整理
            </Button>
          </div>
        ) : effectiveShows && effectiveShows.length === 0 ? (
          <p className="px-1 py-6 text-center text-[12px] text-muted-foreground">后端还没配置 show。</p>
        ) : (
          // `data-nested-surface` 挂在**容器**上：那条 CSS 是后代选择器
          // （`[data-nested-surface="true"] [data-slot="card"]`），挂在 Card 自己身上不会
          // 让它退色——它会落回 --acr-surface，light 下就是白面板上一张白卡 = 隐形。
          // 分区不靠分割线/边框,靠间距（层与层之间 gap-4，层内 gap-1.5）与材质深浅。
          // `scrollbar-mac` 不是装饰：不加的话这里用的是浏览器默认滚动条，dark/acrylic 下是一条
          // 亮白轨道，比面板里任何内容都响。那个类按 `--acr-scrollbar` 上色，三档主题各自翻。
          <div data-nested-surface="true" className="scrollbar-mac flex max-h-[62vh] flex-col gap-4 overflow-y-auto pr-1">
            {effectiveShows && effectiveShows.length > 1 && (
              <Select value={showId ?? undefined} onValueChange={setShowId}>
                <SelectTrigger aria-label="选择节目">
                  <SelectValue placeholder="选择节目" />
                </SelectTrigger>
                <SelectContent>
                  {effectiveShows.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* 货架地址解不出来 = 整理整个跑不了。后端把原因原样下发,那句话就是"该去补哪一样
                东西"的指路——**留在主面板上,别收进齿轮**,藏起来的告警等于没说。 */}
            {currentShow && !currentShow.shelves && (
              <p className="px-1 text-[11px] text-destructive">{currentShow.shelvesProblem ?? '货架地址还没配齐——整理跑不了。'}</p>
            )}

            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> 正在核对网盘与曲库…
              </div>
            ) : previewError ? (
              <p className="px-1 py-6 text-center text-[12px] text-muted-foreground">{previewError}</p>
            ) : preview ? (
              <>
                {auto.length === 0 && pending.length === 0 && (
                  <p className="px-1 py-8 text-center text-[12px] text-muted-foreground">没有要处理的——来源目录和曲库是对齐的。</p>
                )}

                {/* 层一之首:主区。**它不是一张 Card,只是一个标题行**——Card 的边界该圈住"一个
                    决定"（一集怎么处置），圈住一整组等于没圈。面在下面每一张 ActionCard 上，
                    这里和「要你决定」「处理中」那些标题同级同形。 */}
                {auto.length > 0 && (
                  <section className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      {/* 主区的标题给 foreground:它领着整个面板的主要内容,和下面那些次级/状态
                          标题一样用 muted 的话,层级读起来就是"一个灰小标题 + 一个很响的按钮"。 */}
                      <h3 className="px-1 text-[12px] font-medium text-foreground">可以自动完成 <Badge variant="secondary" size="sm">{auto.length}</Badge></h3>
                    </div>
                    {/* **整个面板只有一个滚动区**（外层那个 62vh 的容器），各组都不再自带 max-h +
                        overflow：套着滚会同时画出两条滚动条（外层容器无论溢不溢出都占着 15px 轨道，
                        实测），主区还被死死钉在 34vh 上——状态区折起来腾出来的高度它一点也拿不到。
                        实测（1680×893）：摘掉这个上限后弹窗 492→657px（占屏 55%→74%），主区可见
                        2.9 条动作 → 5 条，滚动条 2 条 → 1 条。 */}
                    <div className="flex flex-col gap-1.5">
                      {autoRows.map((row) => (
                        <ActionCard key={row.key} row={row} />
                      ))}
                    </div>
                  </section>
                )}

                {/* 层一之二:要你决定。标题按**用户要做的事**命名——「同一集有几个文件」说的是机器
                    观察到的现象,读完还得自己翻译成"那我要干嘛"。怎么看的那句提示进内容区顶部:
                    挂在标题尾巴上会把标题撑成一句话,计数徽标也就淹了。 */}
                {decideActions.length > 0 && (
                  <section className="flex flex-col gap-1.5">
                    <h3 className="px-1 text-[12px] font-medium text-muted-foreground">
                      要你决定 <Badge variant="secondary" size="sm">{decideActions.length}</Badge>
                    </h3>
                    <p className="px-1 text-[11px] text-muted-foreground">裁决在对话里进行——点上方「让 AI 整理」，拿不准的它会把证据摆给你选</p>
                    <AiTrackRecord summary={trackRecord} />
                    {/* 裁决按钮已整体撤掉（spec 2026-08-24-conversational-reconcile §3.2）：
                        是/不是/留哪份/候选点选/不再提醒/让 AI 听/全部采纳全部归对话——卡片 UI 的
                        动作集合在设计时定死,例外的正确动作是长尾(346 那张"认第一个候选、顺带识别
                        第三个是字节级副本"就装不进任何按钮)。ActionCard 不传 actions/ai 等 props
                        即纯展示;证据(时长对比/候选/码率/reason)保留,人在对话里被问到时来这儿看全文。 */}
                    <div className="flex flex-col gap-1.5">
                      {decideRows.map(({ row }) => (
                        <ActionCard key={row.key} row={row} />
                      ))}
                    </div>
                  </section>
                )}

                {/* 层二:唯一一条「你得去改配置」的告警——**不折叠**,折起来就等于把"整个目录
                    认错了"这件事藏了。但也压成标题 + 一句原因:清单是证据,不是主角,默认收起。 */}
                {suspectDir.length > 0 && (
                  <section className="flex flex-col gap-1">
                    <h3 className="px-1 text-[12px] font-medium text-destructive">
                      ⚠ 这个目录多数文件认不出属于本节目 <Badge variant="secondary" size="sm">{suspectDir.length}</Badge>
                    </h3>
                    {/* 同一目录下所有行的 reason 是同一句(后端按目录判的),展示一次就够,别每行重复。 */}
                    {suspectDir[0].reason && (
                      <p className="px-1 text-[11px] text-muted-foreground">{suspectDir[0].reason}</p>
                    )}
                    {/* 不给「不再提醒」——那是写豁免决定,对认错整个目录这种情况是误导。
                        正确出路是换一个来源目录，而那件事归对话（编辑器已撤，见文件头注）。 */}
                    <p className="px-1 text-[11px] text-muted-foreground">多半是来源目录指错了。在对话里说一句换成哪个目录，AI 会重开一轮，这些行就没了。</p>
                    <Button
                      size="mini" variant="ghost" className="self-start text-[11px]"
                      aria-expanded={suspectOpen}
                      onClick={() => setSuspectOpen((v) => !v)}
                    >
                      {suspectOpen ? <ChevronDown /> : <ChevronRight />}
                      {suspectOpen ? '收起' : `看这 ${suspectDir.length} 个文件`}
                    </Button>
                    {suspectOpen && (
                      <ItemGroup>
                        {suspectDir.map((a) => (
                          <Item key={a.key + a.src.path} variant="muted" size="xs">
                            <ItemContent>
                              <ItemTitle className="truncate">{a.src.name}</ItemTitle>
                            </ItemContent>
                          </Item>
                        ))}
                      </ItemGroup>
                    )}
                  </section>
                )}

                {/* 层三:**状态,不是待办**。只剩"还在探时长"这一类——机器还没拿到判断所需的东西,
                    不问用户任何问题。收成一行,想看细节再展开。
                    等位（`swap-hold`）**不在这里**:它已经什么都判出来了,信息收进上面两块——
                    有主的挂在腾位那条动作上（↳ 后果）、卡住的进「要你决定」。摆在这儿的下场是
                    用户读不出它和第一块的因果（活体 2026-08-03）。 */}
                {unknown.length > 0 && (
                  <section className="flex flex-col gap-1.5">
                    <Button
                      size="mini" variant="ghost" className="self-start text-[11px] text-muted-foreground"
                      aria-expanded={statusOpen}
                      onClick={() => setStatusOpen((v) => !v)}
                    >
                      {statusOpen ? <ChevronDown /> : <ChevronRight />}
                      {'处理中 ' + [
                        durationPending.length > 0 ? `${durationPending.length} 个还在探时长` : null,
                        seasonUnresolved.length > 0 ? `${seasonUnresolved.length} 个文件夹判不出季，原地不动` : null,
                      ].filter(Boolean).join('、')}
                    </Button>

                    {statusOpen && unknown.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        {durationPending.length > 0 && (
                          <>
                            <h3 className="px-1 text-[12px] font-medium text-muted-foreground">
                              认不出 <Badge variant="secondary" size="sm">{durationPending.length}</Badge>
                              <span className="ml-1.5 font-normal">连时长都拿不到,机器无从判断</span>
                            </h3>
                            <ItemGroup>
                              {durationPending.map((a) => {
                                const rowKey = a.key + a.src.path
                                return (
                                  <Item key={rowKey} variant="muted" size="xs">
                                    <ItemContent>
                                      <ItemTitle className="truncate">{a.src.name}</ItemTitle>
                                    </ItemContent>
                                  </Item>
                                )
                              })}
                            </ItemGroup>
                          </>
                        )}
                        {seasonUnresolved.length > 0 && (
                          <>
                            <h3 className="px-1 text-[12px] font-medium text-muted-foreground">
                              判不出季 <Badge variant="secondary" size="sm">{seasonUnresolved.length}</Badge>
                            </h3>
                            <ItemGroup>
                              {seasonUnresolved.map((a) => {
                                const rowKey = a.key + a.src.path
                                return (
                                  <Item key={rowKey} variant="muted" size="xs">
                                    <ItemContent>
                                      <ItemTitle className="truncate">{a.src.name}</ItemTitle>
                                      {a.reason && <ItemDescription className="text-[11px]">{a.reason}</ItemDescription>}
                                    </ItemContent>
                                  </Item>
                                )
                              })}
                            </ItemGroup>
                          </>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </>
            ) : null}
          </div>
        )}
      </DialogContent>

      {/*
       * 认领的文件夹（齿轮）。内容与原来常驻那张卡**一模一样**——只换了位置：它是一次性配置，
       * 每次打开面板都占着主区顶部,却和"这一轮要处理什么"无关。
       *
       * 用**次级 Dialog** 而不是 Popover：这个编辑器自带 NetdiskDirPickerDialog,而目录选择器本身就是
       * 一个从 portal 里弹出的 Dialog——Popover 见到自己 portal 之外的焦点/点击就会关掉自己,
       * 用户点「浏览」的那一刻编辑器连根卸掉,挑完目录回来没地方落。Dialog 套 Dialog 是 Radix
       * 支持的形状（本面板早就这么套着这个目录选择器）。
       */}
      {currentShow && (
        <Dialog open={sourcesOpen} onOpenChange={setSourcesOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                这一轮从哪儿捡、搬去哪儿 <Badge variant="secondary" size="sm">{currentShow.sourceDirs.length}</Badge>
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              {/* **来源目录的编辑器撤掉了**：来源目录是一次性进料，不是常驻配置
                  （spec 2026-08-25-reconcile-as-conversation §1）。要换整理哪个目录，去对话里说
                  一句——AI 走 `reconcile_open`，那一步会把这份配置整份换掉。这里只剩"东西会搬去
                  哪"的呈现。 */}
              <p className="text-[12px] text-muted-foreground">
                本轮从 {currentShow.sourceDirs.length ? currentShow.sourceDirs.join('、') : '（没有来源目录，只在库内去重）'} 捡文件。
                要换目录在对话里说一句就行。
              </p>
              {/* 货架地址不归整理管（P8）——付费那个是绑定的落地目录，下架那个是
                  「下架」那条来源扫的目录。这里只呈现,并说清它们各自归谁,免得用户来这里找地方改。
                  解不出来的那一支**不在这里**:那是"整理整个跑不了"的告警,藏进齿轮等于不说,
                  所以留在主面板上（见 shelvesProblem 那行）。 */}
              {currentShow.shelves && (
                <p className="truncate text-[10px] text-muted-foreground" title={`${currentShow.shelves.claimed}${currentShow.shelves.secondary ? ` · ${currentShow.shelves.secondary}` : ''}`}>
                  认领的搬进 {currentShow.shelves.claimed}（绑定的目录）
                  {currentShow.shelves.secondary && `，认不出的搬进 ${currentShow.shelves.secondary}（「下架」那条来源扫的目录）`}
                </p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* 将删清单：与影视作品页的一键去重是同一个组件——两处问的是同一个问题,不该有两套呈现。 */}
      <Dialog open={dedupeOpen} onOpenChange={(next) => { setDedupeOpen(next); if (!next) setDedupeGroups([]) }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>扫全部绑定去重</DialogTitle>
            <DialogDescription>
              逐条绑定核对同一集攒了几份。先看清单——删哪几份、各自留的是哪份,确认后才动网盘;删除进夸克回收站,约 10 天内可找回。
            </DialogDescription>
          </DialogHeader>
          <div className="scrollbar-mac max-h-[62vh] overflow-y-auto pr-1">
            <DedupePreview
              groups={dedupeGroups}
              loading={dedupeScanning}
              executing={dedupeExecuting}
              executed={dedupeExecuted}
              onConfirm={() => void executeAllBindings()}
            />
          </div>
        </DialogContent>
      </Dialog>

    </Dialog>
  )
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}

