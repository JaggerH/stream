import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Acrylic Badge — shadcn's Badge with its base styling copied verbatim (shape,
// sizing, focus ring, the six variants). Only the COLORS are swapped to the
// acrylic theme tokens: `default` is the accent (--primary), `secondary` the
// neutral chip fill, accent hovers map to --acr-hover. All flip light/dark via
// the theme, so no manual dark: overrides are needed.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-[var(--acr-chip)] text-foreground [a&]:hover:bg-[var(--acr-chip-hover)]",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 [a&]:hover:bg-destructive/90",
        outline:
          "border-[var(--acr-border)] text-foreground [a&]:hover:bg-[var(--acr-hover)]",
        ghost: "[a&]:hover:bg-[var(--acr-hover)]",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
      },
      // `sm` keeps the font-size and line-height in ONE place: a consumer who
      // overrides text size with a `text-[Npx]` className strips the base
      // `leading-none` (tailwind-merge drops the earlier line-height), so the badge
      // would inherit a tall prose line-height and balloon into an oval. Sizing via
      // this prop instead keeps `leading-none` glued to the size — no override, no
      // balloon. Use `sm` for compact count/status pills.
      //
      // `sm` also pins an explicit height and zeroes vertical padding: with
      // `leading-none` the text box shrinks to the font's em-box, whose metrics sit
      // asymmetrically inside `py-0.5` padding (text rides high). A fixed h-[18px]
      // lets the flexbox `items-center` do the vertical centering instead.
      //
      // `pb-[2px]` is an OPTICAL correction on top of that: the popup font stack
      // resolves to Segoe UI on Windows, whose ascent (~1.08em) dwarfs its descent
      // (~0.25em), so with `leading-none` the glyphs paint ~0.16em (~1.8px at 11px)
      // BELOW the geometric center that `items-center` computes from the em-box.
      // Padding the bottom by 2px lifts the content ~1px to visually re-center the
      // text. Metrics-based, not layout-based — do not "fix" by tweaking flex.
      size: {
        default: "",
        sm: "h-[18px] px-1.5 py-0 pb-[2px] text-[11px] leading-none",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
