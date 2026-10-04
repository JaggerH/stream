import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, FolderSymlink, ExternalLink, HardDrive, ChevronDown, RefreshCw, SlidersHorizontal, AlertTriangle, FolderX, Sparkles, Search } from 'lucide-react'
import { toast } from './acrylic/sonner.tsx'
import { api, ApiError, type Connection } from '../lib/api.ts'
import { askMatchSpec } from '../lib/askExtract.ts'
import type { WorkBindingView, FollowView } from '../lib/types.ts'
import { Button } from './acrylic/button.tsx'
import { Popover, PopoverTrigger, PopoverContent } from './acrylic/popover.tsx'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from './acrylic/alert-dialog.tsx'
import { NetdiskDirPickerDialog } from './netdisk/NetdiskPicker.tsx'
import { NetdiskPanel } from './netdisk/NetdiskPanel.tsx'

/**
 * 一部电影/剧集/综艺的网盘绑定 —— 影视二级页的入口。
 *
 * 三种状态，必须说得清清楚楚，因为它们要用户做的事完全不同（判据顺序：先看**绑没绑**，再看能否新建）：
 *  - **已绑定**（`binding` 有值）：一个 `[🗂 12/13 ▾]` 触发按钮——数字本身就是绑定的价值所在（绑了但
 *    一集都没配上，和没绑一样不能看）。点开是网盘管理菜单（打开目录 / 换目录 / 刷新匹配 …）。整簇管理
 *    动作收进这一个下拉，不在动作行里一字排开——`播放`/`找资源` 是每天点的两个不同意图，留在外面。
 *    **非 TMDb 的关注流（综艺）也走这支**：它 `ref` 为 null 却确实绑了，绝不能因为没坐标就当「还不能绑」。
 *  - **未绑但可绑**（`ref` 有值、`binding` 无）：只有一个动作（新建绑定），就是一个普通按钮，不套下拉。
 *  - **还不能绑**（`ref` 为 null 且未绑）：canonical 没验出 TMDb 坐标、也没有已存在的关注流绑定。
 *    给个点不动的按钮等于让用户对着它猜；直说原因。
 */
