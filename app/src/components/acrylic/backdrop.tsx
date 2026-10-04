import * as React from "react"

import { cn } from "@/lib/utils"

// Acrylic Backdrop — the wallpaper the frosted chrome blurs over. A fixed, full-
// bleed layer pinned behind the whole app (-z-10). It paints ONLY under the
// Acrylic theme on the web; under `.vibrancy` (a Tauri/Electron window that has
// applied native OS material) it stays hidden so the real desktop shows through,
// and in plain light/dark it paints nothing. Visibility is governed entirely by
// theme CSS (see acrylic.css / the registry stylesheet) — the component itself is
// dumb and never reads the theme. Mount ONE at the app root.
//
// Pass `children` to supply a custom wallpaper instead of the built-in gradient.
function Backdrop({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      aria-hidden
      data-slot="backdrop"
      className={cn("pointer-events-none fixed inset-0 -z-10 overflow-hidden", className)}
    >
      {children ?? (
        // A DARK wallpaper: deep base + low-opacity glows. Dark enough that white text on
        // a translucent acrylic region over it stays readable, while the colour gives the
        // frost something to blur (the macOS "vibrancy over wallpaper" read). The palette
        // is a COHESIVE cool dusk — analogous indigo → navy → teal, no clashing warm
        // (magenta/green) accents — and the glows sit at low opacity so the field reads
        // calm and even behind reading content rather than as bright competing spotlights.
        // Override via `children` for a brand wallpaper.
        <>
          <div className="absolute inset-0 bg-[#0d1120]" />
          <div className="absolute inset-0 bg-gradient-to-br from-[#1c2550] via-[#121830] to-[#153042]" />
          <div className="absolute -left-32 -top-32 size-[42rem] rounded-full bg-[#4f5bd5] opacity-30 blur-3xl" />
          <div className="absolute -right-28 -top-20 size-[34rem] rounded-full bg-[#2b9dff] opacity-24 blur-3xl" />
          <div className="absolute bottom-[-14rem] left-1/3 size-[40rem] rounded-full bg-[#1e88a8] opacity-22 blur-3xl" />
        </>
      )}
    </div>
  )
}

export { Backdrop }

