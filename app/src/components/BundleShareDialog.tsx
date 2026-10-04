import { useEffect, useState, type ChangeEvent } from 'react'
import { toast } from './acrylic/sonner.tsx'
import { api, ApiError, type Connection, type ShareRoot, type ImportRunView, type ImportItemView } from '../lib/api.ts'
import { Button } from './acrylic/button.tsx'
import { Input } from './acrylic/input.tsx'

interface Props {
  conn: Connection
  mode: 'export' | 'import'
  /** export 模式的根（频道/流/Provider）。 */
  root?: ShareRoot
  /** import 模式：若给了 bundle（前端读文件后传入），挂载即导入。 */
  seededBundle?: unknown
}

/** 配置分享面板：导出下载单 JSON / 导入（URL 或文件）→ 一次导入 = 一个 run，
 *  遗留事项（items）逐条渲染、逐条 decision。由父组件包在 Dialog 里；本组件只渲染面板内容，便于独立测试。 */
export function BundleShareDialog({ conn, mode, root, seededBundle }: Props) {
  const [busy, setBusy] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [run, setRun] = useState<ImportRunView | null>(null)
  const [url, setUrl] = useState('')
  // 能力搭车：导出勾选的非系统 Provider。
  const [caps, setCaps] = useState<Array<{ id: string; label: string; system?: boolean }>>([])
  const [pickedCaps, setPickedCaps] = useState<Set<string>>(new Set())
  // 网盘 binding 搭车（B）：可勾选的对齐绑定。
  const [netdiskSets, setNetdiskSets] = useState<Array<{ id: string; left: { title: string } }>>([])
  const [pickedNetdisk, setPickedNetdisk] = useState<Set<string>>(new Set())

  const runImport = async (payload: { url?: string; bundle?: unknown }) => {
    setBusy(true)
    try {
      setRun(await api.sharing.importBundle(conn, payload))
    } catch (e) {
      toast.error(`导入失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const onDecide = async (item: ImportItemView, choice: string) => {
    if (!run) return
    try {
      await api.sharing.decide(conn, run.id, item.id, choice)
    } catch (e) {
      // 409 = 执行冲突/已拍板（item 保持 open 或已被别处处理）——刷新后按现状继续
      toast[e instanceof ApiError && e.status === 409 ? 'warning' : 'error'](`处理失败：${(e as Error).message}`)
    }
    setRun(await api.sharing.importRun(conn, run.id).catch(() => run))
  }

  // import 模式带 seededBundle（前端读好的文件）→ 挂载即导入；export 模式拉可勾选的 Provider。
  useEffect(() => {
    if (mode === 'import' && seededBundle) void runImport({ bundle: seededBundle })
    if (mode === 'export') {
      void api.providers(conn)
        .then((rows) => setCaps((rows as Array<{ id: string; label: string; system?: boolean }>).filter((p) => p.system !== true)))
        .catch(() => setCaps([]))
      void api.netdisk.list(conn)
        .then((rows) => setNetdiskSets(rows as Array<{ id: string; left: { title: string } }>))
        .catch(() => setNetdiskSets([]))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onExport = async () => {
    if (!root) return
    setBusy(true)
    try {
      const caps = {
        ...(pickedCaps.size ? { providerIds: [...pickedCaps] } : {}),
        ...(pickedNetdisk.size ? { netdiskBindingIds: [...pickedNetdisk] } : {}),
      }
      const { bundle, warnings: w } = await api.sharing.exportBundle(conn, root, undefined,
        Object.keys(caps).length ? caps : undefined)
      setWarnings(w)
      const text = JSON.stringify(bundle, null, 2)
      const title = String(bundle.meta?.title ?? 'stream')
      const blob = new Blob([text], { type: 'application/json' })
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `${title}.stream-bundle.json`
      a.click()
      URL.revokeObjectURL(href)
      toast.success('分享包已导出')
    } catch (e) {
      toast.error(`导出失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const bundle = JSON.parse(await file.text())
      await runImport({ bundle })
    } catch (err) {
      toast.error(`文件不是合法 JSON：${(err as Error).message}`)
    }
  }

  if (mode === 'export') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--acr-text-secondary)]">
          把这个编排导出为单个 <code>stream-bundle/v1</code> JSON——凭证永不进包，可发到 gist / 任意 git 让别人导入。
        </p>
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--acr-text-secondary)]">带上我改过的能力（可选）</summary>
          {caps.length === 0
            ? <p className="mt-1 text-xs text-[var(--acr-text-secondary)]">没有可搭车的自定义 Provider（系统默认行不进包）。</p>
            : <ul className="mt-1 flex flex-col gap-1">
                {caps.map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={pickedCaps.has(p.id)} onChange={(e) => {
                        setPickedCaps((prev) => { const n = new Set(prev); e.target.checked ? n.add(p.id) : n.delete(p.id); return n })
                      }} />
                      <span>{p.label}<span className="ml-1 text-xs text-[var(--acr-text-secondary)]">{p.id}</span></span>
                    </label>
                  </li>
                ))}
              </ul>}
          {netdiskSets.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-[var(--acr-text-secondary)]">网盘对齐 binding（matchSpec 随包，对方转存后自动重算；不带 fileId/凭证）：</div>
              <ul className="mt-1 flex flex-col gap-1">
                {netdiskSets.map((m) => (
                  <li key={m.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={pickedNetdisk.has(m.id)} onChange={(e) => {
                        setPickedNetdisk((prev) => { const n = new Set(prev); e.target.checked ? n.add(m.id) : n.delete(m.id); return n })
                      }} />
                      <span>{m.left.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
        <Button onClick={onExport} disabled={busy || !root}>{busy ? '导出中…' : '生成并下载分享包'}</Button>
        {warnings.length > 0 && (
          <ul className="text-xs text-amber-500 list-disc pl-4">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </div>
    )
  }

  // import 模式
  const openItems = run?.items.filter((i) => i.status === 'open') ?? []
  const settledCount = (run?.items.length ?? 0) - openItems.length
  return (
    <div className="flex flex-col gap-3">
      {!seededBundle && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Input placeholder="贴一个分享包 URL（raw / gist / 任意 git）" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Button onClick={() => runImport({ url })} disabled={busy || !url}>导入</Button>
          </div>
          <label className="text-sm">
            或选一个本地分享包文件：
            <input type="file" accept="application/json,.json" onChange={onPickFile} className="ml-2" />
          </label>
        </div>
      )}

      {busy && <p className="text-sm">导入中…</p>}

      {run && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="text-[var(--acr-text-secondary)]">
            已导入「{run.meta.title}」{Object.keys(run.remaps).length > 0 && <>（已重映射 {Object.keys(run.remaps).length} 个撞车 id，未改动你已有的编排）</>}
          </div>

          {run.netdiskBindings.length > 0 && (
            <div>
              <div className="font-medium">网盘对齐 binding 待转存（{run.netdiskBindings.length}）：</div>
              <ul className="list-disc pl-4">
                {run.netdiskBindings.map((n) => (
                  <li key={n.id}>
                    {n.title}
                    {n.shareUrl && <> — <a href={n.shareUrl} target="_blank" rel="noreferrer" className="underline">分享链接</a></>}
                  </li>
                ))}
              </ul>
              <div className="mt-1 text-xs text-[var(--acr-text-secondary)]">
                用你自己的夸克登录态转存 → 挂进 AList → 在网盘对齐里对该绑定 rebind 到新目录，随包 matchSpec 会自动重算映射。
              </div>
            </div>
          )}

          {openItems.length > 0 && <div className="font-medium">待处理（{openItems.length}）：</div>}
          {openItems.map((item) => <ImportItemCard key={item.id} item={item} onDecide={onDecide} />)}
          {openItems.length === 0 && settledCount === run.items.length && run.items.length > 0 && (
            <div className="text-xs text-[var(--acr-text-secondary)]">全部事项已处理。</div>
          )}
          {openItems.length === 0 && run.items.length === 0 && (
            <div className="text-xs text-[var(--acr-text-secondary)]">没有需要处理的事项。</div>
          )}
        </div>
      )}
    </div>
  )
}

/** 单个遗留事项卡片：按 kind 渲染，choices 来自后端（按钮不硬编码可选集）。 */
function ImportItemCard({ item, onDecide }: { item: ImportItemView; onDecide: (item: ImportItemView, choice: string) => void }) {
  const CHOICE_LABEL: Record<string, string> = {
    'use-imported': '用导入的', 'keep-mine': '用本机的', 'append': '按序并存', 'dismiss': '先不管',
  }
  const buttons = (
    <div className="mt-1 flex gap-2">
      {item.choices.map((c) => (
        <Button key={c} variant={c === 'use-imported' ? undefined : 'neutral'} onClick={() => onDecide(item, c)}>
          {CHOICE_LABEL[c] ?? c}
        </Button>
      ))}
    </div>
  )

  if (item.kind === 'slot-conflict') {
    const sides = [
      { title: '本机（现在生效）', side: item.mine },
      { title: '包内传入', side: item.theirs },
    ]
    return (
      <div className="rounded border border-[var(--acr-border-soft)] p-2">
        <div>{String((item.subject as { channelId?: string }).channelId)} · {String((item.subject as { callsiteId?: string }).callsiteId)}</div>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {sides.map(({ title, side }) => (
            <div key={title} className="rounded border border-[var(--acr-border-soft)] p-2">
              <div className="text-xs text-[var(--acr-text-secondary)]">{title}</div>
              <ul>
                {(side?.providers ?? side?.providerIds.map((id) => ({ id, label: id, parked: false })) ?? []).map((p) => (
                  <li key={p.id}>{p.label}{p.parked && <span className="ml-1 text-xs text-amber-500">（未激活）</span>}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {buttons}
      </div>
    )
  }

  if (item.kind === 'parked-provider') {
    const subject = item.subject as { label?: string; serves?: string[] }
    return (
      <div className="rounded border border-[var(--acr-border-soft)] p-2">
        <div>{subject.label}<span className="ml-1 text-xs text-[var(--acr-text-secondary)]">{(subject.serves ?? []).join(', ')}</span></div>
        {(item.conflicts?.length ?? 0) > 0 && (
          <div className="mt-1 text-xs text-amber-500">
            {item.conflicts!.map((c) => c.kind === 'serves-overlap'
              ? `与本机 ${c.rivalProviderId} 在 [${(c.overlapKeys ?? []).join(', ')}] 上重叠`
              : c.kind === 'fallback-overlap'
                ? `与本机 ${c.rivalProviderId} 同为 ${c.category} 的兜底行，未命中的键归谁将由 id 序决定`
                : `binding 覆盖抢占已占用的 ${c.callsiteId}`).join('；')}
          </div>
        )}
        {buttons}
      </div>
    )
  }

  // notice：纯告知，只有 dismiss
  return (
    <div className="rounded border border-[var(--acr-border-soft)] p-2 text-[var(--acr-text-secondary)]">
      <div>{item.detail}</div>
      {buttons}
    </div>
  )
}
