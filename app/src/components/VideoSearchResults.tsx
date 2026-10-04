import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ExternalLink } from 'lucide-react'
import type { TFunction } from 'i18next'
import { api, imgUrl, ApiError, type Connection } from '../lib/api.ts'
import { cn } from '../lib/utils.ts'
import { toast } from './acrylic/sonner.tsx'
import { SourceTimingPanel, type SourceMetaMap } from './SourceTimingPanel.tsx'
import { SlotSwitcher } from './manage/SlotSwitcher.tsx'
import { Badge } from './ui/badge.tsx'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog.tsx'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty.tsx'
import { SearchX } from 'lucide-react'
import type { Coverage, Quality, Release, VideoSourceTiming } from '../lib/types.ts'

// ── shared presentation helpers ────────────────────────────────────────────

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

function qualityLabel(t: TFunction): Record<Quality, string> {
  return { '2160p': '2160p', '1080p': '1080p', '720p': '720p', sd: t('video.qualitySd'), unknown: t('video.qualityOther') }
}

/** display label for a link's netdisk type: prefer the finer backend label, else the coarse SourceType. */
export function netdiskChipLabel(t: TFunction, type: string, netdiskLabel?: string): string {
  if (netdiskLabel) return netdiskLabel
  const m: Record<string, string> = {
    quark: t('video.sourceTypeQuark'), baidu: t('video.sourceTypeBaidu'), aliyun: t('video.sourceTypeAliyun'), ed2k: 'ed2k',
    magnet: t('video.sourceTypeMagnet'), unknown: t('video.sourceTypeUnknown'),
  }
  return m[type] ?? type
}

