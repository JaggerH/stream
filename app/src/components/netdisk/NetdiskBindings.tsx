import { useEffect, useMemo, useState } from 'react'
import { RefreshCwIcon, PlusIcon, Trash2Icon, FolderSyncIcon, FolderOpenIcon, PencilIcon, XIcon } from 'lucide-react'
import { toast } from '../acrylic/sonner.tsx'
import { Button } from '../acrylic/button.tsx'
import { Badge } from '../acrylic/badge.tsx'
import { Input } from '../acrylic/input.tsx'
import { Skeleton } from '../acrylic/skeleton.tsx'
import { Switch } from '../ui/switch.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../acrylic/select.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../acrylic/dialog.tsx'
import { Item, ItemContent, ItemTitle, ItemDescription, ItemActions } from '../acrylic/item.tsx'
import { Card } from '../acrylic/card.tsx'
import { NetdiskDirPickerDialog, NetdiskFilePickerDialog } from './NetdiskPicker.tsx'
import { api, type Connection } from '../../lib/api.ts'
import type { MappingSet, MappingEntry, NetdiskEntryStatus, Stream } from '../../lib/types.ts'

const STATUS_LABEL: Record<NetdiskEntryStatus, string> = {
  confirmed: '自动', // 不经由 UI 产生（人工订正走 corrected → 显示「人工」）；兜底当自动看待
  auto: '自动',
  pending: '待定',
  rejected: '未配对',
  unmatched: '未配对',
}
const STATUS_VARIANT: Record<NetdiskEntryStatus, 'secondary' | 'outline'> = {
  confirmed: 'secondary',
  auto: 'secondary',
  pending: 'outline',
  rejected: 'outline',
  unmatched: 'outline',
}

/** 一条 entry 的状态展示：人工订正过 → 「人工」（用户标注的 ground truth）；否则按机器状态。 */
function entryStatusBadge(e: { status: NetdiskEntryStatus; corrected?: unknown }): { label: string; variant: 'secondary' | 'outline' } {
  if (e.corrected) return { label: '人工', variant: 'secondary' }
  return { label: STATUS_LABEL[e.status], variant: STATUS_VARIANT[e.status] }
}

