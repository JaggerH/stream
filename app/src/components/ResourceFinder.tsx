import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Copy, FolderSymlink, Loader2 } from 'lucide-react'
import { toast } from './acrylic/sonner.tsx'
import { api, type Connection } from '../lib/api.ts'
import { filterReleases } from '../lib/resourceFilter.ts'
import { useShareVerify, isVerifiable, type ShareState } from '../hooks/useShareVerify.ts'
import { copyText, PwChip, VideoSearchResults } from './VideoSearchResults.tsx'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './acrylic/sheet.tsx'
import type { Release, VideoSourceType, WorkBindingView } from '../lib/types.ts'

/** 验活结果的一格。`unsupported`（这个网盘还没接）不显示任何东西——空着，好过对一条
 *  我们根本没检查过的链暗示什么。文件名进 title：它是"这是不是我要的那个资源"的最强信号。 */
function ShareBadge({ state, t }: { state?: ShareState; t: TFunction }) {
  if (!state) return null
  if (state.kind === 'checking') return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
  if (state.kind === 'dead') return <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive" title={t('video.finderDeadTip')}>{t('video.finderDead')}</span>
  if (state.kind === 'needs-login') return <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-500" title={t('video.finderNeedsLoginTip')}>{t('video.finderNeedsLogin')}</span>
  if (state.kind === 'alive') return <span className="shrink-0 text-[10px] text-emerald-500" title={state.files.join('\n')}>{t('video.finderVerifiedFiles', { n: state.files.length })}</span>
  return null
}

/**
 * 影视页「找资源」结果面板。渲染托管给共享的 <VideoSearchResults>；本组件只管两件
 * finder 专属的事:①按本机可用网盘类型过滤(视图偏好,非数据事实);②网盘链自动验活
 * （netdisk.share.verify，纯 HTTP ~300ms），活的一键转存进落点目录并自动绑定作品。
 * 返回一条已死的分享是常态——死链默认藏起、复制按钮只给活链，别把浪费转嫁给用户。
 */
