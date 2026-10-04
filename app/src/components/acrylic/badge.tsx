import * as React from "react"
import { Slot as SlotPrimitive } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Acrylic Badge — shadcn's Badge with its base styling copied verbatim (shape,
// sizing, focus ring, the six variants). Only the COLORS are swapped to the
// acrylic theme tokens: `default` is the accent (--primary), `secondary` the
// neutral chip fill, accent hovers map to --acr-hover. All flip light/dark via
// the theme, so no manual dark: overrides are needed.
//
// `secondary` / `outline` assume the surface underneath is the normal panel
// background — their fill is a translucent --acr-chip wash over a fixed
// text-foreground. Nest one inside a selected `Item` row (solid bg-primary)
// and that assumption breaks: the wash barely tints the accent color, but the
// text color doesn't follow, so contrast can collapse. `Item`'s root carries
// `group/item` for exactly this kind of cascading (ItemMedia already reads
// `group-data-[size=*]/item:`); these two variants opt into the same
// mechanism for `group-data-[selected=true]/item:` so a nested badge escalates
// alongside the title/description text a selected row already retargets.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap transition-[color,background-color,box-shadow] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-[var(--acr-chip)] text-foreground [a&]:hover:bg-[var(--acr-chip-hover)] group-data-[selected=true]/item:bg-white/15 group-data-[selected=true]/item:text-primary-foreground",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 [a&]:hover:bg-destructive/90",
        outline:
          "border-[var(--acr-border)] text-foreground [a&]:hover:bg-[var(--acr-hover)] group-data-[selected=true]/item:border-primary-foreground/30 group-data-[selected=true]/item:text-primary-foreground",
        ghost: "[a&]:hover:bg-[var(--acr-hover)]",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
      },
      // `sm` keeps the font-size and line-height in ONE place: a consumer who
      // overrides text size with a `text-[Npx]` className strips the base
      // `leading-none` (tailwind-merge drops the earlier line-height), so the badge
      // would inherit a tall prose line-height and balloon into an oval. Sizing via
      // this prop instead keeps `leading-none` glued to the size — no override, no
      // balloon. Use `sm` for compact count/status pills.
      size: {
        default: "",
        sm: "px-1.5 text-[11px] leading-none [letter-spacing:var(--text-subheadline-tracking)]",
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
  const Comp = asChild ? SlotPrimitive.Slot : "span"

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

