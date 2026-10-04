import * as React from "react"

import { cn } from "@/lib/utils"

// Acrylic Backdrop — the wallpaper the frosted chrome blurs over. A fixed, full-
// bleed layer pinned behind the whole app (-z-10). It paints ONLY under the
// Acrylic theme on the web; under `.vibrancy` (a native window that has
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
        // A DARK wallpaper: deep base + low-opacity deep-color glows. Dark enough that
        // white text on a translucent acrylic region over it stays readable, while the
        // colour gives the frost something to blur (the macOS "vibrancy over wallpaper"
        // read). Override via `children` for a brand wallpaper.
        <>
          <div className="absolute inset-0 bg-[#15122a]" />
          <div className="absolute inset-0 bg-gradient-to-br from-[#3a2f86] via-[#241b48] to-[#7a2a5c]" />
          <div className="absolute -left-32 -top-32 size-[40rem] rounded-full bg-[#7c6bff] opacity-45 blur-3xl" />
          <div className="absolute -right-24 -top-24 size-[34rem] rounded-full bg-[#2b9dff] opacity-40 blur-3xl" />
          <div className="absolute bottom-[-12rem] left-1/4 size-[40rem] rounded-full bg-[#ff5c93] opacity-38 blur-3xl" />
          <div className="absolute -bottom-24 right-1/4 size-[30rem] rounded-full bg-[#34d57e] opacity-33 blur-3xl" />
        </>
      )}
    </div>
  )
}

export { Backdrop }