function formatAt(value?: string): string {
  if (!value) return '从未同步'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

function statusCounts(set: MappingSet): string {
  let manual = 0, auto = 0, pending = 0, unmatched = 0
  for (const e of set.entries) {
    if (e.corrected) manual++
    else if (e.status === 'auto' || e.status === 'confirmed') auto++
    else if (e.status === 'pending') pending++
    else unmatched++ // unmatched / rejected
  }
  return [
    auto && `自动 ${auto}`,
    pending && `待定 ${pending}`,
    unmatched && `未配对 ${unmatched}`,
    manual && `人工 ${manual}`,
  ].filter(Boolean).join(' · ')
}

/**
 * 网盘绑定表（对齐层）— 一份可复用组件，三处入口共用：
 *  - Stream 详情「网盘」区块：传 `streamId`，只列该订阅的绑定，建绑定锁定到当前 stream。
 *  - AList 插件详情「绑定」tab：不传参，列全部绑定 + 匹配健康度，建绑定弹 stream 选择器。
 *  - 影视二级页「网盘 ▾ → 匹配详情」：传 `focusSetId`，锁定到单个绑定（含 tmdb 作品绑定，
 *    它没有 streamId、streamId 那条路够不着它）——隐藏左侧列表，直接铺该绑定的单绑定详情
 *    （逐集对照 / 逐集订正 / 换绑 / 删除）。它复用的就是汇总视图里 `selected` 那套
 *    单绑定详情布局，只是把 aside 收起、visible 收敛到这一个。
 * 无自带 ShellPanel/Navbar 外壳，宿主（Sheet / 插件详情面板）自带外壳，这里只渲染内容。
 */
export function NetdiskBindings({
  apiBase = '',
  streamId,
  focusSetId,
  className,
}: {
  apiBase?: string
  /** 限定到某个订阅：过滤列表 + 建绑定锁定该 streamId（不传 = 汇总视图，建绑定用 stream 选择器）。 */
  streamId?: string
  /** 限定到单个绑定（按 setId）：隐藏列表、铺单绑定详情。用于详情页「匹配详情」，够得着 tmdb 绑定。 */
  focusSetId?: string
  className?: string
}) {
  const conn: Connection = { baseUrl: apiBase }
  const [sets, setSets] = useState<MappingSet[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streams, setStreams] = useState<Stream[]>([])
  const [newStreamId, setNewStreamId] = useState(streamId ?? '')
  const [newDirPath, setNewDirPath] = useState('')
  // 目录选择器弹窗（建绑定选目录）。
  const [pickerOpen, setPickerOpen] = useState(false)
  // 重新绑定目录选择器弹窗。
  const [rebindPickerOpen, setRebindPickerOpen] = useState(false)
  const [rebindTargetId, setRebindTargetId] = useState<string | null>(null)
  // 新建/添加绑定对话框。
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  // 文件选择器弹窗：正在订正哪条 entry（leftKey），null = 关闭。
  const [editKey, setEditKey] = useState<string | null>(null)
  // 多绑定视图下「订正时浏览哪个绑定目录」——同时决定订正写进哪个绑定（setId）。
  // 通用的文件选择器只回一个相对文件名，「这个名字属于哪个绑定」是网盘绑定自己的
  // 概念，所以这个选择留在这一层，不进选择器。
  const [browseDirId, setBrowseDirId] = useState('')
  // 本次打开期间用户是否在表头下拉里动过浏览目录（Important 2）：默认点「编辑」会把
  // 浏览目录钉回条目自己所在的绑定，但如果用户已经显式选了另一个目录，编辑不该无声
  // 覆盖那个选择——否则「已配对的条目改绑到另一个目录」得先清除、改下拉、再重新编辑，
  // 中间还要经过一次「先破坏再重建」的状态。用户的显式选择优先于自动钉住；弹窗关闭时
  // 清掉这个标记，不带进下一次编辑。
  const [dirManuallyChosen, setDirManuallyChosen] = useState(false)
  // 表内过滤：只看未匹配（rightFile 空）的条目。
  const [onlyUnmatched, setOnlyUnmatched] = useState(false)
  // 文件利用明细展开：哪条绑定的未用文件列表正在展开。
  const [expandedOrphanId, setExpandedOrphanId] = useState<string | null>(null)

  const isStreamView = !!streamId

  // 汇总视图（无 streamId）的建绑定需要一个 stream 选择器 → 拉全部订阅。
  useEffect(() => {
    if (streamId) return
    let alive = true
    void api.streams(conn).then((s) => { if (alive) setStreams(s) }).catch(() => {})
    return () => { alive = false }
  }, [apiBase, streamId])

  const visible = useMemo(
    () => (focusSetId ? sets.filter((s) => s.id === focusSetId) : streamId ? sets.filter((s) => s.left.streamId === streamId) : sets),
    [sets, streamId, focusSetId],
  )
  const selected = useMemo(() => visible.find((s) => s.id === selectedId) ?? null, [visible, selectedId])

  // 合并多绑定视图下的清单条目。若一个 leftKey 在任何一个绑定下配上了，都视为已配上。
  const mergedEntries = useMemo(() => {
    if (!isStreamView) return []
    const uniqueKeys = Array.from(new Set(visible.flatMap((s) => s.entries.map((e) => e.leftKey))))
    return uniqueKeys.map((leftKey) => {
      const matches = visible
        .map((s) => {
          const entry = s.entries.find((e) => e.leftKey === leftKey)
          return entry ? { entry, setId: s.id, path: s.right.path } : null
        })
        .filter(Boolean) as Array<{ entry: MappingEntry; setId: string; path: string }>

      // 排序优先级：人工订正优先 > 自动成功优先 > 未配对。
      //
      // **先判有没有文件，再谈订正**：把一条已配在 A 的条目改绑到 B，两边都会被标成
      // `corrected`——A 是「被清空」（rightFile 变 null，corrected.autoFile 记着原来自动配的
      // 那个），B 是「收到文件」。只看 corrected 两边同分，同分按绑定顺序取第一个，于是取到
      // 被清空的 A：改绑明明成功了，表里却显示「未配对」，而且 setId 指向空的那个绑定，
      // 下次点「编辑」又回到 A。谁手里真的有文件，谁才是 best。
      const best = matches.sort((a, b) => {
        const score = (x: typeof a) => {
          if (!x.entry.rightFile) return 0
          if (x.entry.corrected) return 3
          if (x.entry.status === 'confirmed') return 2
          if (x.entry.status === 'auto') return 1
          return 0
        }
        return score(b) - score(a)
      })[0]

      return {
        leftKey,
        leftTitle: best?.entry.leftTitle ?? '',
        rightFile: best?.entry.rightFile ?? null,
        status: best?.entry.status ?? 'unmatched',
        corrected: best?.entry.corrected ?? false,
        confidence: best?.entry.confidence,
        lastError: best?.entry.lastError,
        setId: best?.setId ?? visible[0]?.id ?? '',
        path: best?.path ?? '',
      }
    })
  }, [visible, isStreamView])

  const selectedEntry = useMemo(
    () => mergedEntries.find((e) => e.leftKey === editKey) ?? null,
    [mergedEntries, editKey],
  )

  /** 订正弹窗当前浏览的那个绑定（多绑定视图）。绑定列表变了就回落到第一个。 */
  const browseDir = useMemo(
    () => visible.find((s) => s.id === browseDirId) ?? visible[0] ?? null,
    [visible, browseDirId],
  )

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.netdisk.list(conn)
      setSets(list)
      const vis = focusSetId ? list.filter((s) => s.id === focusSetId) : streamId ? list.filter((s) => s.left.streamId === streamId) : list
      setSelectedId((prev) => (prev && vis.some((s) => s.id === prev) ? prev : vis[0]?.id ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [apiBase])

  useEffect(() => {
    setSelectedId((prev) => (prev && visible.some((s) => s.id === prev) ? prev : visible[0]?.id ?? null))
  }, [visible])

  useEffect(() => {
    setExpandedOrphanId(null)
    setOnlyUnmatched(false)
  }, [selected?.id])

  const replaceSet = (next: MappingSet) => setSets((cur) => cur.map((s) => (s.id === next.id ? next : s)))

  const createBinding = async () => {
    const sid = (streamId ?? newStreamId).trim()
    if (!sid || !newDirPath.trim()) return
    setBusy(true); setError(null)
    try {
      const title = streams.find((s) => s.id === sid)?.description
      const set = await api.netdisk.create(conn, { streamId: sid, title, dirPath: newDirPath.trim() })
      setSets((cur) => [...cur, set])
      setSelectedId(set.id)
      if (!streamId) setNewStreamId('')
      setNewDirPath('')
    } catch (err) { setError(err instanceof Error ? err.message : '建绑定失败') } finally { setBusy(false) }
  }

  const syncBinding = async (id: string) => {
    setBusy(true); setError(null)
    try { replaceSet(await api.netdisk.sync(conn, id)) }
    catch (err) { setError(err instanceof Error ? err.message : '同步失败') } finally { setBusy(false) }
  }

  const syncAllBindings = async () => {
    setBusy(true); setError(null)
    try {
      await Promise.all(visible.map(async (s) => {
        const next = await api.netdisk.sync(conn, s.id)
        replaceSet(next)
      }))
      toast.success('所有绑定的目录已同步完成')
    } catch (err) {
      setError(err instanceof Error ? err.message : '同步失败')
    } finally {
      setBusy(false)
    }
  }

  const executeRebind = async (id: string, dirPath: string) => {
    if (!dirPath.trim()) return
    setBusy(true); setError(null)
    try { replaceSet(await api.netdisk.rebind(conn, id, dirPath.trim())) }
    catch (err) { setError(err instanceof Error ? err.message : '重绑失败') } finally { setBusy(false) }
  }

  const removeBinding = async (id: string) => {
    setBusy(true); setError(null)
    try {
      await api.netdisk.remove(conn, id)
      setSets((cur) => cur.filter((s) => s.id !== id))
      setSelectedId((cur) => (cur === id ? null : cur))
    } catch (err) { setError(err instanceof Error ? err.message : '删除失败') } finally { setBusy(false) }
  }

  const patchEntry = async (id: string, leftKey: string, body: { rightFile?: string | null; status?: MappingEntry['status'] }) => {
    setBusy(true); setError(null)
    try { replaceSet(await api.netdisk.patchEntry(conn, id, leftKey, body)) }
    catch (err) { setError(err instanceof Error ? err.message : '修正失败') } finally { setBusy(false) }
  }

  return (
    <div className={`flex flex-col gap-4 ${className ?? ''}`}>
      <div className="flex min-h-0 gap-4">
        {/* 左栏：绑定列表 + 新建（仅在全局汇总视图展示；单 stream 详情、单绑定 focus 视图都隐藏 aside） */}
        {!isStreamView && !focusSetId && (
          <aside className="flex w-64 flex-none flex-col gap-2 min-h-0">
            {error && <p className="text-[12px] text-destructive">{error}</p>}
            {/* 「新建绑定」在列表**之前**：它是这一栏的动作，不是列表的尾巴。摆在列表后面时，
                绑定一多就被顶出视口——越是绑定多的人越找不到它，而那正是要建新绑定的人。 */}
            <div className="sticky top-0 z-10 bg-[var(--acr-panel)] flex flex-col gap-1.5 rounded-md border border-[var(--acr-border-soft)] p-2">
              <span className="text-[11px] font-medium text-muted-foreground">新建绑定</span>
              {streams.length ? (
                <Select value={newStreamId || undefined} onValueChange={setNewStreamId}>
                  <SelectTrigger size="small" aria-label="选择订阅" className="w-full">
                    <SelectValue placeholder="选择订阅…" />
                  </SelectTrigger>
                  <SelectContent>
                    {streams.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.description || s.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input placeholder="播单 streamId" value={newStreamId} onChange={(e) => setNewStreamId(e.target.value)} />
              )}
              <div className="flex items-center gap-1">
                <Input placeholder="AList 目录（如 /夸克/剧集）" value={newDirPath} onChange={(e) => setNewDirPath(e.target.value)} />
                <Button
                  variant="ghost"
                  size="small"
                  aria-label="浏览网盘目录"
                  onClick={() => setPickerOpen(true)}
                >
                  <FolderOpenIcon />
                </Button>
              </div>
              <NetdiskDirPickerDialog
                apiBase={apiBase}
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                initialPath={newDirPath.trim() || '/'}
                onPick={setNewDirPath}
              />
              <Button
                variant="neutral"
                size="small"
                disabled={busy || !newStreamId.trim() || !newDirPath.trim()}
                onClick={() => void createBinding()}
              >
                <PlusIcon />
                建绑定并同步
              </Button>
            </div>
            {loading && visible.length === 0 ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <ul
                /* 显式 max-h 是这条滚动真正生效的那一半：aside 没有高度约束，光有
                   `flex-1 min-h-0` 会被内容撑开，overflow 永远没机会触发。 */
                className="flex flex-col gap-1 flex-1 min-h-0 max-h-[70vh] overflow-y-auto scrollbar-mac"
              >
                {visible.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      aria-label={`绑定 ${s.left.title}`}
                      className={`w-full rounded-md border px-3 py-2 text-left text-[12px] ${
                        s.id === selectedId ? 'border-[var(--acr-border)] bg-[var(--acr-card-nested)]' : 'border-transparent hover:bg-[var(--acr-card-nested)]'
                      }`}
                    >
                      <div className="truncate font-medium text-foreground">{s.left.title}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{s.right.path}</div>
                      <div className="mt-1 flex items-center justify-between gap-1">
                        <span className="truncate text-[10.5px] text-muted-foreground">{statusCounts(s) || '空'}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">同步：{formatAt(s.lastSyncAt)}</div>
                    </button>
                  </li>
                ))}
                {!loading && visible.length === 0 ? (
                  <li className="rounded-md border border-dashed border-[var(--acr-border-soft)] px-3 py-4 text-center text-[11px] text-muted-foreground">
                    还没有任何网盘绑定。
                  </li>
                ) : null}
              </ul>
            )}
          </aside>
        )}

        {/* 右栏：对照表 */}
        <div className="min-w-0 flex-1">
          {error && isStreamView && <p className="text-[12px] text-destructive mb-2">{error}</p>}
          
          {isStreamView ? (
            /* Stream 编辑详情页专属布局：多绑定平铺 + 统一合并列表 */
            visible.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 border border-dashed border-[var(--acr-border-soft)] rounded-xl bg-[var(--acr-card-nested)] max-w-md mx-auto my-8 text-center space-y-4 shadow-sm">
                <FolderOpenIcon className="size-10 text-muted-foreground opacity-60" />
                <div className="space-y-1">
                  <h3 className="text-[13.5px] font-semibold text-foreground">该订阅还没有网盘绑定。</h3>
                  <p className="text-[11.5px] text-muted-foreground leading-normal">
                    将 AList 网盘中的特定剧集目录与当前订阅绑定，系统会自动将网盘文件与订阅剧集进行对齐。
                  </p>
                </div>
                <div className="w-full flex items-center gap-1.5 pt-2">
                  <Input
                    placeholder="AList 目录（如 /夸克/剧集）"
                    value={newDirPath}
                    onChange={(e) => setNewDirPath(e.target.value)}
                    className="text-[12px]"
                  />
                  <Button
                    variant="ghost"
                    size="small"
                    aria-label="浏览网盘目录"
                    onClick={() => setPickerOpen(true)}
                  >
                    <FolderOpenIcon />
                  </Button>
                </div>
                <Button
                  variant="neutral"
                  className="w-full"
                  size="small"
                  disabled={busy || !newDirPath.trim()}
                  onClick={() => void createBinding()}
                >
                  <PlusIcon />
                  建绑定并同步
                </Button>
                <NetdiskDirPickerDialog
                  apiBase={apiBase}
                  open={pickerOpen}
                  onOpenChange={setPickerOpen}
                  initialPath={newDirPath.trim() || '/'}
                  onPick={setNewDirPath}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {/* 网盘目录平铺展示区块 */}
                <Card className="rounded-xl border border-[var(--acr-border-soft)] p-3 shadow-none">
                  <div className="flex items-center justify-between pb-2 border-b border-[var(--acr-border-soft)] mb-2">
                    <span className="text-[12px] font-semibold text-foreground flex items-center gap-1.5">
                      <FolderOpenIcon className="size-3.5 text-primary shrink-0" />
                      网盘绑定目录
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button variant="ghost" size="small" onClick={() => setAddDialogOpen(true)}>
                        <PlusIcon />
                        添加绑定目录
                      </Button>
                      <Button variant="ghost" size="small" disabled={busy} onClick={syncAllBindings}>
                        <RefreshCwIcon />
                        立即同步
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {visible.map((s) => {
                      const coverageText = s.coverage
                        ? `利用 ${s.coverage.right.matched}/${s.coverage.right.total}`
                        : '未同步'
                      const statusText = `${statusCounts(s) || '空'} · ${coverageText}`

                      return (
                        <Item
                          key={s.id}
                          variant="muted"
                          size="sm"
                          className="min-w-[240px] max-w-[320px] border border-[var(--acr-border-soft)]"
                        >
                          <ItemContent>
                            <ItemTitle className="font-mono text-[11px] truncate max-w-[200px]" title={s.right.path}>
                              {s.right.path}
                            </ItemTitle>
                            <ItemDescription className="text-[10px] text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5">
                              <span>{statusText}</span>
                            </ItemDescription>
                          </ItemContent>

                          <ItemActions className="border-l border-[var(--acr-border-soft)] pl-2 ml-1 shrink-0 flex-col gap-1">
                            <Button
                              variant="ghost"
                              size="mini"
                              className="px-1.5 py-0 text-[10px] h-4.5 rounded-[4px] w-10 text-center"
                              disabled={busy}
                              onClick={() => {
                                setRebindTargetId(s.id)
                                setRebindPickerOpen(true)
                              }}
                            >
                              重绑
                            </Button>
                            <Button
                              variant="ghost"
                              size="mini"
                              className="px-1.5 py-0 text-[10px] h-4.5 rounded-[4px] w-10 text-center text-destructive hover:text-destructive hover:bg-destructive/10"
                              disabled={busy}
                              onClick={() => void removeBinding(s.id)}
                            >
                              删除
                            </Button>
                          </ItemActions>
                        </Item>
                      )
                    })}
                  </div>
                </Card>

                {/* 清单与网盘文件合并对齐列表 */}
                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="text-[11px] text-muted-foreground">
                    共 {mergedEntries.length} 条 · 未匹配 {mergedEntries.filter((e) => !e.rightFile).length} 条
                  </span>
                  <div className="flex items-center gap-2">
                    {/* 多个绑定目录时才有得选。它决定「编辑」弹窗从哪个目录开始浏览，
                        也决定订正写进哪个绑定——未配对的条目直接用这里选的目录；已配对
                        的条目默认仍从它自己所在的目录开始（见下面「编辑」按钮），但一旦
                        用户在这里手动选过，就优先尊重那个选择：改绑到另一个目录不需要
                        先清除再重新编辑，选好目录直接点「编辑」即可。 */}
                    {visible.length > 1 && (
                      <div className="flex items-center gap-1.5">
                        <span className="shrink-0 text-[11px] text-muted-foreground">订正时浏览：</span>
                        <Select
                          value={browseDir?.id ?? ''}
                          onValueChange={(v) => { setBrowseDirId(v); setDirManuallyChosen(true) }}
                        >
                          <SelectTrigger size="small" className="w-[200px] font-mono text-[11px]" aria-label="切换订正时浏览的目录">
                            <SelectValue placeholder="选择目录…" />
                          </SelectTrigger>
                          <SelectContent>
                            {visible.map((s) => (
                              <SelectItem key={s.id} value={s.id} className="font-mono text-[11px]">
                                {s.right.path}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <Switch id="only-unmatched" checked={onlyUnmatched} onCheckedChange={setOnlyUnmatched} />
                      <label htmlFor="only-unmatched" className="cursor-pointer select-none text-[11px] text-muted-foreground">
                        只看未匹配
                      </label>
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-[var(--acr-border-soft)] text-left text-muted-foreground font-medium">
                        <th className="py-1.5 pr-2 font-medium">清单条目</th>
                        <th className="py-1.5 pr-2 font-medium">网盘文件</th>
                        <th className="py-1.5 pr-2 font-medium">状态</th>
                        <th className="py-1.5 font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(onlyUnmatched ? mergedEntries.filter((e) => !e.rightFile) : mergedEntries).map((e) => {
                        const badge = entryStatusBadge(e)
                        const folderName = e.path.split('/').filter(Boolean).pop() || '根'
                        return (
                          <tr key={e.leftKey} className="border-b border-[var(--acr-border-soft)] align-top">
                            <td className="py-1.5 pr-2">
                              <div className="text-foreground">{e.leftTitle}</div>
                              <code className="text-[10px] text-muted-foreground">{e.leftKey}</code>
                              {e.lastError && (
                                <div className="mt-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400">
                                  最近走了回落：{e.lastError.message}
                                </div>
                              )}
                            </td>
                            <td className="py-1.5 pr-2">
                              {e.rightFile ? (
                                <button
                                  type="button"
                                  title={`文件路径：${e.path}/${e.rightFile}`}
                                  onClick={() => { void navigator.clipboard?.writeText(e.rightFile!); toast.success('已复制文件名') }}
                                  className="inline-flex flex-wrap items-center gap-1.5 max-w-[320px] text-left text-[11px] text-foreground hover:text-primary break-all"
                                >
                                  <span className="shrink-0 text-[10px] text-muted-foreground bg-[var(--acr-card-nested)] px-1 py-0.2 rounded font-mono border border-[var(--acr-border-soft)]" title={e.path}>
                                    {folderName}
                                  </span>
                                  <span>{e.rightFile}</span>
                                </button>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">未配对</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-2">
                              <Badge variant={badge.variant} size="sm">{badge.label}</Badge>
                              {typeof e.confidence === 'number' && !e.corrected && (
                                <span className="ml-1 text-[10px] text-muted-foreground">{e.confidence.toFixed(2)}</span>
                              )}
                            </td>
                            <td className="py-1.5 whitespace-nowrap">
                              <Button variant="ghost" size="mini" disabled={busy} aria-label={`编辑 ${e.leftTitle}`}
                                onClick={() => {
                                  setEditKey(e.leftKey)
                                  // 已配对的条目默认从它当前所在的那个绑定目录开始浏览（和以前一样）；
                                  // 未配对的沿用上面选的目录，这样「这批缺的都在剧集2 里」可以一条接
                                  // 一条订正，不用每次重选。但如果用户已经在上面下拉里手动选过目录
                                  // （dirManuallyChosen），那个显式选择优先——不无声覆盖它，否则
                                  // 「已配对的条目改绑到另一个目录」永远够不着，见 Important 2。
                                  if (e.rightFile && !dirManuallyChosen) setBrowseDirId(e.setId)
                                }}>
                                <PencilIcon />
                                编辑
                              </Button>
                              {/* 清除配对以前藏在文件选择器脚上（要先开弹窗、等一次递归列举才点得到）。
                                  它和「挑一个文件」不是一回事，摆在行上一步就能做完。 */}
                              {e.rightFile && (
                                <Button variant="ghost" size="mini" disabled={busy}
                                  className="text-muted-foreground"
                                  aria-label={`清除配对 ${e.leftTitle}`}
                                  onClick={() => void patchEntry(e.setId, e.leftKey, { rightFile: null })}>
                                  <XIcon />
                                  清除
                                </Button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* browseDir 为空时干脆不渲染这个弹窗——把「路径不存在」的钳制交给一个
                    哨兵空串（旧写法 dirPath={browseDir?.right.path ?? ''}）会让 isWithinDir
                    的前缀退化成 '/'，任何路径都判定"在内"，钳制形同虚设。当前 visible.length
                    恒 > 0（这个分支只在非空列表下渲染）使它不可达，但不该把安全判据建立在一个
                    "现在恰好不可达"的前提上。 */}
                {browseDir && (
                  <NetdiskFilePickerDialog
                    apiBase={apiBase}
                    open={editKey != null}
                    onOpenChange={(o) => { if (!o) { setEditKey(null); setDirManuallyChosen(false) } }}
                    dirPath={browseDir.right.path}
                    entryTitle={selectedEntry?.leftTitle}
                    // current 只在「正在浏览的目录」恰好就是这条条目真正配上的那个绑定时才
                    // 传：底层选择器一旦拿到非空 current 就会把确认键点亮成可点（vendored
                    // FilePickerDialog 的 confirm 按钮是 disabled={!value}，不知道这是
                    // commitOnSelect 模式、点它本来就没必要）。多绑定视图里 browseDir（浏览
                    // 目录，来自 browseDirId 回落逻辑）和 selectedEntry（mergedEntries 里的
                    // best 匹配）是两个独立来源，一旦不同源，current 这个文件名对浏览目录而言
                    // 根本不存在——传了就等于把「点亮的确认键」瞄准一次数据损坏：点它会把 A
                    // 绑定的文件名写进 B 绑定。同源时才传，跨源直接传 null：确认键回到
                    // disabled，用户必须真的点一个文件，选中的名字保证来自当前浏览目录。
                    current={selectedEntry && selectedEntry.setId === browseDir.id ? selectedEntry.rightFile : null}
                    onPick={(file) => {
                      if (!editKey) return
                      // 换了绑定目录就把旧目录里那条配对撤掉，否则同一条清单条目会同时挂在两个绑定上。
                      const prevMatch = selectedEntry
                      if (prevMatch && prevMatch.setId !== browseDir.id && prevMatch.rightFile) {
                        void patchEntry(prevMatch.setId, editKey, { rightFile: null })
                      }
                      void patchEntry(browseDir.id, editKey, { rightFile: file })
                    }}
                  />
                )}

                <NetdiskDirPickerDialog
                  apiBase={apiBase}
                  open={rebindPickerOpen}
                  onOpenChange={setRebindPickerOpen}
                  initialPath={visible.find(s => s.id === rebindTargetId)?.right.path || '/'}
                  onPick={(dirPath) => {
                    if (rebindTargetId) {
                      void executeRebind(rebindTargetId, dirPath)
                    }
                  }}
                />

                <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>添加网盘目录绑定</DialogTitle>
                      <DialogDescription>
                        为当前订阅绑定另一个 AList 网盘目录，系统将同时跟踪和对齐该目录下的文件。
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="flex items-center gap-1.5">
                        <Input
                          placeholder="AList 目录（如 /夸克/剧集2）"
                          value={newDirPath}
                          onChange={(e) => setNewDirPath(e.target.value)}
                          className="text-[12px]"
                        />
                        <Button
                          variant="ghost"
                          size="small"
                          aria-label="浏览网盘目录"
                          onClick={() => setPickerOpen(true)}
                        >
                          <FolderOpenIcon />
                        </Button>
                      </div>
                      <NetdiskDirPickerDialog
                        apiBase={apiBase}
                        open={pickerOpen}
                        onOpenChange={setPickerOpen}
                        initialPath={newDirPath.trim() || '/'}
                        onPick={setNewDirPath}
                      />
                    </div>
                    <DialogFooter>
                      <Button variant="ghost" size="small" onClick={() => setAddDialogOpen(false)}>
                        取消
                      </Button>
                      <Button
                        variant="neutral"
                        size="small"
                        disabled={busy || !newDirPath.trim()}
                        onClick={() => {
                          void createBinding().then(() => setAddDialogOpen(false))
                        }}
                      >
                        <PlusIcon />
                        建绑定并同步
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            )
          ) : (
            /* 全局汇总视图（无 streamId）：保持原有的单绑定列表详情结构 */
            !selected ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>未选择绑定</EmptyTitle>
                  <EmptyDescription>在左侧选择或新建一个网盘绑定。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between pb-3 border-b border-[var(--acr-border-soft)] mb-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-foreground flex items-center gap-1.5">
                      <FolderOpenIcon className="size-3.5 text-primary" />
                      <span>已绑定：{selected.left.title}</span>
                    </div>
                    <code className="mt-1 block w-fit rounded border border-[var(--acr-border-soft)] bg-[var(--acr-card-nested)] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {selected.right.path}
                    </code>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="small" disabled={busy} onClick={() => void syncBinding(selected.id)}>
                      <RefreshCwIcon />
                      立即同步
                    </Button>
                    <Button variant="ghost" size="small" disabled={busy} onClick={() => setRebindPickerOpen(true)}>
                      <FolderSyncIcon />
                      重新绑定目录
                    </Button>
                    <Button variant="destructive" size="small" disabled={busy} onClick={() => void removeBinding(selected.id)}>
                      <Trash2Icon />
                      删除绑定
                    </Button>
                  </div>
                </div>

                {selected.coverage && (
                  <div className="rounded-md border border-[var(--acr-border-soft)] bg-[var(--acr-card-nested)] px-3 py-2 text-[11px]" data-slot="netdisk-coverage">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-muted-foreground">
                        文件利用　右 {selected.coverage.right.total} · 已配 {selected.coverage.right.matched}
                        {' · '}未用 {selected.coverage.right.orphan}
                      </span>
                      {selected.coverage.orphanFiles.length > 0 && (
                        <Button variant="ghost" size="mini" className="flex-none"
                          onClick={() => setExpandedOrphanId(expandedOrphanId === selected.id ? null : selected.id)}>
                          {expandedOrphanId === selected.id ? '收起' : '看未用'}
                        </Button>
                      )}
                    </div>
                    {expandedOrphanId === selected.id && (
                      <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto rounded bg-[var(--acr-card)] px-2 py-1 text-[10.5px] text-muted-foreground font-mono">
                        {selected.coverage.orphanFiles.map((f) => (
                          <li key={f} className="break-all">{f}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    共 {selected.entries.length} 条 · 未匹配 {selected.entries.filter((e) => !e.rightFile).length}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Switch id="only-unmatched" checked={onlyUnmatched} onCheckedChange={setOnlyUnmatched} />
                    <label htmlFor="only-unmatched" className="cursor-pointer select-none text-[11px] text-muted-foreground">
                      只看未匹配
                    </label>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-[var(--acr-border-soft)] text-left text-muted-foreground">
                        <th className="py-1.5 pr-2 font-medium">清单条目</th>
                        <th className="py-1.5 pr-2 font-medium">网盘文件</th>
                        <th className="py-1.5 pr-2 font-medium">状态</th>
                        <th className="py-1.5 font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(onlyUnmatched ? selected.entries.filter((e) => !e.rightFile) : selected.entries).map((e) => {
                        const badge = entryStatusBadge(e)
                        return (
                          <tr key={e.leftKey} className="border-b border-[var(--acr-border-soft)] align-top">
                            <td className="py-1.5 pr-2">
                              <div className="text-foreground">{e.leftTitle}</div>
                              <code className="text-[10px] text-muted-foreground">{e.leftKey}</code>
                              {e.lastError && (
                                <div className="mt-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400">
                                  最近走了回落：{e.lastError.message}
                                </div>
                              )}
                            </td>
                            <td className="py-1.5 pr-2">
                              {e.rightFile ? (
                                <button
                                  type="button"
                                  title="点击复制文件名"
                                  aria-label={`复制文件名 ${e.rightFile}`}
                                  onClick={() => { void navigator.clipboard?.writeText(e.rightFile!); toast.success('已复制文件名') }}
                                  className="block max-w-[280px] whitespace-normal break-all text-left text-[11px] text-foreground hover:text-primary"
                                >
                                  {e.rightFile}
                                </button>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">未配对</span>
                              )}
                            </td>
                            <td className="py-1.5 pr-2">
                              <Badge variant={badge.variant} size="sm">{badge.label}</Badge>
                              {typeof e.confidence === 'number' && !e.corrected && (
                                <span className="ml-1 text-[10px] text-muted-foreground">{e.confidence.toFixed(2)}</span>
                              )}
                            </td>
                            <td className="py-1.5 whitespace-nowrap">
                              <Button variant="ghost" size="mini" disabled={busy} aria-label={`编辑 ${e.leftTitle}`}
                                onClick={() => setEditKey(e.leftKey)}>
                                <PencilIcon />
                                编辑
                              </Button>
                              {/* 清除配对以前藏在文件选择器脚上；它和「挑一个文件」不是一回事，摆在行上一步做完。 */}
                              {e.rightFile && (
                                <Button variant="ghost" size="mini" disabled={busy}
                                  className="text-muted-foreground"
                                  aria-label={`清除配对 ${e.leftTitle}`}
                                  onClick={() => void patchEntry(selected.id, e.leftKey, { rightFile: null })}>
                                  <XIcon />
                                  清除
                                </Button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <NetdiskFilePickerDialog
                  apiBase={apiBase}
                  open={editKey != null}
                  onOpenChange={(o) => { if (!o) setEditKey(null) }}
                  dirPath={selected.right.path}
                  entryTitle={selected.entries.find((e) => e.leftKey === editKey)?.leftTitle}
                  current={selected.entries.find((e) => e.leftKey === editKey)?.rightFile ?? null}
                  onPick={(file) => { if (editKey) void patchEntry(selected.id, editKey, { rightFile: file }) }}
                />

                <NetdiskDirPickerDialog
                  apiBase={apiBase}
                  open={rebindPickerOpen}
                  onOpenChange={setRebindPickerOpen}
                  initialPath={selected.right.path || '/'}
                  onPick={(dirPath) => void executeRebind(selected.id, dirPath)}
                />
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}
