import * as React from "react"

import { cn } from "@/lib/utils"

/** Card — a dark-glass surface card. A charcoal translucent pane over a blurred backdrop
 *  (the background shows through, softly darkened) — flat at rest with NO shadow,
 *  no rim/border, no inner bevel. `interactive` adds a hover lift + a touch lighter
 *  fill + a soft float shadow that appears only on hover. Pairs with the frosted
 *  Acrylic Dialog panel.
 *
 *  The hover float lives on a `::before` backing layer (an OUTSET box-shadow), not on
 *  the card itself. The surface is translucent, so a shadow painted on the card —
 *  whether `box-shadow` or `filter: drop-shadow` — bleeds THROUGH it as an internal
 *  darkening. An outset box-shadow is never painted under its own box, so on ::before
 *  (inset-0, behind the card) the lift stays purely OUTSIDE the card with no internal
 *  smudge. Scoping it to ::before also keeps `--tw-shadow` off the card's children, so
 *  no descendant re-composes the float into an inner "wrap" seam. */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    interactive?: boolean
    nestedSurface?: boolean
  }
>(({ className, interactive = false, nestedSurface = false, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card"
    data-nested-surface={nestedSurface || undefined}
    className={cn(
      "acr-frosted relative rounded-xl bg-[var(--acr-surface)] backdrop-blur-xl",
      "transition-[transform,background-color] duration-200",
      interactive &&
        "hover:-translate-y-px hover:bg-[var(--acr-surface-hover)] " +
        "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-xl " +
        "before:shadow-[0_12px_28px_rgba(0,0,0,0.28)] before:opacity-0 " +
        "before:transition-opacity before:duration-200 hover:before:opacity-100",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

// Card composition sub-parts — the shadcn Card anatomy (Header / Title / Description
// / Action / Content / Footer) so the frosted Card composes like the standard Card.
// Layout/typography only; colors come from the frosted root + theme tokens. The root
// has no padding of its own, so compose with `flex flex-col gap-6 py-6` (drop pt with
// `pt-0` when a media element sits flush at the top).
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("self-center text-[15px] font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-[13px] leading-snug text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-start-1 flex items-start self-start justify-self-end", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
}
