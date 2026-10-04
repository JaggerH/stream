import * as React from "react"
import { Slot as SlotPrimitive } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Acrylic Button — modeled on the Apple macOS 26 UI Kit Buttons page.
// Three orthogonal axes:
//   • variant — the kit's push-button colors plus borderless ghost/link actions. `default`
//     is the solid, high-emphasis button; the others are low-emphasis tinted fills
//     or borderless actions. Colors resolve through the theme vars so they flip light/dark.
//   • size    — the five macOS control sizes (heights 16/20/24/28/36). Geometry
//     (height/radius/padding/font) is lifted verbatim; radius is NOT a single
//     formula: mini/small/medium are ~quarter-height (4/5/6) while large/xl snap to
//     a full capsule (14/18).
//   • icon    — a boolean that turns any size×variant into the kit's round "Arrow
//     Button": square (width = the size's height), full-circle radius, no padding,
//     with the glyph scaled to the size. So `<Button icon size="large" variant="ghost">`
//     is a large round ghost icon button — icon is a SHAPE, orthogonal to size/color.
// Hover is a brightness/fill shift, not a color swap, so it reads on glass.
// Motion runs on the acrylic spring substrate: hover/press transitions use the
// critically-damped --acr-spring-default token (NOT Tailwind's hand-picked 150ms
// ease), so they inherit the reduced-motion collapse + @supports fallback shipped
// with the token. Only the properties that actually change are transitioned — never
// `transition-all`, which would also animate geometry across size/variant swaps.
// The press yields a physical scale(0.97) (Apple §1 Response), springing back on release.
const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,box-shadow,filter,opacity,scale] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)] active:scale-[0.97] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:                                       // Bordered Default — solid accent, white label (prominent)
          "bg-primary text-primary-foreground shadow-sm hover:brightness-110 active:brightness-95",
        secondary:                                     // Bordered Secondary — 10% accent tint, accent label
          "bg-primary/10 text-primary hover:bg-primary/15 active:bg-primary/20",
        destructive:                                   // Bordered Destructive — 25% red tint, red label
          "bg-destructive/25 text-destructive hover:bg-destructive/35 active:bg-destructive/45",
        neutral:                                       // Neutral — gray fill, foreground label
          "bg-[var(--acr-chip)] text-foreground hover:bg-[var(--acr-chip-hover)]",
        ghost:                                         // Borderless neutral — no fill at rest, foreground label/glyph; hover reveals the neutral chip fill
          "bg-transparent text-foreground hover:bg-[var(--acr-chip)] active:bg-[var(--acr-chip-hover)]",
        link:                                          // Borderless accent text action — use for link-like primary actions, not toolbar chrome. No press-scale: text, not a surface.
          "bg-transparent text-primary hover:underline hover:underline-offset-4 active:opacity-80 active:scale-100",
      },
      // The five macOS control sizes (heights 16/20/24/28/36 from the kit).
      // gap = the icon↔label spacing: the kit renders icon+label as inline SF text
      // (glyph + a single space), so the gap is ~one SF Pro space (~0.25em ≈ 4px at
      // 13px) — gap-1, NOT the looser 6/8px we had. Padding (px-[7]/[10]/4) is lifted
      // verbatim from the kit's text-layer insets.
      // Tracking is the type scale's size-specific companion (Apple §15): each px size
      // pairs with its --text-<size>-tracking so the small 10/11px labels get their
      // legibility-restoring positive tracking. 13px (body) tracking is 0 — written
      // explicitly to state intent, not left to the browser default. Leading is omitted
      // deliberately: these are single-line controls whose height is fixed by h-*.
      size: {
        mini: "h-4 gap-1 rounded-[4px] px-[7px] text-[10px] [letter-spacing:var(--text-footnote-tracking)] [&_svg]:size-3",
        small: "h-5 gap-1 rounded-[5px] px-[10px] text-[11px] [letter-spacing:var(--text-subheadline-tracking)] [&_svg]:size-3",
        medium: "h-6 gap-1 rounded-[6px] px-4 text-[13px] [letter-spacing:var(--text-body-tracking)] [&_svg]:size-3.5",
        large: "h-7 gap-1 rounded-[14px] px-4 text-[13px] [letter-spacing:var(--text-body-tracking)] [&_svg]:size-4",
        xl: "h-9 gap-1 rounded-[18px] px-4 text-[13px] [letter-spacing:var(--text-body-tracking)] [&_svg]:size-[18px]",
      },
      // Icon shape — orthogonal to size/variant; the per-size geometry is set in
      // compoundVariants below (square diameter = the size's height, glyph scaled).
      icon: { true: "rounded-full p-0", false: "" },
    },
    compoundVariants: [
      // Round icon buttons (the kit's Arrow Button): diameter = the control height
      // (16/20/24/28/36), glyph scales with the button (~0.6–0.75× — web-style).
      { icon: true, size: "mini", class: "size-4 [&_svg]:size-3" },
      { icon: true, size: "small", class: "size-5 [&_svg]:size-3.5" },
      { icon: true, size: "medium", class: "size-6 [&_svg]:size-4" },
      { icon: true, size: "large", class: "size-7 [&_svg]:size-[18px]" },
      { icon: true, size: "xl", class: "size-9 [&_svg]:size-[22px]" },
    ],
    defaultVariants: { variant: "default", size: "medium", icon: false },
  }
)

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<"button"> &
    VariantProps<typeof buttonVariants> & { asChild?: boolean }
>(({ className, variant, size, icon, asChild = false, ...props }, ref) => {
  const Comp = asChild ? SlotPrimitive.Slot : "button"
  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-icon={icon || undefined}
      className={cn(buttonVariants({ variant, size, icon, className }))}
      {...props}
    />
  )
})
Button.displayName = "Button"

export { Button, buttonVariants }

