import type { ComponentProps, HTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/utils.ts'
import { Badge } from './acrylic/badge.tsx'
import { Card, CardDescription, CardMedia, CardMediaOverlay, CardTitle } from './acrylic/card.tsx'

/**
 * MediaBadge — a Badge that sits ON a cover image (a rating, a source label, an episode
 * number). It IS a real `Badge`, so it shares the pill shape, the `sm` size scale and the
 * tracking of every other chip in the app; what it overrides is only the material.
 *
 * Why override it at all: the acrylic `secondary` chip is a translucent fill with
 * `text-foreground`, which has no guaranteed contrast over arbitrary photography — the badge
 * would be legible on one poster and invisible on the next. So the on-media pill carries its
 * own dark scrim and a white label (Apple: put the color on a solid layer, not on the
 * translucent foreground). Call sites pass the corner (`right-1.5 top-1.5`); this owns the rest.
 */
export function MediaBadge({ className, ...props }: ComponentProps<typeof Badge>) {
  return (
    <Badge
      variant="secondary"
      size="sm"
      className={cn('absolute z-10 border-0 bg-black/55 font-semibold text-white backdrop-blur-sm', className)}
      {...props}
    />
  )
}

// Hover feedback WITHOUT the lift: the acrylic Card's `interactive` prop bakes in a
// `hover:-translate-y-px` displacement — we drop `interactive` and keep only the soft
// float shadow (on ::before), so a tile gains depth on hover but never moves. Timing
// rides the acrylic spring token rather than a hand-picked duration.
//
// Exported so other tile components (PostCard's waterfall grid) share this ONE constant
// instead of pasting the same five lines — two copies of a "never hand-pick timings"
// value drift the moment either gets tuned.
export const HOVER_FLOAT =
  'before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-xl ' +
  'before:shadow-[0_12px_28px_rgba(0,0,0,0.28)] before:opacity-0 before:transition-opacity ' +
  'before:[transition-timing-function:var(--acr-spring-default)] ' +
  'before:[transition-duration:var(--acr-spring-default-duration)] hover:before:opacity-100'

/**
 * MediaCard — the standardized cover tile shared by the 影视 and 音乐 channels.
 *
 * It is the acrylic Card gallery anatomy, un-shipped from the docs into a reusable
 * component: a frosted `Card` whose cover is a real `CardMedia` (fixed `aspect-ratio`,
 * object-cover, plus CardMedia's own load-retry/fallback handling — this tile used to
 * hand-roll that frame and its `<img>`, which is exactly the pattern the acrylic skill
 * calls out as the #1 failure). Cover ratio is per-context (2/3 posters · 16/9 episode
 * thumbs · 1/1 album art), so a homogeneous grid stays uniform without cropping.
 *
 * `caption` picks which of the two shipped caption variants the tile uses:
 *   - `'below'` (default) — `CardTitle` / `CardDescription` in a padded div under the
 *     cover, on the glass. Used by 影视, where year/genre is real extra information.
 *   - `'overlay'` — `CardMediaOverlay`: the caption floats ON the cover over a bottom
 *     scrim, retyped for on-media contrast by the overlay itself. Used by 音乐, whose
 *     tiles are square album art that reads fine with the title over it.
 *
 * Either way the text is `CardTitle` / `CardDescription` at THEIR type scale — no
 * per-call-site font-size overrides. Only layout (`truncate`) is set here.
 *
 * `children` render absolutely-positioned INSIDE the cover frame — each call site
 * supplies its own overlays (a rating star, a source/count Badge, a hover ▶ button)
 * and positions them (`absolute right-1.5 top-1.5`, `group-hover:` off the wrapper's
 * `group`). Pass `href` for a link tile (影视, opens the source page in a new tab) or
 * `onOpen` for an in-app button tile (音乐, which also nests its own ▶ button — hence
 * a `role="button"` div, not a real `<button>`, so the nested control stays valid).
 */
export function MediaCard({
  src,
  alt = '',
  title,
  subtitle,
  ratio,
  caption = 'below',
  fallback,
  href,
  onOpen,
  ariaLabel,
  className,
  children,
  ...rest
}: {
  src?: string
  alt?: string
  title: ReactNode
  subtitle?: ReactNode
  ratio: string
  /** Where the title/description sit: under the cover (default) or over it on a scrim. */
  caption?: 'below' | 'overlay'
  fallback?: ReactNode
  href?: string
  onOpen?: () => void
  ariaLabel?: string
  className?: string
  children?: ReactNode
/**
   * 其余属性**原样落到根节点上**（下面三个分支各 spread 一次）。这一格不是装饰：
   * Radix 的 `asChild`（ContextMenu / Tooltip / Popover 的 Trigger）就是把 `onContextMenu`、
   * `data-state` 这些交给子组件，靠子组件自己转发到真 DOM 上。
   *
   * **不转发的失败是静音的**——菜单注册着、右键毫无反应、控制台一个字都没有。真栽过：
   * 播客卡上的「在对话中引用」怎么点都不出来，而两边的代码单看都完全正确。
   */
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'className' | 'children'>) {
  const hasSubtitle = subtitle != null && subtitle !== ''
  const inner = (
    <Card className={cn('flex h-full flex-col overflow-hidden p-0 text-left', HOVER_FLOAT, className)}>
      <CardMedia ratio={ratio} src={src} alt={alt} fallback={fallback}>
        {children}
        {caption === 'overlay' ? (
          <CardMediaOverlay>
            <CardTitle>{title}</CardTitle>
            {hasSubtitle && <CardDescription>{subtitle}</CardDescription>}
          </CardMediaOverlay>
        ) : null}
      </CardMedia>
      {caption === 'below' ? (
        <div className="flex flex-col gap-1 px-3 pb-3 pt-2.5">
          <CardTitle className="self-stretch truncate">{title}</CardTitle>
          {hasSubtitle && <CardDescription className="truncate">{subtitle}</CardDescription>}
        </div>
      ) : null}
    </Card>
  )

  // `data-nested-surface` recesses the Card to `--acr-card-nested` (a translucent
  // tint) instead of the opaque `--acr-surface`. The channels lay these tiles on the
  // flat app panel with no wallpaper to frost, so in light theme a `#ffffff` surface
  // would vanish into the white panel — the nested tint keeps the card visible in
  // both themes (the same fix entry.css notes for the rsshub grouping page).
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        data-nested-surface="true"
        className="group block focus:outline-none"
        {...rest}
      >
        {inner}
      </a>
    )
  }

  // Neither a link nor an action: a tile that only presents (a work's cast has nowhere to
  // navigate to). Render it inert — a focusable `role="button"` that does nothing on Enter is
  // a promise to assistive tech that no call site can keep.
  if (!onOpen) {
    return <div data-nested-surface="true" className="group block text-left" {...rest}>{inner}</div>
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      data-nested-surface="true"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen?.()
        }
      }}
      className="group block cursor-pointer text-left focus:outline-none"
      {...rest}
    >
      {inner}
    </div>
  )
}