export function WorkBinding({
  conn,
  work,
  streamId,
  streamTitle,
  onChanged,
}: {
  conn: Connection
  work: WorkBindingView
  /** 非 TMDb 关注流（综艺）的 stream id——有它时，未绑且无 TMDb 坐标也能绑（走 create({streamId})）。 */
  streamId?: string
  /** 绑定显示名（可选，绑定 left 的 title）。 */
  streamTitle?: string
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  // 删网盘目录：不可逆，所以状态只有「问」和「正在删」两个，没有中间清单可看——要看内容的话
  // 菜单里「打开网盘目录」就在上面两行。
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const ref = work.ref
  const b = work.binding
  /** 发给模型的显示名：TMDb 坐标优先，其次关注流的名字，最后退到目录名——三级回落是因为
   *  综艺那一支 `ref` 恒为 null，光给一个 setId 的话人在对话里读不出这是哪一部。 */
  const label = ref?.title ?? streamTitle ?? b?.dirPath.split('/').pop() ?? ''

  async function pick(dirPath: string) {
    setPicking(false)
    setBusy(true)
    setError('')
    try {
      // 已绑 → 换绑（按 binding.id，旧目录进 rightHistory、confirmed 按指纹继承）；对综艺同样成立，
      // 换绑不依赖 TMDb 坐标。未绑但有 TMDb 坐标 → 按 TMDb 新建（ref 优先）。未绑、无坐标但有 streamId
      // （非 TMDb 关注流/综艺）→ 按 streamId 新建。三者都够不着 → 无操作（UI 不会给到这一步）。
      if (b) await api.netdisk.rebind(conn, b.id, dirPath)
      else if (ref) await api.netdisk.create(conn, { tmdb: { id: ref.id, media: ref.media, title: ref.title }, dirPath })
      else if (streamId) await api.netdisk.create(conn, { streamId, ...(streamTitle ? { title: streamTitle } : {}), dirPath })
      else return
      onChanged()
    } catch (e) {
      // 照搬原话：「AList 不可达」和「目录建不出来」要用户做的事不一样，一句「失败了」等于没说。
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 刷新匹配 = 立即重新同步：重列网盘目录、按 spec 重配（改名/移动重认、删除清成未匹配）。
  async function resync() {
    if (!b) return
    setMenuOpen(false)
    setSyncing(true)
    setError('')
    try {
      const updated = await api.netdisk.sync(conn, b.id)
      const matched = updated.entries.filter((e) => e.rightFile && (e.status === 'auto' || e.status === 'confirmed')).length
      toast.success(t('movie.bindResynced', { matched, total: updated.entries.length }))
      onChanged()
    } catch (e) {
      toast.error(t('movie.bindResyncFailed', { reason: (e as Error).message }))
    } finally {
      setSyncing(false)
    }
  }

  /** 删掉绑定目录本身（连文件）+ 解绑。两件事后端一起做：目录没了而绑定还在，就是上面那个红字
   *  `broken` 状态，没道理亲手造一个出来。失败时后端不会解绑（文件还在盘上），所以这里也不刷新。 */
  async function deleteDir() {
    if (!b) return
    setDeleting(true)
    try {
      await api.netdisk.removeWithFiles(conn, b.id)
      setDeleteOpen(false)
      toast.success(t('movie.bindDeleteDone'))
      onChanged()
    } catch (e) {
      const message = e instanceof ApiError ? e.message : (e as Error).message
      toast.error(t('movie.bindDeleteFailed', { reason: message }))
    } finally {
      setDeleting(false)
    }
  }

  // 未绑 + 无坐标 + 无 streamId = 真的还不能绑（综艺已绑 b 有值；未绑综艺有 streamId → 走下面的
  // 「未绑但可绑」按钮，按 streamId 新建）。
  if (!b && !ref && !streamId) {
    return <p className="text-[12px] text-muted-foreground">{t('movie.bindUnavailable')}</p>
  }

  return (
    <div className="flex flex-col gap-1.5">
      {b ? (
        // 已绑：一个带匹配数的下拉。整簇网盘管理动作收进来，动作行不再一字排开。
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="neutral" size="small" disabled={busy || syncing} aria-label={t('movie.bindActions')}>
              <HardDrive className="size-3.5" />
              {t('movie.bindMatchedShort', { matched: b.matched, total: b.total })}
              {busy || syncing ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronDown className="size-3.5" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-56 flex-col gap-0.5 p-1">
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {t('movie.bindMatched', { matched: b.matched, total: b.total })}
              {(b.unaired ?? 0) > 0 ? t('movie.bindUnaired', { n: b.unaired }) : null}
            </p>
            <div className="mx-1 my-0.5 h-px bg-[var(--acr-border-soft)]" />
            {/* 打开网盘目录：优先跳网盘自己的 web UI（夸克 netdiskUrl，后端按 fid 拼）；夸克解析不到 /
                非夸克挂载才回落 AList 同源网关（/_p/alist，不带内部 host，否则客户端解析不了）。 */}
            <Button asChild variant="ghost" size="small" className="w-full justify-start">
              <a
                href={b.netdiskUrl ?? conn.baseUrl.replace(/\/$/, '') + '/_p/alist' + encodeURI(b.dirPath)}
                target="_blank"
                rel="noreferrer"
                title={t('movie.bindOpenNetdisk', { path: b.dirPath })}
              >
                <ExternalLink className="size-3.5 shrink-0" />
                {t('movie.bindOpenNetdiskLabel')}
              </a>
            </Button>
            <Button type="button" variant="ghost" size="small" className="w-full justify-start" onClick={() => { setMenuOpen(false); setPicking(true) }} disabled={busy}>
              <FolderSymlink className="size-3.5 shrink-0" />
              {t('movie.bindRebind')}
            </Button>
            <Button type="button" variant="ghost" size="small" className="w-full justify-start" onClick={() => void resync()} disabled={syncing}>
              {syncing ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <RefreshCw className="size-3.5 shrink-0" />}
              {t('movie.bindResync')}
            </Button>
            {/* 网盘面板：逐集对照/订正 + 整理（同一集攒了几份留最好的那份、判不出来的待决卡
                可以让 AI 听）。播客走的是同一个面板（`NetdiskPanel`），只是这一档没有订阅，
                所以不出「挂载」那块。原来这两件事是两个入口（匹配详情 / 一键去重）。 */}
            <Button type="button" variant="ghost" size="small" className="w-full justify-start" onClick={() => { setMenuOpen(false); setDetailOpen(true) }}>
              <SlidersHorizontal className="size-3.5 shrink-0" />
              {t('movie.bindMatchDetail')}
            </Button>
            {/* 「AI 匹配」——程序配不上时用户唯一的出路，摆在「刷新匹配」和「匹配详情」旁边
                是有意的：三件事回答的是同一个问题「怎么让这几集配上」，只是一件比一件重
                （重列 → 逐条人工订正 → 让模型重写规则）。它**发出去**而不是塞输入框：
                点它就是要模型现在去干活。 */}
            <Button type="button" variant="ghost" size="small" className="w-full justify-start" onClick={() => { setMenuOpen(false); void askMatchSpec(conn, b.id, label) }}>
              <Sparkles className="size-3.5 shrink-0" />
              {t('movie.bindAiMatch')}
            </Button>
            {/* 删网盘目录：整簇动作里唯一一个删数据的，所以摆在最后、单独隔开、走 destructive 配色。
                点它只是开确认框——真删要人再点一次。 */}
            <div className="mx-1 my-0.5 h-px bg-[var(--acr-border-soft)]" />
            <Button
              type="button"
              variant="ghost"
              size="small"
              className="w-full justify-start text-destructive hover:text-destructive"
              onClick={() => { setMenuOpen(false); setDeleteOpen(true) }}
              disabled={busy || syncing}
            >
              <FolderX className="size-3.5 shrink-0" />
              {t('movie.bindDelete')}
            </Button>
          </PopoverContent>
        </Popover>
      ) : (
        // 未绑但可绑：一个新建按钮；tv 再加一个「追这部」（不必先手动绑目录，追更循环自己找分享）。
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="neutral" size="small" onClick={() => setPicking(true)} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <><FolderSymlink className="size-3.5" /> {t('movie.bindNetdisk')}</>}
          </Button>
          {ref && ref.media === 'tv' && (
            <FollowStartButton
              conn={conn}
              workRef={{ id: ref.id, media: 'tv', title: ref.title, ...(ref.year != null ? { year: ref.year } : {}) }}
              onChanged={onChanged}
            />
          )}
        </div>
      )}
      {/* 追更状态行：只对 tv 显示（电影没有「下一集」的概念）。只读展示 + 开关 + 手动触发一轮，
          不掺任何要用户在选项间做判断的控件。 */}
      {b && ref?.media === 'tv' && (
        <FollowRow conn={conn} bindingId={b.id} follow={b.follow} onChanged={onChanged} />
      )}
      {/* 坏绑定标记：绑定的网盘目录已被删/移（AList object-not-found），按 item 入口的解析（转写/声纹）
          会踩雷。亮出来让用户去换目录/删绑定，而不是对着莫名失败的功能猜。 */}
      {b?.broken && (
        <p className="flex items-center gap-1 text-[11px] text-destructive" title={b.broken.message}>
          <AlertTriangle className="size-3 shrink-0" />
          {t('movie.bindBroken')}
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <NetdiskDirPickerDialog
        apiBase={conn.baseUrl}
        open={picking}
        onOpenChange={setPicking}
        initialPath="/"
        onPick={(p) => void pick(p)}
      />
      {/* 删除确认：路径写在正文里——「删这部作品的文件」听起来像删一条记录，把真正会消失的那个
          目录摆出来，才是人做决定需要的东西。可恢复窗口也一并说清（夸克回收站约 10 天）。 */}
      {b && (
        <AlertDialog open={deleteOpen} onOpenChange={(next) => { if (!deleting) setDeleteOpen(next) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('movie.bindDeleteTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('movie.bindDeleteDesc', { path: b.dirPath })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{t('movie.bindDeleteCancel')}</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleting}
                onClick={(e) => { e.preventDefault(); void deleteDir() }}
              >
                {deleting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('movie.bindDeleteConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {/* 网盘面板：与播客同一个 `NetdiskPanel`，锁定到本绑定。关闭时通知详情刷新——面板内改过
          匹配/换绑/去重后，外面触发按钮上的配集数才跟着更新。 */}
      {b && (
        <NetdiskPanel
          apiBase={conn.baseUrl}
          open={detailOpen}
          onOpenChange={(next) => { if (!next) { setDetailOpen(false); onChanged() } }}
          bindingId={b.id}
          streamTitle={work.ref?.title ?? streamTitle ?? b.dirPath}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

/** 相对/绝对时间：与 `NetdiskBindings.tsx` 的 `formatAt` 一致（本地化字符串，非精确相对时长——
 *  这一行本就是「扫一眼」的密度，不值得为它引入相对时间库）。 */
function formatWhen(value: string): string {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

/** 「上次检查 2 小时前」——状态行要的是"多久没查了"，绝对时间戳读的人还得自己减一次。
 *  `Intl.RelativeTimeFormat` 随 i18n 语言走；超过一周就退回绝对时间（"9 天前"不如日期直观）。 */
function formatAgo(value: string, lang: string): string {
  const t = Date.parse(value)
  if (Number.isNaN(t)) return value
  const diffS = Math.round((t - Date.now()) / 1000)
  const abs = Math.abs(diffS)
  if (abs > 7 * 86400) return new Date(t).toLocaleDateString()
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  if (abs < 60) return rtf.format(diffS, 'second')
  if (abs < 3600) return rtf.format(Math.round(diffS / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diffS / 3600), 'hour')
  return rtf.format(Math.round(diffS / 86400), 'day')
}

/**
 * 追更状态行——只对已绑的 tv 显示（spec 2026-09-03-work-follow-loop §7）。**只看不判**：
 * 呈现缺集数 / 上次检查 / 来源分享健康度 / 最近几轮跑了什么，唯一两个写动作是开关和「现在就找」，
 * 不给用户在多个选项之间做判断的控件——该不该追、该信哪条分享，都是后端那个循环自己的事。
 */
function FollowRow({
  conn, bindingId, follow, onChanged,
}: {
  conn: Connection
  bindingId: string
  follow?: { enabled: boolean; nextCheckAt?: string; lastCheckAt?: string; dryRuns: number }
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation()
  const [detail, setDetail] = useState<FollowView | null>(null)
  const [enabled, setEnabled] = useState(follow?.enabled ?? false)
  const [toggling, setToggling] = useState(false)
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [undoing, setUndoing] = useState(false)

  useEffect(() => { setEnabled(follow?.enabled ?? false) }, [follow?.enabled])

  useEffect(() => {
    let cancelled = false
    api.netdisk.follow.get(conn, bindingId).then((v) => { if (!cancelled) setDetail(v) }).catch(() => {})
    return () => { cancelled = true }
  }, [conn, bindingId])

  async function toggle() {
    setToggling(true)
    const next = !enabled
    try {
      await api.netdisk.follow.set(conn, bindingId, next)
      setEnabled(next)
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setToggling(false)
    }
  }

  async function runNow() {
    setRunning(true)
    try {
      const run = await api.netdisk.follow.run(conn, bindingId)
      // 「补了 N 集」= 同步后多认出几集，不是转存了几个文件——转了但还没认出（夸克还在搬）要单独说
      const got = run.synced.matchedAfter - run.synced.matchedBefore
      const savedN = run.saved.reduce((n, s) => n + s.files.length, 0)
      toast[got > 0 ? 'success' : 'message'](got > 0 ? t('movie.followRan', { got }) : savedN > 0 ? t('movie.followRanSaved', { n: savedN }) : t('movie.followRanNone'))
      const v = await api.netdisk.follow.get(conn, bindingId)
      setDetail(v)
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  async function undoLastArchive() {
    const last = detail?.runs[0]?.archived
    if (!last) return
    setUndoing(true)
    try {
      const { undone, skipped } = await api.reconcile.undoRun(conn, last.runId)
      toast.success(t('movie.followUndone', { undone, skipped }))
      const v = await api.netdisk.follow.get(conn, bindingId)
      setDetail(v)
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUndoing(false)
    }
  }

  const missing = detail?.missingAired.length ?? 0
  const upcoming = detail?.upcoming ?? 0
  const shares = detail?.shares.length ?? 0
  const sharesDead = detail?.shares.filter((s) => s.validity === 'not-usable').length ?? 0
  const lastArchive = detail?.runs[0]?.archived

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <Button
          type="button"
          variant={enabled ? 'secondary' : 'ghost'}
          size="mini"
          aria-label={t('movie.followLabel')}
          aria-pressed={enabled}
          disabled={toggling}
          onClick={() => void toggle()}
        >
          {toggling ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {t('movie.followLabel')}
        </Button>
        {detail && (
          <>
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              onClick={() => setExpanded((v) => !v)}
              disabled={detail.runs.length === 0}
            >
              {t('movie.followMissing', { n: missing, aired: missing, upcoming })}
            </button>
            <span>·</span>
            <span>
              {follow?.lastCheckAt ? t('movie.followLastCheck', { when: formatAgo(follow.lastCheckAt, i18n.language) }) : t('movie.followNever')}
            </span>
            <span>·</span>
            <span>
              {t('movie.followShares', { n: shares })}
              {sharesDead > 0 && t('movie.followSharesDead', { n: sharesDead })}
            </span>
          </>
        )}
        <Button type="button" variant="ghost" size="mini" onClick={() => void runNow()} disabled={running}>
          {running ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />}
          {t('movie.followRunNow')}
        </Button>
      </div>
      {lastArchive && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>
            {lastArchive.gated
              ? t('movie.followArchivedGated', { detail: lastArchive.gated })
              : t('movie.followArchived', { moved: lastArchive.moved, deleted: lastArchive.deleted, renamed: lastArchive.renamed })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            onClick={() => void undoLastArchive()}
            disabled={undoing || lastArchive.moved + lastArchive.renamed === 0}
          >
            {undoing ? <Loader2 className="size-3 animate-spin" /> : null}
            {t('movie.followUndoRun')}
          </Button>
        </div>
      )}
      {expanded && detail && detail.runs.length > 0 && (
        <ul className="flex flex-col gap-0.5 rounded-[6px] bg-[var(--acr-chip)] p-1.5 text-[10px] text-muted-foreground">
          {detail.runs.slice(0, 10).map((run) => {
            const got = run.synced.matchedAfter - run.synced.matchedBefore
            return (
              <li key={run.id}>
                {formatWhen(run.at)} · {run.revisited.length} · {run.searched?.hits ?? 0} · {got} · {run.errors.length}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** 未绑分支的「追这部」：不必先手动挑目录，追更循环自己去找分享、转存、建绑定。 */
function FollowStartButton({
  conn, workRef, onChanged,
}: {
  conn: Connection
  workRef: { id: string; media: 'tv'; title: string; year?: number }
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  async function start() {
    setBusy(true)
    try {
      await api.netdisk.follow.create(conn, { id: workRef.id, media: 'tv', title: workRef.title, ...(workRef.year ? { year: workRef.year } : {}) })
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button type="button" variant="ghost" size="small" onClick={() => void start()} disabled={busy}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
      {t('movie.followStart')}
    </Button>
  )
}
