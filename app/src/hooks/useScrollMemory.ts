import { useEffect, useLayoutEffect, useRef } from 'react'

/** Last-known scrollTop per key, kept at module scope so a position survives the scroll
 *  container unmounting (e.g. leaving a channel and coming back). Small and app-lived. */
const scrollStore = new Map<string, number>()

/**
 * Remember a scroll container's position and restore it when you return.
 *
 * Why this exists: several views (影视 grid↔detail, 音乐, the timeline) let you navigate away
 * and back, and each used to lose your place — either by resetting to top or by clamping when
 * the content underneath got shorter. This hook binds a position to `key`: it saves on scroll
 * (so the value is current even if the element then unmounts) and restores on `key` change /
 * mount. Change `key` to switch "which position we're tracking" — e.g. per channel, or a
 * grid/detail layer marker — and each key keeps its own place.
 *
 * Attach the returned ref to the scrollable element. For a wrapper whose real scroller is a
 * nested node (Radix ScrollArea → its viewport), pass `getViewport` to resolve it from the ref.
 */
export function useScrollMemory<T extends HTMLElement = HTMLDivElement>(
  key: string,
  getViewport?: (root: T) => HTMLElement | null,
) {
  const rootRef = useRef<T | null>(null)
  const getViewportRef = useRef(getViewport)
  getViewportRef.current = getViewport
  const viewport = (): HTMLElement | null => {
    const root = rootRef.current
    if (!root) return null
    return getViewportRef.current ? getViewportRef.current(root) : root
  }

  // Save continuously while this key is mounted, so the stored value is up to date at the
  // moment the element unmounts (channel switch) — no save-on-unmount race with a detached node.
  useEffect(() => {
    const el = viewport()
    if (!el) return
    const onScroll = () => scrollStore.set(key, el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [key])

  // Restore before paint (no flash). Runs on key change and on (re)mount. Callers that render
  // content synchronously for a revisited key (e.g. per-channel item buckets) already have the
  // scroll height here, so the restored offset lands on real content.
  useLayoutEffect(() => {
    const el = viewport()
    if (el) el.scrollTop = scrollStore.get(key) ?? 0
  }, [key])

  return rootRef
}

/** Resolve the scrollable viewport inside a Radix ScrollArea root (what actually scrolls). */
export function scrollAreaViewport(root: HTMLElement): HTMLElement | null {
  return root.querySelector('[data-radix-scroll-area-viewport]')
}
