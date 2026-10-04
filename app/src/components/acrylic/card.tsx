"use client"

import * as React from "react"
import { ImageOff } from "lucide-react"

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
 *  no descendant re-composes the float into an inner "wrap" seam.
 *
 *  `isolate` is load-bearing: without its own stacking context the card's
 *  `backdrop-blur` samples the `::before` float sitting behind it and pulls that
 *  shadow INTO the glass as a dark top band on hover. Isolating the card keeps the
 *  backdrop sampling the page behind the card, not its own ::before, so the float
 *  reads only as outer elevation. */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    interactive?: boolean
    /**
     * 声明**本卡是一层"面"**，让它**里面**的 Card 退成 `--acr-card-nested` 嵌套着色。
     *
     * **它不会让本卡自己退色**——那条规则是后代选择器
     * （`[data-nested-surface="true"] [data-slot="card"]`，见 entry.css）。想让这张卡退色，
     * 标记要挂在它的**父容器**上（`<div data-nested-surface="true">`）。挂错位置不会报错，
     * 只是这张卡落回 `--acr-surface`：dark 下看不出来，light 下就是白面板上一张白卡 = 隐形。
     */
    nestedSurface?: boolean
  }
>(({ className, interactive = false, nestedSurface = false, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card"
    data-nested-surface={nestedSurface || undefined}
    className={cn(
      "acr-frosted relative isolate rounded-xl bg-[var(--acr-surface)] backdrop-blur-xl",
      "transition-[translate,background-color] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)]",
      interactive &&
        "hover:-translate-y-px hover:bg-[var(--acr-surface-hover)] " +
        "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-xl " +
        "before:shadow-[0_12px_28px_rgba(0,0,0,0.28)] before:opacity-0 " +
        "before:transition-opacity before:[transition-timing-function:var(--acr-spring-default)] before:[transition-duration:var(--acr-spring-default-duration)] hover:before:opacity-100",
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
      className={cn("self-center text-[15px] font-semibold leading-none [letter-spacing:var(--text-title3-tracking)]", className)}
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

// Media sub-parts — the gallery / media-card anatomy on the frosted Card. CardMedia is
// the fixed-ratio cover frame. Give it `src` and it OWNS the cover image (object-cover,
// filling + cropping the ratio box) with the same load-error strategy as MediaBox: a
// failed load retries with exponential backoff (`retryDelayMs * 2 ** attempt`), and after
// `maxRetries` it gives up and shows `fallback` (default `ImageOff`). A missing `src`
// with a `fallback` shows the placeholder straight away — the avatar-with-no-photo case.
// Without `src`, it's just a frame: a direct `<img>` child is still auto-covered
// (`[&>img]:size-full [&>img]:object-cover`). Either way, badges and the caption overlay
// ride inside it as positioned children. Pass `ratio` ("16 / 9", "2 / 3", "1 / 1") to
// lock the aspect so a grid stays uniform.
//
// CardMediaOverlay is the caption-on-media variant: a bottom scrim
// (`bg-gradient-to-t from-black/85`) that darkens the media so text stays legible.
// Nesting is the whole point — put the SAME `CardTitle` / `CardDescription` inside and
// the overlay retypes them for on-media contrast: white / white-70, stepped down to the
// caption scale (title 15→13, description 13→12) and truncated. The "caption under the
// media" variant is not a component — it's just CardTitle / CardDescription in a padded
// div BELOW CardMedia, which needs no special treatment.
const CARD_MEDIA_DEFAULT_MAX_RETRIES = 2
const CARD_MEDIA_DEFAULT_RETRY_DELAY_MS = 800

function CardMedia({
  className,
  ratio,
  style,
  src,
  alt = "",
  fallback,
  imageClassName,
  maxRetries = CARD_MEDIA_DEFAULT_MAX_RETRIES,
  retryDelayMs = CARD_MEDIA_DEFAULT_RETRY_DELAY_MS,
  onNaturalSize,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  ratio?: string
  src?: string
  alt?: string
  fallback?: React.ReactNode
  imageClassName?: string
  /** Failed loads to retry with backoff before giving up and showing `fallback`. */
  maxRetries?: number
  /** Base backoff delay in ms; doubles each attempt (attempt 0 waits this long, attempt 1 waits 2x, ...). */
  retryDelayMs?: number
  /** Fired with the owned image's intrinsic pixel size once it loads — lets a parent
   *  (e.g. MediaBox) size a frame to the media's natural aspect. */
  onNaturalSize?: (width: number, height: number) => void
}) {
  const retryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const [pending, setPending] = React.useState(false)

  const clearRetryTimer = React.useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [])

  // A new src is a fresh load: drop any in-flight retry and reset the attempt/fail state.
  React.useLayoutEffect(() => {
    clearRetryTimer()
    setFailed(false)
    setAttempt(0)
    setPending(false)
  }, [src, clearRetryTimer])

  React.useEffect(() => clearRetryTimer, [clearRetryTimer])

  const handleImageError = React.useCallback(() => {
    if (attempt >= maxRetries) {
      setFailed(true)
      return
    }
    setPending(true)
    const delay = retryDelayMs * 2 ** attempt
    retryTimeoutRef.current = setTimeout(() => {
      retryTimeoutRef.current = null
      setAttempt((a) => a + 1)
      setPending(false)
    }, delay)
  }, [attempt, maxRetries, retryDelayMs])

  // Show the placeholder when we've given up (`failed`) or there's no src to load but a
  // fallback was supplied. During a retry backoff (`pending`) show neither — a brief gap.
  const showFallback = !pending && (failed || (!src && fallback != null))

  return (
    <div
      data-slot="card-media"
      className={cn("relative w-full overflow-hidden [&>img]:size-full [&>img]:object-cover", className)}
      style={ratio ? { aspectRatio: ratio, ...style } : style}
      {...props}
    >
      {src && !failed && !pending ? (
        // key={attempt} remounts the <img> so a retry re-requests the same URL.
        <img
          key={attempt}
          src={src}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          className={cn("size-full object-cover", imageClassName)}
          onLoad={(event) => {
            if (attempt !== 0) setAttempt(0)
            const image = event.currentTarget
            if (image.naturalWidth && image.naturalHeight) {
              onNaturalSize?.(image.naturalWidth, image.naturalHeight)
            }
          }}
          onError={handleImageError}
        />
      ) : null}
      {showFallback ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--acr-card-nested)] text-muted-foreground/50">
          {fallback ?? <ImageOff className="size-7" />}
        </div>
      ) : null}
      {children}
    </div>
  )
}

function CardMediaOverlay({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-media-overlay"
      className={cn(
        "absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2.5 pt-8",
        "[&_[data-slot=card-title]]:self-stretch [&_[data-slot=card-title]]:truncate [&_[data-slot=card-title]]:text-[13px] [&_[data-slot=card-title]]:leading-snug [&_[data-slot=card-title]]:text-white",
        "[&_[data-slot=card-description]]:truncate [&_[data-slot=card-description]]:text-[12px] [&_[data-slot=card-description]]:leading-snug [&_[data-slot=card-description]]:text-white/70",
        className
      )}
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
  CardMedia,
  CardMediaOverlay,
}

