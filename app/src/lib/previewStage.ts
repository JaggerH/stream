import { createContext, useContext } from 'react'

/** What to preview live (no store): a whole Stream, or ONE source with ad-hoc (possibly
 *  unsaved) params — the config-sheet case. `label` is the modal title. */
export type PreviewTarget =
  | { kind: 'stream'; streamId: string; label: string }
  | { kind: 'source'; sourceId: string; params: Record<string, unknown>; label: string }

/** Opening a preview is owned by App (which renders the modal where the timeline's
 *  PostItemRow is in scope); the channel config panel / SourceConfigSheet just call
 *  openPreview(). */
export interface PreviewControl {
  openPreview: (target: PreviewTarget) => void
}

export const PreviewContext = createContext<PreviewControl | null>(null)

export function usePreview(): PreviewControl {
  const v = useContext(PreviewContext)
  if (!v) throw new Error('usePreview must be used inside <PreviewContext.Provider>')
  return v
}
