import { useMemo } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from './acrylic/button.tsx'
import { Badge } from './acrylic/badge.tsx'
import { ActionCard, buildActionRows, explainLookup, fmtBytes, whereIn } from './reconcile-action-row.tsx'
import type { ReconcileExecResult, ReconcilePreview } from '../lib/types.ts'

/**
 * 一条绑定的将删清单（预览 + 执行结果）。`preview` 与 `error` 恰有一个有值：预览失败的绑定
 * **照样占一行**，把原因原样摆出来——批量扫时一条失败不该让别的绑定跟着消失，用户也需要知道
 * 是哪一部作品没算出来。
 */
export interface DedupeGroup {
  bindingId: string
  /** 作品/节目名（人读的抬头）。 */
  label: string
  preview: ReconcilePreview | null
  /** 预览失败的原因（后端原文）。 */
  error?: string
  /** 执行结果（确认之后逐条回填）。 */
  result?: ReconcileExecResult
  /** 执行本身失败（请求都没成功）的原因。 */
  resultError?: string
}

/** 待定的种类 → 人话。分组键是后端的 `pendingKind`（机器可读），**绝不解析中文 reason**。 */
const PENDING_LABEL: Record<string, string> = {
  replace: '下架货架上已有同一集，比不出高下',
  'no-duration': '时长还没探到，下一轮续探',
  // **只说位置被什么占着，不承诺时间点。** 「等下一轮自然落位」对"卡住"那一档是假话：
  // 占位者本轮谁都不动时，没有任何一条动作会去腾它，它永远不会"自动搬入"。而这个面板
  // 分不出是哪一档——分档判据是"占位者在不在本轮计划里"（`splitSwapHolds`），只有整理面板
  // 做了那一步。这里只说对两档都成立的那件事。
  'swap-hold': '位置被货架上同集/同名的旧份占着，本轮搬不进去',
  'suspect-dir': '目录疑似认领错误',
  'duration-collision': '时长撞上某一集，但名字完全不沾——是不是同一集要你定',
}

/**
 * 「将删清单」——删除类动作的必经之路（spec 2026-07-31 §5：删不可逆，比搬运高一档，
 * 定时轮也不许自动删质量落选者）。整理面板的批量扫和影视作品页的一键去重**共用这一个组件**，
 * 不各写一份：两处问的是同一个问题——删哪几份、各自留的是哪份、一共省多少。
 *
 * 一条动作的形状（一张 `ActionCard`）由 `reconcile-action-row.tsx` 说了算，整理面板的「可以自动完成」摆的是
 * 同一份——同一条动作在两个地方长得不一样，谁也说不清哪个是准的。
 */
