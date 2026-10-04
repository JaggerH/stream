import { useEffect, type RefObject } from 'react'

/** Can `el` actually scroll vertically in the wheel's direction *right now*? An element
 *  counts as an "explicitly scrollable region" only if it has overflow-y auto/scroll, its
 *  content overflows, AND it isn't already pinned at the relevant edge. */
export function canScrollY(el: HTMLElement, deltaY: number): boolean {
  const oy = getComputedStyle(el).overflowY
  if (oy !== 'auto' && oy !== 'scroll') return false
  if (el.scrollHeight <= el.clientHeight) return false
  if (deltaY < 0) return el.scrollTop > 0
  if (deltaY > 0) return Math.ceil(el.scrollTop + el.clientHeight) < el.scrollHeight
  return false
}

/**
 * Route wheel scrolling inside `rootRef` to the "thumb" sidebar (the middle item list)
 * unless the cursor sits over a region that can itself scroll in that direction. Effect:
 * scrolling over the header, the channel rail, the resize handle, or any dead space advances
 * the item list; the transcript reader / comment lists / nested scroll areas keep their own
 * native scroll (they're caught by the walk before we reach the root).
 *
 * `thumbSelector` resolves the item-list scroll viewport at event time (it lives behind a
 * Radix ScrollArea, so it's `[data-radix-scroll-area-viewport]`). Resolving lazily means we
 * don't care about mount order and we no-op cleanly when the thumb sidebar is absent (e.g.
 * the video channel, which has no item list).
 */
export function useScrollSink(
  rootRef: RefObject<HTMLElement | null>,
  thumbSelector: string,
  enabled: boolean
) {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      const thumb = root.querySelector(thumbSelector) as HTMLElement | null
      if (!thumb) return
      // walk up from the cursor target; bail to native scroll the moment we hit a region
      // that can move in this direction (the thumb viewport itself included — it scrolls
      // natively when hovered, same destination anyway). Also bail if we cross a
      // data-scroll-sink-boundary element — that marks an explicitly scrollable region
      // (e.g. the transcription detail pane) that should never forward its overflow
      // scroll to the thumb list, even when scrolled to the bottom.
      let el = e.target as HTMLElement | null
      while (el && el !== root) {
        if (el.hasAttribute('data-scroll-sink-boundary')) return
        if (canScrollY(el, e.deltaY)) return
        el = el.parentElement
      }
      e.preventDefault()
      thumb.scrollTop += e.deltaY
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [rootRef, thumbSelector, enabled])
}
