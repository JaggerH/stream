import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Acrylic Input — the macOS 26 Text Field. Geometry (height/radius/padding/font)
// is lifted from the kit; radius is uniform ~height/4 (4/5/6/7/9) — text fields
// never go capsule. Deliberately NO `backdrop-blur` of its own: it sits inside
// already-blurred chrome, and a nested backdrop-filter would paint a hazy
// rectangle (artifact).
//
// The kit ships a field in two parallel families — "Content Area" (solid surface,
// hairline border) and "Over-glass" (translucent fill, no border, for a field on
// a vibrancy surface). We DON'T expose that as a prop, because which one is
// correct depends on the runtime theme + where the field sits — facts the author
// can't know statically. Instead the surface resolves through theme tokens:
//   --acr-input        light/dark → opaque control fill ; acrylic → a translucent
//                      over-glass tint, no border. The acrylic tint is dark (recessed)
//                      on the light glass page, and a scoped rule flips it to a light
//                      tint inside the dark sidebar (acrylic.css).
//   --acr-input-border light/dark → hairline ; acrylic → transparent.
// So an Input becomes "Over-glass" on its own the moment the theme is Acrylic — no
// author decision; the tint follows whichever surface (light/dark glass) it sits on.
const inputVariants = cva(
  cn(
    "flex w-full min-w-0 border border-[var(--acr-input-border)] bg-[var(--acr-input)] text-foreground outline-none",
    // Motion on the shared spring token (matches button/searchbar); box-shadow is in
    // the list so the focus ring animates in on the spring instead of snapping.
    "transition-[color,background-color,border-color,box-shadow] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)]",
    "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
    "hover:border-[var(--acr-border)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "file:inline-flex file:border-0 file:bg-transparent file:font-medium file:text-foreground"
  ),
  {
    variants: {
      // The five macOS control sizes (heights 16/20/24/28/36 from the kit). Type
      // carries its size-specific tracking companion (§15): mini/small get a slight
      // positive, 13/15px sit at 0, xl 17px a slight negative like a title. mini/
      // small/medium map to real AppKit control sizes (10/11/13); large/xl are the
      // library's own bigger sizes, so the font scales WITH the control instead of
      // staying pinned at 13px (kept in step with Searchbar's scale).
      size: {
        mini: "h-4 rounded-[4px] px-1.5 text-[10px] [letter-spacing:var(--text-footnote-tracking)]",
        small: "h-5 rounded-[5px] px-1.5 text-[11px] [letter-spacing:var(--text-subheadline-tracking)]",
        medium: "h-6 rounded-[6px] px-2 text-[13px]",
        large: "h-7 rounded-[7px] px-2 text-[15px]",
        xl: "h-9 rounded-[9px] px-2.5 text-[17px] [letter-spacing:var(--text-title2-tracking)]",
      },
    },
    defaultVariants: { size: "medium" },
  }
)

function Input({
  className,
  type,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(inputVariants({ size, className }))}
      {...props}
    />
  )
}

export { Input, inputVariants }