export function DedupePreview({
  groups,
  loading,
  executing,
  executed,
  onConfirm,
}: {
  groups: DedupeGroup[]
  /** 预览还在跑（批量扫时也可以边跑边把已完成的绑定摆出来）。 */
  loading?: boolean
  executing?: boolean
  /** 已经执行过：确认按钮收起，只剩结果。 */
  executed?: boolean
  onConfirm: () => void
}) {
  const rows = useMemo(
    () =>
      groups.flatMap((g) =>
        buildActionRows(
          // 这里只问"删哪几份"，所以按**白名单**取删除类三种。写成"排除 move"曾经等价，
          // 但 `buildActionRows` 后来也会给要人回答的待定出卡片了——那时这句会把待定算进
          // 「将删 N 份」，而它们一份都不删。待定另有 `PendingSection` 摆。
          (g.preview?.plan ?? []).filter(
            (a) => a.kind === 'delete-dup' || a.kind === 'delete-loser' || a.kind === 'delete-redundant' || a.kind === 'replace',
          ),
          {
            where: whereIn(g.preview?.shelves, g.preview?.sourceDirs),
            groupLabel: g.label,
            showGroupLabel: groups.length > 1,
            keyPrefix: g.bindingId,
            // 同一份渲染就该有同一份证据：这里的卡片也是整理面板那一批 plan action。
            explainOf: explainLookup(g.preview),
          },
        ),
      ),
    [groups],
  )
  // "省多少"算的是**被删掉**的那份（换正主行删的是现任，不是上位那份）。
  const freed = rows.reduce((sum, r) => sum + (r.goneSize ?? 0), 0)
  const pendingTotal = groups.reduce((sum, g) => sum + (g.preview?.counts.pending ?? 0), 0)
  // 探测/AList 失败的行：「错误是行，不是日志」，预览阶段就得看得见——它解释了为什么有些集没进清单。
  const ledgerErrors = groups.flatMap((g) => (g.preview?.ledger?.errors ?? []).map((e) => ({ label: g.label, ...e })))

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-muted-foreground" data-testid="dedupe-summary">
        将删 <span className="font-medium text-foreground">{rows.length}</span> 份，共省{' '}
        <span className="font-medium text-foreground">{fmtBytes(freed)}</span>
        {pendingTotal > 0 && <>，另有 {pendingTotal} 条待定（机器不替你裁，这次不动）</>}
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 正在核对网盘…
        </div>
      )}

      {/* 预览失败的绑定：原因原样呈现。批量扫时它不拦别的绑定。 */}
      {groups.filter((g) => g.error).length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="px-1 text-[12px] font-medium text-destructive">算不出清单 <Badge variant="secondary" size="sm">{groups.filter((g) => g.error).length}</Badge></h3>
          {groups.filter((g) => g.error).map((g) => (
            <p key={g.bindingId} className="px-1 text-[11px] text-muted-foreground">
              <span className="text-foreground">{g.label}</span>：{g.error}
            </p>
          ))}
        </section>
      )}

      {rows.length === 0 && !loading ? (
        <p className="px-1 py-6 text-center text-[12px] text-muted-foreground">没有要删的——每一集都只有一份。</p>
      ) : (
        // 一条动作一张 Card,所以容器是普通的纵向 flex,不是 ItemGroup（那是 Item 的组）。
        <div className="scrollbar-mac flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto">
          {rows.map((row) => (
            <ActionCard key={row.key} row={row} />
          ))}
        </div>
      )}

      <PendingSection groups={groups} />

      {ledgerErrors.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="px-1 text-[12px] font-medium text-muted-foreground">核对时出的错 <Badge variant="secondary" size="sm">{ledgerErrors.length}</Badge></h3>
          {ledgerErrors.map((e, i) => (
            <p key={i} className="px-1 font-mono text-[10px] text-muted-foreground">
              [{e.stage}] {e.path ? `${baseName(e.path)}：` : ''}{e.detail}
            </p>
          ))}
        </section>
      )}

      {!executed && (
        <Button
          variant="neutral"
          size="small"
          className="self-start"
          disabled={executing || loading || rows.length === 0}
          onClick={onConfirm}
        >
          {executing ? <><Loader2 className="size-3.5 animate-spin" /> 执行中…</> : <><Trash2 className="size-3.5" /> 确认执行（删 {rows.length} 份）</>}
        </Button>
      )}

      <ResultSection groups={groups} />
    </div>
  )
}

/** 待定行：按 `pendingKind` 归组简列——这次不动它们，但用户得知道还剩什么没解决。 */
function PendingSection({ groups }: { groups: DedupeGroup[] }) {
  const byKind = new Map<string, number>()
  for (const g of groups) {
    for (const a of g.preview?.plan ?? []) {
      if (a.kind !== 'pending') continue
      const kind = a.pendingKind ?? 'no-duration'
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
    }
  }
  if (byKind.size === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 text-[12px] font-medium text-muted-foreground">这次不动的 <Badge variant="secondary" size="sm">{[...byKind.values()].reduce((a, b) => a + b, 0)}</Badge></h3>
      {[...byKind.entries()].map(([kind, n]) => (
        <p key={kind} className="px-1 text-[11px] text-muted-foreground" data-testid={`pending-${kind}`}>
          {PENDING_LABEL[kind] ?? kind} <span className="tabular-nums">× {n}</span>
        </p>
      ))}
    </section>
  )
}

/** 执行结果：动了多少 + 逐条错误**原样**列出（汇总成「N 条出错」等于把线索吞掉）。 */
function ResultSection({ groups }: { groups: DedupeGroup[] }) {
  const done = groups.filter((g) => g.result || g.resultError)
  if (done.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 text-[12px] font-medium text-muted-foreground">执行结果</h3>
      {done.map((g) => (
        <div key={g.bindingId} className="flex flex-col gap-0.5 px-1">
          <p className="text-[11px] text-muted-foreground">
            <span className="text-foreground">{g.label}</span>：
            {g.resultError ? g.resultError : `删除 ${g.result!.deleted}，移动 ${g.result!.moved}${g.result!.errors.length ? `，${g.result!.errors.length} 条出错` : ''}`}
          </p>
          {(g.result?.errors ?? []).map((e, i) => (
            <p key={i} className="font-mono text-[10px] text-destructive">{e}</p>
          ))}
        </div>
      ))}
    </section>
  )
}

function baseName(p: string): string {
  return p ? p.slice(p.lastIndexOf('/') + 1) : ''
}
