import * as React from "react"

// Single source of truth for the `html.modal-acrylic` paint. The class means
// exactly ONE thing: "at least one OPEN overlay (Dialog/AlertDialog/Sheet) is in
// the DOM" — so the overlay's `backdrop-filter` has opaque body pixels to frost on
// a TRANSPARENT vibrancy window (Tauri/Electron). On a normal opaque-body web page
// it's a harmless no-op. See acrylic.css / the Tauri guide.
//
// It is driven by DOM FACT via a MutationObserver, NOT a hand-kept counter. A
// module-level open-overlay counter (incremented in an effect, decremented in its
// cleanup) desyncs under React StrictMode: the mount→unmount→remount of a
// freshly-mounted overlay whose `open` is a literal `true` (e.g. `<Dialog open>`
// inside a conditionally-rendered wrapper) can DROP the final cleanup, leaving the
// counter — and the class — stuck ON. A stuck class flips
// `html.vibrancy.modal-acrylic`'s `--background` to near-opaque and kills the native
// acrylic. Reading the DOM never desyncs: however an overlay leaves (normal close,
// StrictMode churn, parent unmount, exit animation), the observer recomputes and the
// class follows reality — and because it watches `data-state`, the un-paint still
// fires the moment an overlay flips to closing, staying in sync with the fade-out.

const OVERLAY_OPEN =
  "[role=dialog][data-state=open],[role=alertdialog][data-state=open]"

let observer: MutationObserver | null = null
let refs = 0

function recompute() {
  const open = document.querySelector(OVERLAY_OPEN) != null
  document.documentElement.classList.toggle("modal-acrylic", open)
}

// Lazily start a single observer the first time any overlay mounts; it watches the
// document for overlays being added/removed (childList) and for their `data-state`
// flipping open↔closed. `refs` only governs the observer's lifecycle — even if it
// drifts (a dropped cleanup leaves it too high), class CORRECTNESS is unaffected,
// because `recompute` reads the live DOM. Drift can only leak an idle observer,
// never stick the class.
function acquire() {
  refs += 1
  if (!observer) {
    observer = new MutationObserver(recompute)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    })
  }
  recompute()
}

function release() {
  refs = Math.max(0, refs - 1)
  // Recompute after the DOM settles (Radix flips data-state=closed / unmounts the
  // Content), so a closing overlay's fade-out and the body un-paint stay in sync.
  queueMicrotask(recompute)
  if (refs === 0 && observer) {
    observer.disconnect()
    observer = null
    queueMicrotask(recompute)
  }
}

// Hook form — keeps the observer alive while the caller is mounted. Used by the
// Dialog / AlertDialog / Sheet Content wrappers, and available for manual use.
export function useModalAcrylicBody() {
  React.useEffect(() => {
    acquire()
    return release
  }, [])
}

// Component form — drop inside a Dialog/AlertDialog/Sheet Content. Same effect as
// the hook; kept as a JSX-friendly marker whose presence in the overlay subtree
// also nudges the observer. The class is decided by the DOM, so it no longer needs
// to watch the host's data-state itself.
export function ModalAcrylicBody() {
  useModalAcrylicBody()
  return React.createElement("span", {
    "aria-hidden": true,
    style: { display: "none" },
  })
}

