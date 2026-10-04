import { useState } from 'react'
import { ListMusic, Music2, Play } from 'lucide-react'
import { fmtClock, useAudioStage, type AudioKind } from '../lib/audioStage.ts'
import { cn } from '../lib/utils.ts'
import { ButtonGroup, ButtonGroupItem } from './acrylic/button-group.tsx'
import { Sheet, SheetContent, SheetTrigger } from './acrylic/sheet.tsx'

const TOOL =
  'flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-[var(--acr-hover)] hover:text-foreground'

const KIND_LABEL: Record<AudioKind, string> = { music: '音乐', podcast: '播客' }

/** The 播放队列 Sheet — opens from the right when you click the queue button on the now-playing
 *  bar. A segmented [音乐 | 播客] toggle switches between the two saved queues; clicking a row
 *  plays it within that kind (which also makes that kind active). */
export function QueueSheet() {
  const stage = useAudioStage()
  // default the visible tab to whatever's currently playing
  const [tab, setTab] = useState<AudioKind>(stage.activeKind)
  const tracks = stage.queues[tab]

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button aria-label="播放队列" className={TOOL} title="播放队列">
          <ListMusic className="size-4" />
        </button>
      </SheetTrigger>
      <SheetContent className="gap-0 p-0 text-foreground">
        {/* header: heading + count for the active tab */}
        <div className="flex items-baseline gap-1.5 px-4 pt-3 pb-2 pr-10">
          <h2 className="text-lg font-bold tracking-tight">播放列表</h2>
          <span className="text-xs text-muted-foreground">{tracks.length}</span>
        </div>

        {/* segmented [音乐 | 播客] switch */}
        <div className="mb-2 flex justify-center px-4">
          <ButtonGroup
            variant="segmented"
            size="large"
            value={tab}
            onValueChange={(value) => setTab(value as AudioKind)}
            aria-label="播放列表类型"
          >
            {(['music', 'podcast'] as AudioKind[]).map((k) => (
              <ButtonGroupItem
                key={k}
                value={k}
                className="gap-1 px-4"
              >
                {KIND_LABEL[k]}
                <span className="text-[11px] opacity-60">{stage.queues[k].length}</span>
              </ButtonGroupItem>
            ))}
          </ButtonGroup>
        </div>

        {/* track rows for the selected tab */}
        <div className="scrollbar-mac min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {tracks.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              {KIND_LABEL[tab]}队列为空
            </div>
          ) : (
            tracks.map((t, i) => {
              const isCurrent = stage.current?.id === t.id && stage.activeKind === tab
              return (
                <button
                  key={t.id}
                  onClick={() => stage.playQueue(tracks, i, tab)}
                  className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--acr-hover)]"
                >
                  <div className="relative size-11 shrink-0 overflow-hidden rounded-lg">
                    {t.poster ? (
                      <img src={t.poster} alt="" className="size-full object-cover" />
                    ) : (
                      <span className="flex size-full items-center justify-center bg-[var(--acr-chip)] text-muted-foreground">
                        <Music2 className="size-4" />
                      </span>
                    )}
                    <div
                      className={cn(
                        'absolute inset-0 flex items-center justify-center bg-black/35 transition-opacity',
                        isCurrent ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      )}
                    >
                      <Play className="size-4 translate-x-px fill-white text-white" />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={cn('truncate text-sm font-medium', isCurrent && 'text-primary')}>{t.title || '未命名'}</div>
                    {t.author && <div className="truncate text-xs text-muted-foreground">{t.author}</div>}
                  </div>
                  {t.durationS ? (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtClock(t.durationS)}</span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
