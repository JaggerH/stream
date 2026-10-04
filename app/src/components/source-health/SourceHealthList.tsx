import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Button } from '../acrylic/button.tsx'
import { Badge } from '../acrylic/badge.tsx'
import { toast } from '../acrylic/sonner.tsx'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '../acrylic/item.tsx'
import { SourceIcon } from '../SourceIcon.tsx'
import { fetchSourceHealth, startRepair, statusLabel, needsAttention, type SourceHealthView } from '../../lib/api.source-health.ts'
import { startExploration, fetchExploreFacilities, type ExploreFacility } from '../../lib/api.interventions.ts'

const ACTIVE = new Set(['queued', 'running', 'awaiting_input', 'awaiting_confirmation', 'rate_limited', 'paused'])
const POLL_MS = 5000

/**
 * 「探索建图」小表单（spec 2026-09-12-explore §8）。facility 下拉来自装了的 recipe 包；
 * 读不到包（或包里没有 facility）就退回文本框让人手填——后端认不认由它自己回 400 说。
 */
function ExploreForm({ apiBase, onOpened, onClose }: { apiBase: string; onOpened: (sourceId: string) => void; onClose: () => void }): ReactElement {
  const [facilities, setFacilities] = useState<ExploreFacility[] | null>(null)
  const [facility, setFacility] = useState('')
  const [target, setTarget] = useState('')
  const [goal, setGoal] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    // 不拿第一个包去预填 facility：那份名单**只有 npm 装的包**，内置包（xhs 这些）一个都不在里面。
    // 预填等于把一个碰巧排第一的第三方包摆成默认答案，而用户多半要探的是内置那个。
    void fetchExploreFacilities(apiBase).then((f) => { if (alive) setFacilities(f) })
    return () => { alive = false }
  }, [apiBase])

  const submit = (): void => {
    setBusy(true); setErr(null)
    startExploration(apiBase, { facility: facility.trim(), target: target.trim(), goal: goal.trim() })
      .then(() => {
        // 回执只有 runId：要跳的那一行得自己从包里取该 facility 的首源。取不到就别瞎跳——
        // 探索**已经开了**，说清楚它在哪儿找比把人送到一个空页面强。
        const first = facilities?.find((f) => f.facility === facility.trim())?.sourceIds?.[0]
        if (first) { onOpened(first) } else { toast.success('已开，去源健康列表里点它'); onClose() }
      })
      .catch((e: Error) => setErr(e.message.replace(/^\d{3}\s*/, '').slice(0, 300)))
      .finally(() => setBusy(false))
  }

  const canSubmit = !busy && facility.trim() !== '' && target.trim() !== '' && goal.trim() !== ''
  const inputCls = 'min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[12px]'

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-lg border p-3 text-[12px]">
      {/* 手填那一格**永远在**：`GET /api/recipes/packages` 只列 npm 装的包，内置包（xhs 这些）
          一个都不在里面。只给下拉的话，装了任意一个第三方包就会把内置的探索目标全挡在外面，
          而界面看起来完全正常——下拉里有东西，只是没有你要的那个。下拉只是个快捷方式，回填进这一格。 */}
      <label className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-muted-foreground">facility</span>
        <input aria-label="facility" className={inputCls} placeholder="facility" value={facility} onChange={(e) => setFacility(e.target.value)} />
      </label>
      {facilities && facilities.length > 0 ? (
        <label className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">装了的包</span>
          <select aria-label="装了的包" className={inputCls} value="" onChange={(e) => { if (e.target.value) setFacility(e.target.value) }}>
            <option value="">（从装了的 recipe 包里挑一个填上）</option>
            {facilities.map((f) => <option key={f.facility} value={f.facility}>{f.facility}</option>)}
          </select>
        </label>
      ) : null}
      <label className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-muted-foreground">target</span>
        <input aria-label="target" className={inputCls} placeholder="chrome:<tabId>" value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <p className="pl-[4.5rem] text-muted-foreground">用 cdp_pages 或从地址栏看不到 tabId 时先在 Chrome 里开好那一页。</p>
      <label className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-muted-foreground">goal</span>
        <input aria-label="goal" className={inputCls} placeholder="到搜索结果页" value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <Button type="button" size="small" disabled={!canSubmit} onClick={submit}>开始探索</Button>
        <Button type="button" size="small" variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
      </div>
      {err ? <p className="text-destructive">{err}</p> : null}
    </div>
  )
}

