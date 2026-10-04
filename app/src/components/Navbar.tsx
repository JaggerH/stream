import { Pause, Play, Search, Settings, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils.ts'
import { useAudioStage } from '../lib/audioStage.ts'
import { LangToggle } from './LangToggle.tsx'
import { Separator } from './acrylic/separator.tsx'
import { SidebarTrigger } from './acrylic/sidebar.tsx'

/** Compact now-playing widget — keeps background audio controllable from any page.
 *  Renders nothing (no reserved space) when nothing is playing. */
function NowPlayingMini() {
  const stage = useAudioStage()
  if (!stage.current) return null
  const { current, playing } = stage
  return (
    <div className="flex items-center gap-2 rounded-md bg-secondary/60 py-1 pl-1 pr-1.5">
      {current.poster && <img src={current.poster} alt="" className="size-7 shrink-0 rounded object-cover" />}
      <span className="max-w-[140px] truncate text-[13px] text-foreground/90">{current.title || '播放中'}</span>
      <button
        onClick={stage.toggle}
        aria-label={playing ? 'pause' : 'play'}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105"
      >
        {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 translate-x-px fill-current" />}
      </button>
      <button
        onClick={stage.stop}
        aria-label="close"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

export type View = 'inbox' | 'sources' | 'channels' | 'providers' | 'packages'

export function Navbar({
  query,
  onQuery,
  onSubmit,
  onOpenSettings,
}: {
  query: string
  onQuery: (q: string) => void
  /** Enter in the box → live cross-platform content search (every source the content-search Provider row fans out to) */
  onSubmit?: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="h-12 shrink-0 flex items-center gap-2 border-b border-[var(--acr-border-soft)] px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 !h-4" />
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit?.()
          }}
          placeholder={t('nav.searchPlaceholder')}
          className={cn(
            'w-full rounded-md bg-[var(--acr-input)] py-1.5 pl-8 pr-3 text-sm outline-none',
            'ring-1 ring-[var(--acr-input-border)] transition focus:ring-[var(--ring)]'
          )}
        />
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <NowPlayingMini />
        <LangToggle />
      </div>
      <button
        onClick={onOpenSettings}
        title={t('nav.settings')}
        className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  )
}
