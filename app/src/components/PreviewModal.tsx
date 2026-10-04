// Throwaway live preview of a Stream (or one source with unsaved params). Fetches the
// no-store preview endpoint and renders items with the SAME PostItemRow the real timeline
// uses, so "看看展示效果" is faithful. View-only (onOpen is a no-op).
import { useEffect, useState } from 'react'

import { api, LOCAL } from '../lib/api.ts'
import { useWs } from '../hooks/useWs.ts'
import type { Item, PreviewResult, WsMessage } from '../lib/types.ts'
import type { PreviewTarget } from '../lib/previewStage.ts'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './acrylic/dialog.tsx'
import { ItemGroup } from './acrylic/item.tsx'
import { PostItemRow } from './feed/PostItemRow.tsx'
import { HarvestStreamPane } from './HarvestLivePanel.tsx'
import { Warnings } from './Warnings.tsx'

export function PreviewModal({ target, onClose }: { target: PreviewTarget | null; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; data?: PreviewResult; err?: string }>({ loading: false })
  // Live harvest stream: items appear the instant they're scraped, so the LEFT pane never
  // sits empty waiting on the blocking previewStream (which only returns after the whole
  // scroll). previewStream still resolves to the final curated list, which then takes over.
  const [live, setLive] = useState<Item[]>([])
  const [done, setDone] = useState(false)

  useEffect(() => { setLive([]); setDone(false) }, [target])

  useWs(api.wsUrl(LOCAL), (m: WsMessage) => {
    const msg = m as { type?: string; item?: Item }
    if (msg.type === 'harvest-item' && msg.item) {
      const it = msg.item
      setLive((prev) => (prev.some((p) => p.id === it.id) ? prev : [...prev, it]))
    } else if (msg.type === 'harvest-done') {
      setDone(true)
    }
  })

  useEffect(() => {
    if (!target) return
    let alive = true
    setState({ loading: true })
    const p = target.kind === 'stream'
      ? api.previewStream(LOCAL, target.streamId, 30)
      : api.previewSource(LOCAL, target.sourceId, target.params)
    p.then((data) => { if (alive) setState({ loading: false, data }) })
      .catch((e) => { if (alive) setState({ loading: false, err: e instanceof Error ? e.message : String(e) }) })
    return () => { alive = false }
  }, [target])

  // final curated list wins once it lands; until then render the live stream so the left fills immediately
  const items = state.data?.items?.length ? state.data.items : live
  const errors = state.data?.errors ?? []

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>预览 · {target?.label}</DialogTitle>
          <DialogDescription>实时拉取，仅预览展示效果，不入库。左侧最终展示，右侧实时采集。</DialogDescription>
        </DialogHeader>
        {/* one modal, two panes: 左 post（最终展示）/ 右 采集（边抓边进） */}
        <div className="flex gap-4" style={{ maxHeight: '72vh' }}>
        <div className="flex-1 min-w-0 overflow-y-auto">
          {errors.length ? (
            <div className="mb-2">
              <Warnings
                warnings={errors.map((e) => ({ label: e.source, message: e.reason, detail: e.category }))}
                context={{ preview: target?.label ?? '' }}
              />
            </div>
          ) : null}
          {items.length ? (
            <ItemGroup className="w-full gap-0">
              {items.map((item, i) => (
                <PostItemRow
                  key={item.id}
                  item={item}
                  last={i === items.length - 1}
                  onOpen={() => {}}
                />
              ))}
            </ItemGroup>
          ) : state.loading ? (
            <div className="px-3 py-10 text-center text-[12px] text-muted-foreground">拉取中…</div>
          ) : state.err ? (
            <div className="px-3 py-6 text-center text-[12px] text-destructive">{state.err}</div>
          ) : (
            <div className="px-3 py-10 text-center text-[12px] text-muted-foreground">
              {errors.length ? '所有来源都拉取失败，见上方原因。' : '无内容。'}
            </div>
          )}
        </div>
        <div className="w-[320px] shrink-0 border-l border-border pl-4">
          <HarvestStreamPane items={live} done={done} />
        </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