/**
 * 运维页「源健康」：只列此刻不健康的源（spec 2026-09-12 §4 入口 3）。
 * 「让 agent 修」= 手动拉起，不管它是被关禁还是只是黄了；已有活跃会话的不给按钮（后端也会 409）。
 * 顶栏另有「探索建图」：那条 run 挂在 facility 上，不针对某个坏源，所以它不在行里而在顶栏。
 */
export function SourceHealthList({ apiBase, onOpen }: { apiBase: string; onOpen: (sourceId: string) => void }): ReactElement {
  const [rows, setRows] = useState<SourceHealthView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<Record<string, string>>({})
  const [exploring, setExploring] = useState(false)
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const d = await fetchSourceHealth(apiBase)
      if (alive.current && Array.isArray(d?.sources)) { setRows(d.sources); setErr(null) }
    } catch (e) { if (alive.current) setErr((e as Error).message) }
  }, [apiBase])

  useEffect(() => {
    alive.current = true
    void load()
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => { alive.current = false; clearInterval(t) }
  }, [load])

  const repair = (id: string): void => {
    setNote((n) => ({ ...n, [id]: '正在拉起…' }))
    startRepair(apiBase, id)
      .then(() => { setNote((n) => { const { [id]: _, ...rest } = n; return rest }); return load() })
      .catch((e: Error) => setNote((n) => ({ ...n, [id]: e.message.replace(/^\d{3}\s*/, '').slice(0, 200) })))
  }

  // 顶栏（含「探索建图」）在任何一档下都要在：全绿时照样要能开一条探索。
  const header = (
    <div className="mb-2 flex items-center gap-2">
      <span className="flex-1" />
      <Button type="button" size="small" variant="ghost" onClick={() => setExploring((v) => !v)}>探索建图</Button>
    </div>
  )

  const body = (): ReactElement => {
    if (err && rows === null) return <p className="text-[13px] text-destructive">读不到源健康：{err}</p>
    if (rows === null) return <p className="text-[13px] text-muted-foreground">读取中…</p>
    if (rows.length === 0) return <p className="text-[13px] text-muted-foreground">所有源正常</p>
    return (
      <ItemGroup className="gap-1">
        {rows.map((v) => {
          const busy = v.run !== undefined && ACTIVE.has(v.run.status)
          return (
            <Item key={v.source.id} variant="outline" size="sm" asChild className={needsAttention(v.status) ? 'border-amber-400/70' : ''}>
              <div role="button" tabIndex={0} onClick={() => onOpen(v.source.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(v.source.id) }} className="cursor-pointer">
                <ItemMedia variant="icon"><SourceIcon id={v.source.id} name={v.source.title} facilityKey={v.source.facility?.key} site={v.source.site} /></ItemMedia>
                <ItemContent>
                  <ItemTitle className="flex items-center gap-2">
                    <span className="truncate font-extrabold">{v.source.title}</span>
                    <Badge variant="secondary" size="sm" className={needsAttention(v.status) ? 'text-amber-600' : ''}>{statusLabel(v.status)}</Badge>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-1">
                    {v.affectedChannels.length > 0 ? `连累 ${v.affectedChannels.length} 个频道` : '没有频道直接用它'}
                    {v.health.lastError ? ` · ${v.health.lastError}` : ''}
                    {note[v.source.id] ? ` · ${note[v.source.id]}` : ''}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {busy ? null : (
                    <Button type="button" size="small" variant="ghost" onClick={(e) => { e.stopPropagation(); repair(v.source.id) }}>让 agent 修</Button>
                  )}
                </ItemActions>
              </div>
            </Item>
          )
        })}
      </ItemGroup>
    )
  }

  return (
    <div className="p-4">
      {header}
      {exploring ? <ExploreForm apiBase={apiBase} onOpened={(id) => { setExploring(false); onOpen(id) }} onClose={() => setExploring(false)} /> : null}
      {body()}
    </div>
  )
}
