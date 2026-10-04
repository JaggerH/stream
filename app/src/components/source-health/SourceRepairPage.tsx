import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Button } from '../acrylic/button.tsx'
import { Badge } from '../acrylic/badge.tsx'
import { toast } from '../acrylic/sonner.tsx'
import { SourceIcon } from '../SourceIcon.tsx'
import { RunTimeline } from './RunTimeline.tsx'
import {
  fetchSourceHealthOf, startRepair, statusLabel, reasonText, REASON_LABEL, type SourceHealthView, type StepDiff,
} from '../../lib/api.source-health.ts'
import {
  fetchInterventionEvents, fetchInterventions, answerPermission, continueRun, cancelRun, sendMessage, resumeRun,
  acceptProposal, rejectProposal, type InterventionEvent, type InterventionRun,
} from '../../lib/api.interventions.ts'

const TERMINAL = new Set(['done', 'stopped', 'cancelled', 'error'])
const POLL_MS = 3000

/** 四格里此刻该高亮哪一格（spec 2026-09-12 §3）。 */
export function currentStage(v: SourceHealthView): 1 | 2 | 3 | 4 {
  switch (v.status) {
    case 'awaiting': return 3
    // 探索和修复在四格里占同一格：都是「agent 正在这个源上干活」。
    case 'exploring': case 'repairing': return 2
    case 'proposed': case 'unrepairable': return 4
    default: return v.run?.status === 'error' ? 4 : 1
  }
}

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}
const fmtMinutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} 分钟`

/** 历史一行里的「类型」：运行时一问要说清问的是什么，`runtime-ask` 三个字读的人对不上任何事。 */
const QUESTION_LABEL: Record<string, string> = {
  state: '这是哪个页面状态',
  discriminator: '怎么把撞车的状态分开',
  transition: '这一步跳到了哪个状态',
  locator: '这一步该点哪儿',
}
export function historyKind(r: { kind: string; question?: string }): string {
  if (r.kind === 'repair') return 'agent 修复'
  if (r.kind === 'explore') return 'agent 探索建图'
  if (r.kind === 'runtime-ask') return `AI 替你答了一问${r.question ? `（${QUESTION_LABEL[r.question] ?? r.question}）` : ''}`
  return r.kind
}
/** 历史一行里的「终态」：状态词 + 产出，全部说人话；内部枚举名一个都不许漏到页面上。 */
const STATUS_WORD: Record<string, string> = {
  queued: '排队中', running: '在跑', awaiting_input: '等你拍板', awaiting_confirmation: '等你拍板',
  rate_limited: '限流暂停', paused: '暂停', done: '跑完', stopped: '停了', cancelled: '取消了', error: '没跑成',
}
const PRODUCED_WORD: Record<string, string> = {
  proposal: '给了提议', nothing: '没有产出', 'verdict-unrepairable': '判定修不了',
}
export function historyOutcome(r: { status: string; stopped?: { produced: string; reason: string } }): string {
  const s = STATUS_WORD[r.status] ?? r.status
  if (!r.stopped) return s
  return `${s}，${PRODUCED_WORD[r.stopped.produced] ?? r.stopped.produced}`
}
const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? '（空）' : s.length > 80 ? s.slice(0, 77) + '…' : s
}

function Stage({ n, title, current, done, children }: { n: 1 | 2 | 3 | 4; title: string; current: boolean; done: boolean; children: ReactNode }): ReactElement {
  return (
    <section
      data-testid={`stage-${n}`} data-current={current ? 'true' : 'false'}
      className={`rounded-lg border p-3 ${current ? 'border-amber-400/70 bg-[var(--acr-card-nested)]' : done ? 'border-border/60 opacity-80' : 'border-border/30 opacity-50'}`}
    >
      <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <span className={`inline-flex size-5 items-center justify-center rounded-full text-[11px] ${current ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground'}`}>{n}</span>
        {title}
      </h3>
      <div className="text-[12px]">{children}</div>
    </section>
  )
}

function diffLine(d: StepDiff): string {
  const where = d.step === 0 ? 'recipe 顶层' : `第 ${d.step} 步`
  if (d.kind === 'added') return `${where} · 新增整步：${short(d.after)}`
  if (d.kind === 'removed') return `${where} · 删掉整步：${short(d.before)}`
  return `${where} · ${d.field}：${short(d.before)} → ${short(d.after)}`
}