export function fmtSize(bytes?: number): string {
  if (!bytes) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`
}

function coverageLabel(t: TFunction, c: Coverage): string {
  if (c.kind === 'pack') return t('video.coveragePack', { n: c.total ?? c.to })
  if (c.kind === 'complete') return t('video.coverageComplete')
  if (c.kind === 'single') return `E${String(c.episode).padStart(2, '0')}`
  if (c.kind === 'range') return `E${String(c.from).padStart(2, '0')}-${String(c.to).padStart(2, '0')}`
  return t('video.coverageMovie')
}

/** Source badge — friendly label, clickable to the source's page. */
function SourceBadge({ sourceKey, meta, itemUrl }: { sourceKey: string; meta: SourceMetaMap; itemUrl?: string }) {
  const { t } = useTranslation()
  const m = meta[sourceKey]
  const label = m?.label ?? sourceKey
  const href = itemUrl ?? m?.searchUrl
  const cls = 'h-4 shrink-0 gap-0.5 px-1 text-[10px] font-normal'
  if (!href) return <Badge className={cls}>{label}</Badge>
  return (
    <a href={href} target="_blank" rel="noreferrer" title={itemUrl ? t('video.openSourcePage', { label }) : t('video.searchInSource', { label })} className="shrink-0">
      <Badge className={cn(cls, 'transition-colors hover:border-primary/60 hover:text-primary')}>
        {label}
        <ExternalLink className="size-2.5 opacity-60" />
      </Badge>
    </a>
  )
}

/** Source cover/preview image (hotlink-friendly, hides on error, click to zoom). */
function Thumb({ src, conn, className }: { src: string; conn: Connection; className?: string }) {
  const [ok, setOk] = useState(true)
  if (!ok) return null
  const url = imgUrl(conn.baseUrl, src)
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="shrink-0">
          <img src={url} loading="lazy" onError={() => setOk(false)} className={cn('cursor-zoom-in rounded bg-foreground/[0.04] object-cover transition-opacity hover:opacity-90', className)} />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl border-0 bg-transparent p-0 shadow-none">
        <DialogTitle className="sr-only">image</DialogTitle>
        <img src={url} className="max-h-[85vh] w-full rounded-lg object-contain" />
      </DialogContent>
    </Dialog>
  )
}

/** Copyable password chip for netdisk shares. */
export function PwChip({ pw }: { pw: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { copyText(pw); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
      title={t('video.copyPassword')}
      className={cn('shrink-0 rounded border px-1 py-0.5 text-[10px] tabular-nums transition-colors', copied ? 'border-emerald-400/40 text-emerald-400' : 'border-border hover:bg-white/5')}
    >
      {t('video.passwordLabel', { pw })}
    </button>
  )
}

/** Copy-magnet/link button. btbtla releases resolve their magnet lazily (link is a page). */
export function MagnetButton({ release, conn }: { release: Release; conn: Connection }) {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'resolving' | 'copied' | 'error' | 'unresolvable'>('idle')
  // what to copy + the password that travels with it (a resolved option's own password wins
  // over the release-level one — the option is closer to the actual share)
  const cached = useRef<{ url: string; password?: string } | null>(
    release.needsResolve ? null : { url: release.link, password: release.password })
  const onCopy = async () => {
    try {
      if (!cached.current) {
        setState('resolving')
        const { options } = await api.videoResolve(conn, release.link)
        const first = options[0]
        cached.current = { url: first.url, password: first.password ?? release.password }
      }
      const { url, password } = cached.current
      await copyText(password ? `${url} ${t('video.passwordSuffix', { pw: password })}` : url)
      setState('copied'); setTimeout(() => setState('idle'), 1500)
    } catch (e) {
      // 400/502 = the backend answered "no resolver / upstream refused" — a different story
      // from the network dying, and the label should say so instead of one blanket "失败".
      const answered = e instanceof ApiError && (e.status === 400 || e.status === 502)
      setState(answered ? 'unresolvable' : 'error'); setTimeout(() => setState('idle'), 2000)
    }
  }
  const isNetdisk = release.sourceType !== 'magnet' && release.sourceType !== 'ed2k'
  const label = state === 'resolving' ? t('video.copyResolving') : state === 'copied' ? t('video.copyCopied') : state === 'unresolvable' ? t('video.copyUnresolvable') : state === 'error' ? t('video.copyFailed') : isNetdisk ? t('video.copyLink') : t('video.copyMagnet')
  return (
    <button onClick={onCopy} disabled={state === 'resolving'} className={cn('flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors', state === 'copied' ? 'border-emerald-400/40 text-emerald-400' : state === 'error' || state === 'unresolvable' ? 'border-rose-500/40 text-rose-400' : 'border-border hover:bg-white/5')}>
      {state === 'copied' ? <Check className="size-3" /> : <Copy className="size-3" />}
      {label}
    </button>
  )
}

// ── the row ────────────────────────────────────────────────────────────────

/** One flat download row: source badge, name, parsed attrs, mirror chips (NOT raw
 *  URLs), cover, and a consumer-supplied action slot. This is the single row shape
 *  shared by every consumer of this list — today the 找资源 Sheet (ResourceFinder). */
const ReleaseRow = memo(function ReleaseRow({
  release, conn, meta, onPreview, actions, className,
}: {
  release: Release
  conn: Connection
  meta: SourceMetaMap
  onPreview?: (url: string) => void
  actions?: ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  const ql = qualityLabel(t)
  const attrs = [
    release.quality !== 'unknown' ? ql[release.quality] : undefined,
    release.coverage.kind !== 'unknown' ? coverageLabel(t, release.coverage) : undefined,
    release.codec, release.hdr, release.group, fmtSize(release.sizeBytes),
  ].filter(Boolean)
  // mirror shares (same work, other netdisks) → type CHIPS, never raw URLs.
  const mirrors = (release.links?.length ?? 0) > 1 ? release.links! : []
  return (
    <div className={cn('flex items-start gap-2.5 border-b border-border/60 px-4 py-2', className)}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <SourceBadge sourceKey={release.source} meta={meta} itemUrl={release.origin} />
          {/* 频道页 URL 由源给（release.channelUrl），前端不按站拼。 */}
          {release.channel && release.channelUrl ? (
            <a href={release.channelUrl} target="_blank" rel="noreferrer" title={t('video.channelSource')} className="min-w-0 shrink-0">
              <Badge className="h-4 gap-0.5 px-1 text-[10px] font-normal transition-colors hover:border-primary/60 hover:text-primary">@{release.channel}<ExternalLink className="size-2.5 opacity-60" /></Badge>
            </a>
          ) : release.channel ? (
            <Badge className="h-4 shrink-0 px-1 text-[10px] font-normal" title={t('video.channelSource')}>@{release.channel}</Badge>
          ) : release.provider ? (
            <Badge className="h-4 shrink-0 px-1 text-[10px] font-normal" title={t('video.channelSource')}>{release.provider}</Badge>
          ) : null}
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">{netdiskChipLabel(t, release.sourceType, release.netdiskLabel)}</span>
          {attrs.length > 0 && <span className="shrink-0">{attrs.join(' · ')}</span>}
        </div>
        <button
          type="button"
          onClick={onPreview && release.origin ? () => onPreview(release.origin!) : undefined}
          className={cn('mt-1 block w-full truncate text-left text-[13px] leading-snug', onPreview && release.origin && 'hover:text-primary')}
          title={release.title}
        >
          {release.title}
        </button>
        {mirrors.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground/70">
            <span>{t('video.alsoOn')}</span>
            {mirrors.map((l, i) => (
              <span key={i} className="rounded border border-border/60 px-1 py-0.5">{netdiskChipLabel(t, l.type)}</span>
            ))}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5 pt-0.5">{actions}</div>}
      {release.images?.[0] && <Thumb src={release.images[0]} conn={conn} className="h-20 w-14" />}
    </div>
  )
})

// ── streaming ──────────────────────────────────────────────────────────────

function flatten(part: { shows: Array<{ qualities: Array<{ releases: Release[] }> }>; loose: Release[] }): Release[] {
  return [...part.shows.flatMap((ss) => ss.qualities.flatMap((qb) => qb.releases)), ...part.loose]
}

// ── the shared results component ─────────────────────────────────────────────

export interface VideoSearchResultsProps {
  conn: Connection
  /** committed query; empty string = idle (no search) */
  query: string
  /** 发起搜索所在的频道 id——透传给 /api/search 让频道的能力槽位覆盖(options.slots)
   *  生效；不传 = 全局默认 provider。只有频道内入口才传。 */
  channelId?: string
  nsfw?: boolean
  /** bump to force a re-run of the same query (driven by a consumer's own submit) */
  runToken?: number
  onPreview?: (url: string) => void
  /** per-row action buttons (right side) — copy/magnet for browse, verify/save for finder */
  renderRowActions?: (r: Release) => ReactNode
  /** consumer's final filter over the type-filtered set (finder: netdisk-allowed + dead-hide) */
  filter?: (releases: Release[]) => Release[]
  /** the type-filtered set (before `filter`), for consumers that verify visible rows */
  onReleases?: (releases: Release[]) => void
  /** extra className per row (finder dims dead) */
  rowClassName?: (r: Release) => string
  /** built-in netdisk/magnet type toggle (off for the finder, which brings its own) */
  typeFilter?: boolean
  /** consumer toolbar rendered above the list (banners, showAll/showDead toggles) */
  toolbar?: ReactNode
  /** override the empty element (finder distinguishes 真没有/全重复/无可用类型) */
  renderEmpty?: (info: { total: number; deduped: number }) => ReactNode
}

export function VideoSearchResults({
  conn, query, channelId, nsfw, runToken, onPreview, renderRowActions, filter, onReleases, rowClassName, typeFilter = false, toolbar, renderEmpty,
}: VideoSearchResultsProps) {
  const { t } = useTranslation()
  const [all, setAll] = useState<Release[]>([])
  const [timings, setTimings] = useState<VideoSourceTiming[]>([])
  const [meta, setMeta] = useState<SourceMetaMap>({})
  const [dedup, setDedup] = useState(0)
  // start loading when mounted with a query, so the timing panel (which auto-expands
  // on the loading→true edge) is open from the first committed render.
  const [loading, setLoading] = useState(Boolean(query))
  const [searched, setSearched] = useState(Boolean(query))
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set())
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())
  const [nowTick, setNowTick] = useState(0)
  const startRef = useRef(0)
  // 就地换 provider 后 bump 重跑同一 query；slot_broken 记到状态供 SlotSwitcher 亮警示
  const [slotBump, setSlotBump] = useState(0)
  const [slotBroken, setSlotBroken] = useState(false)

  useEffect(() => {
    if (!loading) return
    const id = setInterval(() => setNowTick(Date.now()), 100)
    return () => clearInterval(id)
  }, [loading])

  useEffect(() => {
    if (!query) { setAll([]); setTimings([]); setMeta({}); setDedup(0); setSearched(false); setLoading(false); return }
    const ctrl = new AbortController()
    setAll([]); setTimings([]); setMeta({}); setDedup(0); setHiddenSources(new Set())
    startRef.current = Date.now(); setNowTick(Date.now()); setLoading(true); setSearched(true); setSlotBroken(false)
    void (async () => {
      try {
        await api.videoSearchStream(conn, query, nsfw ?? false, (ev) => {
          if (ctrl.signal.aborted) return
          if (ev.type === 'init') setMeta(Object.fromEntries(ev.sources.map((s) => [s.key, s])))
          if (ev.type === 'source') {
            setAll((prev) => [...prev, ...flatten(ev.part)])
            setTimings((prev) => [...prev, ev.timing])
            setDedup((n) => n + ev.timing.dropped)
          }
          if (ev.type === 'done') setLoading(false)
        }, ctrl.signal, channelId)
      } catch (e) {
        // §5.1:槽位指向的 Provider 已停用/删除——422 slot_broken,后端文案可操作,直接弹出。
        if (e instanceof ApiError && e.code === 'slot_broken') { setSlotBroken(true); toast.error(e.message) }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    })()
    return () => ctrl.abort()
  }, [conn, query, channelId, nsfw, runToken, slotBump])

  const toggleSource = (key: string) =>
    setHiddenSources((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  const typesOf = (r: Release) => (r.links?.length ? r.links.map((l) => l.type) : [r.sourceType])
  const presentTypes = useMemo(() => [...new Set(all.flatMap(typesOf))], [all])

  const bySource = useMemo(() => (hiddenSources.size ? all.filter((r) => !hiddenSources.has(r.source)) : all), [all, hiddenSources])
  const byType = useMemo(
    () => (typeFilter && hiddenTypes.size ? bySource.filter((r) => typesOf(r).some((ty) => !hiddenTypes.has(ty))) : bySource),
    [bySource, hiddenTypes, typeFilter],
  )
  // keep `onReleases` in a ref so the effect fires only when the set changes, not on
  // every render (the consumer passes a fresh closure each render — depending on its
  // identity would loop: notify → consumer setState → re-render → notify …).
  const onReleasesRef = useRef(onReleases)
  onReleasesRef.current = onReleases
  useEffect(() => { onReleasesRef.current?.(byType) }, [byType])
  const visible = useMemo(() => (filter ? filter(byType) : byType), [byType, filter])

  return (
    <div className="flex flex-col">
      {searched && (
        <div className="px-4 pt-2">
          <SourceTimingPanel meta={meta} timings={timings} elapsedMs={loading ? Math.max(0, nowTick - startRef.current) : 0} loading={loading} hidden={hiddenSources} onToggle={toggleSource} />
        </div>
      )}
      {channelId && searched && (
        <div className="px-4 pt-1.5">
          <SlotSwitcher
            conn={conn}
            channelId={channelId}
            callsiteId="search.resources"
            broken={slotBroken}
            onChanged={() => setSlotBump((n) => n + 1)}
          />
        </div>
      )}
      {typeFilter && searched && presentTypes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
          <span className="shrink-0 text-[10px] text-muted-foreground/60">{t('video.typeLabel')}</span>
          <ToggleGroup type="multiple" value={presentTypes.filter((ty) => !hiddenTypes.has(ty))} onValueChange={(vals) => setHiddenTypes(new Set(presentTypes.filter((ty) => !vals.includes(ty))))} className="flex-wrap justify-start gap-1.5">
            {presentTypes.map((ty) => (
              <ToggleGroupItem key={ty} value={ty} className="h-6 rounded-full border border-border px-2.5 text-[11px] data-[state=off]:text-muted-foreground/40 data-[state=off]:line-through data-[state=on]:border-primary/50 data-[state=on]:bg-primary/10 data-[state=on]:text-foreground">
                {netdiskChipLabel(t, ty)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}
      {dedup > 0 && <div className="px-4 pt-1.5 text-[12px] text-muted-foreground">{t('video.finderDeduped', { n: dedup })}</div>}
      {toolbar && <div className="px-4 pt-1.5">{toolbar}</div>}
      {loading && visible.length === 0 && <div className="px-4 py-4 text-[12px] text-muted-foreground">{t('video.finderSearching')}</div>}
      {searched && !loading && visible.length === 0 && (
        renderEmpty ? renderEmpty({ total: all.length, deduped: dedup }) : (
          <Empty className="mx-4 my-6 min-h-40 border border-dashed border-border/70 bg-muted/20">
            <EmptyHeader><EmptyMedia variant="icon"><SearchX /></EmptyMedia><EmptyTitle>{t('video.emptyTitle')}</EmptyTitle><EmptyDescription>{t('video.emptyResult')}</EmptyDescription></EmptyHeader>
          </Empty>
        )
      )}
      {visible.map((r, i) => (
        <ReleaseRow key={`${r.source}-${r.link}-${i}`} release={r} conn={conn} meta={meta} onPreview={onPreview} actions={renderRowActions?.(r)} className={rowClassName?.(r)} />
      ))}
    </div>
  )
}
