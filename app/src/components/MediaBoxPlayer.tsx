import { Maximize2 } from 'lucide-react'
import { OutPortal, type HtmlPortalNode } from '../lib/portal.ts'

export function MediaBoxPlayer({
  node,
  onExpand,
  expandTitle,
  expandAriaLabel,
}: {
  node: HtmlPortalNode
  onExpand?: () => void
  expandTitle?: string
  expandAriaLabel?: string
}) {
  return (
    <div data-slot="media-box-player" className="group absolute inset-0">
      <div className="thumb-player absolute inset-0">
        <OutPortal node={node} />
      </div>
      {onExpand ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onExpand()
          }}
          title={expandTitle}
          aria-label={expandAriaLabel || expandTitle}
          className="absolute right-2 top-2 z-10 rounded-full bg-black/55 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100"
        >
          <Maximize2 className="size-4" />
        </button>
      ) : null}
    </div>
  )
}
