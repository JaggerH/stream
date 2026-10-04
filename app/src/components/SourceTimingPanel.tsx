import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.tsx'
import { cn } from '../lib/utils.ts'
import type { VideoSourceMeta, VideoSourceTiming } from '../lib/types.ts'

export type SourceMetaMap = Record<string, VideoSourceMeta>

/** STATUS_META styling (dot/text colors) is static; labels are looked up via t at
 *  the call site so they re-translate on language change. */
const STATUS_STYLE: Record<VideoSourceTiming['status'], { dot: string; text: string }> = {
  ok: { dot: 'bg-emerald-400', text: 'text-foreground' },
  empty: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground' },
  timeout: { dot: 'bg-amber-400', text: 'text-amber-400' },
  error: { dot: 'bg-rose-500', text: 'text-rose-400' },
}

function statusLabel(t: TFunction, status: 'empty' | 'timeout' | 'error'): string {
  if (status === 'empty') return t('video.statusEmpty')
  if (status === 'timeout') return t('video.statusTimeout')
  return t('video.statusError')
}

/** Per-source timing dashboard. Every source appears the instant search starts
 *  (from the `init` event), each timing live from zero; a row freezes with its
 *  final time + count the moment that source completes. Auto-expanded while
 *  searching (so you watch them run in parallel), collapsible afterward.
 *
 *  Lives here rather than inside its consumer so it survives a consumer being
 *  retired — which already happened once: the global-search resource column (the
 *  old VideoChannel) is gone, and ResourceFinder (影视页找资源) carries it now. Rows are buttons: clicking one hides/restores that source's
 *  results, so a consumer MUST wire `hidden`/`onToggle` to real state — a row that
 *  looks clickable and does nothing is worse than no row. */
export function SourceTimingPanel({
  meta,
  timings,
  elapsedMs,
  loading,
  hidden,
  onToggle,
}: {
  meta: SourceMetaMap
  timings: VideoSourceTiming[]
  elapsedMs: number
  loading: boolean
  hidden: Set<string>
  onToggle: (key: string) => void
}) {
  const { t } = useTranslation()
  const all = Object.values(meta)
  const [open, setOpen] = useState(false)
  // expand when a search starts; stay open afterward so you can filter by source.
  // (only auto-opens — the user collapses manually.)
  useEffect(() => {
    if (loading) setOpen(true)
  }, [loading])
  if (all.length === 0) return null
  const done: Record<string, VideoSourceTiming> = Object.fromEntries(timings.map((tm) => [tm.key, tm]))
  const slowest = Math.max(...all.map((m) => done[m.key]?.ms ?? elapsedMs), 1)
  const hiddenCount = all.filter((m) => hidden.has(m.key)).length
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-2 rounded-lg border border-border/70 bg-background/40">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span>
          {t('video.elapsedHeader', { done: timings.length, all: all.length })}{hiddenCount > 0 && <span className="text-amber-400/80"> {t('video.hiddenCount', { n: hiddenCount })}</span>}
        </span>
        <span>{open ? t('video.collapsePanel') : t('video.expandPanel')}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2.5 pb-2.5">
        <div className="mb-1 text-[10px] text-muted-foreground/60">{t('video.timingHint')}</div>
        <div className="flex flex-col gap-1">
          {all.map((src) => {
            const tm = done[src.key]
            const ms = tm ? tm.ms : elapsedMs
            const ss = tm ? STATUS_STYLE[tm.status] : null
            const off = hidden.has(src.key)
            return (
              <button
                key={src.key}
                type="button"
                onClick={() => onToggle(src.key)}
                title={off ? t('video.restoreSource', { label: src.label }) : t('video.hideSource', { label: src.label })}
                className={cn('-mx-1 flex items-center gap-2 rounded px-1 text-left text-[12px] transition-colors hover:bg-white/5', off && 'opacity-40')}
              >
                <span className={cn('size-1.5 shrink-0 rounded-full', tm ? ss!.dot : 'animate-pulse bg-primary/60')} />
                <span className={cn('w-20 shrink-0 truncate font-medium', off && 'line-through')}>{src.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
                  <div
                    className={cn('h-full rounded-full transition-all', !tm ? 'animate-pulse bg-primary/40' : tm.status === 'ok' ? 'bg-primary/60' : 'bg-muted-foreground/30')}
                    style={{ width: `${Math.round((ms / slowest) * 100)}%` }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{(ms / 1000).toFixed(1)}s</span>
                <span className={cn('w-16 shrink-0 text-right tabular-nums', tm ? ss!.text : 'text-muted-foreground/70')}>
                  {tm ? (tm.status === 'ok' ? t('video.resultCount', { n: tm.count }) : statusLabel(t, tm.status)) : t('video.timing')}
                </span>
              </button>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