/** 校验四格压成一句人话。**没跑 ≠ 过**：probe 的 skipped 两档要原样说出来。 */
function validationSentence(v: NonNullable<SourceHealthView['proposal']>['validation']): string {
  // 四格全 `n/a` = 这份提议不是 recipe（graph 提议没有可校验的东西）。**不造一句「没跑」**：
  // 那会读成「跑了但跳过了」，而这里是根本不适用。
  if (v.schema === 'n/a' && v.version === 'n/a' && v.assertions === 'n/a' && v.probe === 'n/a') return ''
  const parts: string[] = []
  parts.push(v.schema === 'ok' ? '结构合法' : `结构不合法（${v.schema}）`)
  parts.push(v.version === 'ok' ? '版本号 +1' : `版本号不对（${v.version}）`)
  parts.push(v.assertions === 'ok' ? '断言没动' : `断言被改了（${v.assertions}）`)
  if (v.probe === 'ok') parts.push('活体试抓通过')
  else if (v.probe === 'skipped-needs-params') parts.push('没跑活体试抓（这份 recipe 要参数）')
  else if (v.probe === 'skipped-no-executor') parts.push('没跑活体试抓（这台机器没开浏览器采集）')
  else parts.push(`活体试抓没过（${v.probe}）`)
  return parts.join('，')
}