export function ResourceFinder({ conn, query, channelId, work, onBound }: {
  conn: Connection
  query: string
  /** 发起搜索所在的频道 id——频道能力槽位(options.slots)可以为该频道覆盖搜索用的
   *  provider；不传 = 走全局默认。只有频道内入口(如影视频道的「找资源」)才传。 */
  channelId?: string
  /** 服务的作品(tmdb 坐标)。有它转存走「转存→自动绑定」闭环；没有则纯转存。 */
  work?: WorkBindingView
  onBound?: () => void
}) {
  const { t } = useTranslation()
  const [rels, setRels] = useState<Release[]>([])
  const [allowed, setAllowed] = useState<Set<VideoSourceType> | null>(null)
  const [alistReachable, setAlistReachable] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [showDead, setShowDead] = useState(false)
  const [saving, setSaving] = useState<Record<string, 'saving' | 'saved'>>({})

  useEffect(() => {
    api.netdisk.mounts(conn)
      .then((m) => { setAllowed(new Set(m.searchableSourceTypes)); setAlistReachable(m.alistReachable) })
      .catch(() => { setAllowed(new Set<VideoSourceType>(['magnet', 'ed2k'])); setAlistReachable(false) })
  }, [conn])

  // 按本机可用类型收窄(showAll 绕过);验活只跑屏上这批
  const postAllowed = useMemo(() => (showAll || !allowed ? rels : filterReleases(rels, allowed)), [rels, allowed, showAll])
  const toVerify = useMemo(
    () => postAllowed.filter((r) => isVerifiable(r.sourceType)).map((r) => ({ link: r.link, sourceType: r.sourceType, password: r.password })),
    [postAllowed],
  )
  const shares = useShareVerify(conn, toVerify)

  const deadCount = useMemo(() => postAllowed.filter((r) => shares[r.link]?.kind === 'dead').length, [postAllowed, shares])
  const filteredOut = rels.length - (allowed ? filterReleases(rels, allowed).length : rels.length)

  // 共享组件用这个把「屏上可见」算出来:先按可用类型,再默认藏死链
  const filter = (releases: Release[]) => {
    const a = showAll || !allowed ? releases : filterReleases(releases, allowed)
    return showDead ? a : a.filter((r) => shares[r.link]?.kind !== 'dead')
  }

  const save = async (r: Release) => {
    setSaving((prev) => ({ ...prev, [r.link]: 'saving' }))
    try {
      const res = await api.netdisk.saveShare(conn, { link: r.link, passcode: r.password, bind: work?.ref ?? undefined })
      if (res.saved) {
        setSaving((prev) => ({ ...prev, [r.link]: 'saved' }))
        toast.success(t('video.finderSaved', { dest: res.dest ?? '' }))
        if (res.binding && !('error' in res.binding)) onBound?.()
      } else {
        setSaving((prev) => { const n = { ...prev }; delete n[r.link]; return n })
        toast.error(t('video.finderSaveFailed', { reason: res.message || res.stage }))
      }
    } catch (e) {
      setSaving((prev) => { const n = { ...prev }; delete n[r.link]; return n })
      toast.error(t('video.finderSaveFailed', { reason: (e as Error).message }))
    }
  }

  const rowActions = (r: Release) => {
    const state = shares[r.link]
    const saveState = saving[r.link]
    return (
      <>
        <ShareBadge state={state} t={t} />
        {r.password && <PwChip pw={r.password} />}
        {state?.kind === 'alive' && (
          <button type="button" disabled={saveState != null} onClick={() => save(r)} aria-label={t('video.finderSave', { title: r.title })} title={saveState === 'saved' ? t('video.finderSaved', { dest: '' }) : t('video.finderSave', { title: r.title })} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60">
            {saveState === 'saving' ? <Loader2 className="size-3.5 animate-spin" /> : <FolderSymlink className={`size-3.5${saveState === 'saved' ? ' text-emerald-500' : ''}`} />}
          </button>
        )}
        <button type="button" onClick={() => copyText(r.password ? `${r.link} ${t('video.finderPassword', { pw: r.password })}` : r.link).then(() => toast.success(t('video.finderCopied')))} aria-label={t('video.finderCopy', { title: r.title })} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
          <Copy className="size-3.5" />
        </button>
      </>
    )
  }

  const toolbar = (
    <div className="flex flex-col gap-1.5">
      {!alistReachable && <div className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-400">{t('video.finderAlistDown')}</div>}
      {filteredOut > 0 && !showAll && <div className="text-[12px] text-muted-foreground">{t('video.finderFilteredOut', { n: filteredOut })}</div>}
      <div className="flex flex-wrap items-center gap-3">
        {deadCount > 0 && (
          <button type="button" onClick={() => setShowDead((v) => !v)} className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
            {t('video.finderDeadCount', { n: deadCount })} · {showDead ? t('video.finderHideDead') : t('video.finderShowDead')}
          </button>
        )}
        <button type="button" onClick={() => setShowAll((v) => !v)} className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
          {showAll ? t('video.finderShowUsable') : t('video.finderShowAll')}
        </button>
      </div>
    </div>
  )

  return (
    <VideoSearchResults
      conn={conn}
      query={query}
      channelId={channelId}
      renderRowActions={rowActions}
      filter={filter}
      onReleases={setRels}
      rowClassName={(r) => (shares[r.link]?.kind === 'dead' ? 'opacity-45' : '')}
      toolbar={toolbar}
      renderEmpty={({ total, deduped }) => (
        <div className="py-6 text-center text-[12px] text-muted-foreground">
          {total > 0 ? t('video.finderEmptyNoUsable') : deduped > 0 ? t('video.finderEmptyAllDupes') : t('video.finderEmptyNone')}
        </div>
      )}
    />
  )
}

/**
 * 「找资源」从底部滑出的 Sheet —— 影视二级页各入口都开它。
 * `open` 关时 radix 卸载内容，搜索 effect 随之 abort —— 关面板即停搜，不留后台请求。
 */
export function ResourceFinderSheet({ open, conn, query, channelId, onClose, work, onBound }: {
  open: boolean
  conn: Connection
  query: string
  /** 见 ResourceFinder 的同名 prop：只有频道内入口传。 */
  channelId?: string
  onClose: () => void
  work?: WorkBindingView
  onBound?: () => void
}) {
  const { t } = useTranslation()
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      {/* 滚动条挂在**内层**，不能挂在 SheetContent 上：底部弹层的关闭手势和内容滚动
          共用竖轴，touch-action 只从「实现该手势的滚动容器」往下看——面板自己成为滚动
          容器时，它的 touch-action 恰好禁掉了所需的那根轴，触屏上就一点也滚不动。
          顺带头部不再跟着滚。 */}
      <SheetContent side="bottom" className="max-h-[85vh] gap-3 overflow-hidden rounded-t-2xl px-0 pb-6 pt-4">
        <SheetHeader className="px-4 pb-1 pt-0">
          <SheetTitle className="text-sm">{t('video.finderTitle', { query })}</SheetTitle>
          <SheetDescription className="sr-only">{t('video.findResource')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {open && <ResourceFinder conn={conn} query={query} channelId={channelId} work={work} onBound={onBound} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
