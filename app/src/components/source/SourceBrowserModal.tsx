import { Dialog, DialogContent, DialogTitle } from '../acrylic/dialog.tsx'
import { SourceBrowser } from './SourceBrowser.tsx'
import type { Connection } from '../../lib/api.ts'
import type { PickSurface, SourceSummary } from '../../lib/types.ts'

/** Centered browse Modal (scenario 3): the same SourceBrowser, wrapped so an existing
 *  Stream/Provider can pick a source to append. The parent opens the config Sheet on pick. */
export function SourceBrowserModal({ open, onOpenChange, conn, onPick, surface }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  conn: Connection
  onPick: (s: SourceSummary) => void
  /** 见 `PickSurface`：这次是为「加一条流」还是「挑一个 Provider 成员」打开的。 */
  surface?: PickSurface
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] max-w-[64rem] overflow-hidden p-0">
        <DialogTitle className="sr-only">选择来源</DialogTitle>
        <div className="flex h-full min-h-0">
          <SourceBrowser conn={conn} onPick={onPick} surface={surface} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