export function SourceRepairPage({ apiBase, sourceId, onBack }: { apiBase: string; sourceId: string; onBack: () => void }): ReactElement {
  const [view, setView] = useState<SourceHealthView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [events, setEvents] = useState<InterventionEvent[]>([])
  const [history, setHistory] = useState<InterventionRun[]>([])
  const [detailOpen, setDetailOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const sinceRef = useRef({ runId: '', seq: 0 })

  const load = useCallback(async () => {
    try {
      const v = await fetchSourceHealthOf(apiBase, sourceId)
      if (!alive.current) return
      setView(v); setErr(null)
      if (v.run) {
        if (sinceRef.current.runId !== v.run.id) { sinceRef.current = { runId: v.run.id, seq: 0 }; setEvents([]) }
        const { events: got } = await fetchInterventionEvents(apiBase, v.run.id, sinceRef.current.seq)
        if (alive.current && got.length) { sinceRef.current.seq = got[got.length - 1]!.seq; setEvents((prev) => [...prev, ...got]) }
      }
    } catch (e) { if (alive.current) setErr((e as Error).message) }
  }, [apiBase, sourceId])

  const loadHistory = useCallback(async () => {
    try {
      const d = await fetchInterventions(apiBase, sourceId)
      if (alive.current && Array.isArray(d?.runs)) setHistory(d.runs)
    } catch { /* 历史是附录，读不到不挡主体 */ }
  }, [apiBase, sourceId])

  useEffect(() => {
    alive.current = true
    void load(); void loadHistory()
    return () => { alive.current = false }
  }, [load, loadHistory])

  useEffect(() => {
    // 终态且没有待办就不用轮：白敲后端。等人 / 在跑 / 待写回都还会变。
    if (view && (!view.run || TERMINAL.has(view.run.status)) && view.status !== 'proposed') return
    // 历史也跟着轮：页面常常在 run 开始之前就打开了（人点「让 agent 修」就在这一页），只在挂载时拉一次的话新 run 永远不进历史。
    const t = setInterval(() => { void load(); void loadHistory() }, POLL_MS)
    return () => { clearInterval(t) }
  }, [view, load, loadHistory])

  const act = (p: Promise<unknown>, okText?: string): void => {
    setBusy(true)
    p.then(() => { if (okText) toast.success(okText); return Promise.all([load(), loadHistory()]) })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false))
  }

  if (err && !view) return <div className="p-4 text-[13px] text-destructive">读不到这个源的状态：{err}</div>
  if (!view) return <div className="p-4 text-[13px] text-muted-foreground">读取中…</div>

  const stage = currentStage(view)
  const run = view.run
  const health = view.health
  const q = view.quarantine
  const brokenAt = q?.since || health.lastAt
  const reason = reasonText(q?.reason ?? health.lastError, health.lastErrorCategory)
  const canRepair = !run || TERMINAL.has(run.status)
  /** 此刻有一条探索在跑：四格的文案整套换成探索版（spec 2026-09-12-explore §8）。 */
  const exploring = view.status === 'exploring' && view.exploration !== undefined
  const ex = view.exploration
  /** 提议是一张图而不是一份 recipe：第 ④ 格换成状态/边 + 「并进状态图」。 */
  const graphProposal = view.proposal?.kind === 'graph'
  /** 标题用探索版的两档：正在探、或探完等着并图。 */
  const exploreFlavor = exploring || graphProposal
  /** 第 ④ 格的「N 个状态、M 条边」：草稿自己那一格优先，缺席才退到正在探的现场。 */
  const graphCount = view.proposal?.graph ?? (ex ? { states: ex.states, transitions: ex.transitions } : undefined)

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="small" onClick={onBack}>← 源健康</Button>
        <span className="size-6 shrink-0 overflow-hidden rounded-sm border bg-muted">
          <SourceIcon id={view.source.id} name={view.source.title} facilityKey={view.source.facility?.key} site={view.source.site} />
        </span>
        <h2 className="text-[15px] font-bold">{view.source.title}</h2>
        <Badge variant="secondary" size="sm">{statusLabel(view.status)}</Badge>
        {view.source.pluginName ? <Badge variant="secondary" size="sm">{view.source.pluginName}</Badge> : null}
        <span className="flex-1" />
        {canRepair ? (
          <Button type="button" size="small" disabled={busy} onClick={() => act(startRepair(apiBase, view.source.id), '已让 agent 开始修')}>
            {view.status === 'unrepairable' || run?.status === 'error' ? '重试' : '让 agent 修'}
          </Button>
        ) : null}
      </div>
      {err ? <p className="text-[12px] text-destructive">最近一次刷新失败：{err}</p> : null}

      <Stage n={1} title={exploreFlavor ? '要探什么' : '坏了'} current={stage === 1} done={stage > 1}>
        {exploreFlavor ? (
          <>
            <p><span className="text-muted-foreground">facility：</span>{view.source.facility?.label ?? view.source.facility?.key ?? view.source.id}</p>
            {/* target / goal 这一轮的回执里没有（后端只给进度数字），所以不编——只报能指认这条 run 的 id。 */}
            {ex ? <p><span className="text-muted-foreground">这条探索：</span>{ex.runId}</p> : null}
          </>
        ) : view.status === 'ok' && !q ? <p>这个源现在正常。</p> : (
          <>
            <p><span className="text-muted-foreground">时间：</span>{fmtTime(brokenAt)}</p>
            <p><span className="text-muted-foreground">原因：</span>{reason}</p>
            <p className="flex flex-wrap items-center gap-1">
              <span className="text-muted-foreground">连累的频道：</span>
              {view.affectedChannels.length === 0 ? <span>没有频道直接用它</span>
                : view.affectedChannels.map((c) => <Badge key={c.id} variant="secondary" size="sm">{c.label}</Badge>)}
            </p>
            {q ? <p className="text-muted-foreground">recipe 第 {q.recipeVersion} 版被关禁；已试修 {q.attempts} 次。</p> : null}
          </>
        )}
      </Stage>

      <Stage n={2} title={exploreFlavor ? '在探' : '在修'} current={stage === 2} done={stage > 2}>
        {/* 进度是探索独有的一行：状态 / 边 / frontier 还剩几个。缺席就是「没有探索在动」，不补 0。 */}
        {ex ? <p className="font-semibold">已记 {ex.states} 个状态、{ex.transitions} 条边，frontier 还剩 {ex.remaining}</p> : null}
        {!run ? <p className="text-muted-foreground">{exploreFlavor ? '这条探索还没有 agent 会话。' : '还没有 agent 介入过。'}</p> : (
          <>
            {/* 终态一律不复述 agent 的最后一段话（可能几百字，而且结论归第 ④ 格）；在跑时只留三行。 */}
            <p className="line-clamp-3 whitespace-pre-line">{TERMINAL.has(run.status) ? '（已停止，结果见下方）' : (run.now ?? run.lastStatusNote ?? '（还没开始动）')}</p>
            <p className="text-muted-foreground">
              已用 {run.usage.turns} 轮{run.limits ? ` / ${run.limits.maxTurns}` : ''} · {fmtMinutes(run.usage.wallMs)}{run.limits ? ` / ${run.limits.maxWallMinutes} 分钟` : ''}
              {run.usage.reported ? ` · ${run.usage.promptTokens + run.usage.completionTokens} token` : ' · 用量不可用'}
            </p>
            {!TERMINAL.has(run.status) ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[12px]" placeholder="给 agent 补一句（下一轮生效）"
                  value={draft} onChange={(e) => setDraft(e.target.value)}
                />
                <Button type="button" size="small" variant="ghost" disabled={busy || !draft.trim()} onClick={() => { const t = draft.trim(); setDraft(''); act(sendMessage(apiBase, run.id, t), '已排进下一轮') }}>发给 agent</Button>
                {run.status !== 'paused' ? <Button type="button" size="small" variant="ghost" disabled={busy} onClick={() => act(cancelRun(apiBase, run.id))}>停</Button> : null}
              </div>
            ) : null}
            <details className="mt-2" open={detailOpen} onToggle={(e) => setDetailOpen((e.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-muted-foreground">详情</summary>
              {detailOpen ? <div className="mt-1"><RunTimeline events={events} /></div> : null}
            </details>
          </>
        )}
      </Stage>

      <Stage n={3} title="要你拍板" current={stage === 3} done={stage > 3}>
        {stage !== 3 || !run ? <p className="text-muted-foreground">现在没有要你决定的事。</p>
          : run.pending ? (
            <>
              <p className="font-semibold">agent 想：{run.pending.title}</p>
              {run.pending.reason ? <p className="text-muted-foreground">理由：{run.pending.reason}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {run.pending.options.map((o) => (
                  <Button key={o.optionId} type="button" size="small" variant={o.kind.startsWith('allow') ? 'default' : 'ghost'} disabled={busy}
                    onClick={() => act(answerPermission(apiBase, run.id, run.pending!.permissionId, o.optionId))}>
                    {o.name}
                  </Button>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="font-semibold">agent 停下来了：{run.stopped?.reason ? (REASON_LABEL[run.stopped.reason] ?? run.stopped.reason) : (run.lastStatusNote ?? '等你决定')}</p>
              {run.lastStatusNote ? <p className="text-muted-foreground">{run.lastStatusNote}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="small" disabled={busy}
                  onClick={() => act(continueRun(apiBase, run.id).catch((e: Error) => (e.message.includes('not-found') ? resumeRun(apiBase, run.id) : Promise.reject(e))))}>
                  再给一段（+6 轮 / +100 万 token / +20 分钟）
                </Button>
                <Button type="button" size="small" variant="ghost" disabled={busy} onClick={() => act(cancelRun(apiBase, run.id))}>停</Button>
              </div>
            </>
          )}
      </Stage>

      <Stage n={4} title={exploreFlavor ? '探好了' : '修好了'} current={stage === 4} done={false}>
        {view.proposal && graphProposal ? (
          view.proposal.status === 'accepted' ? <p>已并进状态图。</p> : (
            <>
              {/* 计数优先取 `proposal.graph`——它是这份草稿自己的数。退到 `exploration` 只是降级：
                  那是「正在探」的现场、探完就缺席，两个来源不保证相等，所以它只在草稿那一格缺席时才顶上。
                  草稿明细（按状态分组的出边清单）后端这一版没给，所以只报数字，不列一份编出来的清单。 */}
              <p>{graphCount ? `${graphCount.states} 个状态、${graphCount.transitions} 条边` : '这份草稿的状态与边后端没给明细'}</p>
              <div className="mt-2 flex gap-2">
                <Button type="button" size="small" disabled={busy} onClick={() => act(acceptProposal(apiBase, view.proposal!.id, {}), '已并进状态图')}>并进状态图</Button>
                <Button type="button" size="small" variant="ghost" disabled={busy} onClick={() => act(rejectProposal(apiBase, view.proposal!.id))}>不要</Button>
              </div>
            </>
          )
        ) : view.proposal && view.proposal.status === 'pending' ? (
          <>
            <p className="text-muted-foreground">会改：{view.proposal.recipePath}</p>
            <ul className="my-1 list-disc pl-5">
              {view.proposal.diff.length === 0 ? <li>内容没有变化（只有版本号 +1）</li> : view.proposal.diff.map((d, i) => <li key={i}>{diffLine(d)}</li>)}
            </ul>
            {validationSentence(view.proposal.validation) ? <p>{validationSentence(view.proposal.validation)}</p> : null}
            <div className="mt-2 flex gap-2">
              <Button type="button" size="small" disabled={busy} onClick={() => act(acceptProposal(apiBase, view.proposal!.id, {}), '已写回，下一轮采集用新版本')}>写回 recipe</Button>
              <Button type="button" size="small" variant="ghost" disabled={busy} onClick={() => act(rejectProposal(apiBase, view.proposal!.id))}>不要</Button>
            </div>
          </>
        ) : view.proposal && view.proposal.status === 'accepted' ? (
          <p>已写回 {view.proposal.recipePath}{validationSentence(view.proposal.validation) ? `；${validationSentence(view.proposal.validation)}` : ''}。</p>
        ) : run?.stopped?.produced === 'verdict-unrepairable' ? (
          <p className="whitespace-pre-line">agent 判定修不了：{run.verdict ?? run.lastStatusNote ?? '（它没给理由）'}</p>
        ) : run?.status === 'error' ? (
          <p className="text-destructive">这次没跑成：{reasonText(run.error?.message, run.error?.code)}</p>
        ) : run?.stopped && run.stopped.produced === 'nothing' && TERMINAL.has(run.status) ? (
          <p>这一轮停了但没有产出：{REASON_LABEL[run.stopped.reason] ?? run.stopped.reason}。</p>
        ) : <p className="text-muted-foreground">还没有结果。</p>}
      </Stage>

      {history.length > 0 ? (
        <section className="text-[12px]">
          <h3 className="mb-1 font-semibold text-muted-foreground">历史</h3>
          <ul className="flex flex-col gap-0.5">
            {history.map((r) => (
              <li key={r.id} className="flex gap-2 text-muted-foreground">
                <span className="tabular-nums">{fmtTime(r.startedAt)}</span>
                <span>{historyKind(r)}</span>
                <span>{historyOutcome(r)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
