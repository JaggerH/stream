import * as React from "react"

import { cn } from "@/lib/utils"

// Acrylic Table — shadcn's Table, recolored to the Acrylic macOS material.
//
// Acrylic delta vs shadcn:
//  - Flat glass citizen: no own surface. It sits transparently on whatever it is
//    dropped into and composes inside <Card>; depth comes from the container.
//  - Row highlight is the macOS inset-rounded pill (same language as DropdownMenu
//    / Command / Item), NOT a full-bleed rectangular tint: a ~7px rounded fill
//    that sits inset from the container edge (put the table in a Card / padded
//    surface — the padding IS the inset, exactly like a menu item in its panel).
//    Hover = neutral --acr-hover; selected (data-state="selected") = the macOS
//    key-window selection, a SOLID bg-primary fill with primary-foreground text
//    on every cell (hover is suppressed on a selected row so the two highlights
//    never fight). Wired onto the spring substrate (color transition only — a
//    row is not a press target, so NO active:scale).
//  - Rounded corners need border-separate. Radius is applied ONLY to the
//    highlighted (hover / selected) row — at rest the cells are square, so the
//    hairline separators (--acr-border-soft between body rows, the firmer
//    --acr-border under the header) stay perfectly straight instead of curling
//    at the corners. A highlighted row drops its own separator AND the one
//    belonging to the row above it, so no hairline ever crosses the pill's top
//    or bottom edge.
//  - Column labels use the small subheadline size + its tracking companion,
//    muted (text-muted-foreground), Apple label style.
//  - Horizontal overflow uses the macOS thin overlay scrollbar (scrollbar-mac).
//
// Anatomy is shadcn 1:1 — compose Table > TableHeader/TableBody/TableFooter,
// each holding TableRow, cells are TableHead (header) / TableCell (body).
// Right-align numeric columns with className="text-right" on both head and cell.

function Table({
  className,
  scrollable = true,
  ...props
}: React.ComponentProps<"table"> & { scrollable?: boolean }) {
  const table = (
    <table
      data-slot="table"
      className={cn("w-full caption-bottom border-separate border-spacing-0 text-sm", className)}
      {...props}
    />
  )
  // scrollable={false} drops the wrapper. Acrylic divergence from shadcn, and the
  // ONLY way `TableHeader sticky` works when the page (or an outer ScrollArea) is
  // what scrolls: the wrapper's overflow-x makes IT the scroll container, so a
  // sticky <th> would stick to a box that never scrolls vertically and read as
  // if sticky were broken.
  if (!scrollable) return table
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto scrollbar-mac"
    >
      {table}
    </div>
  )
}

function TableHeader({
  className,
  sticky = false,
  ...props
}: React.ComponentProps<"thead"> & { sticky?: boolean }) {
  return (
    <thead
      data-slot="table-header"
      data-sticky={sticky || undefined}
      className={cn(
        "[&_th]:border-b [&_th]:border-b-[var(--acr-border)]",
        // sticky = the header becomes floating chrome the rows scroll UNDER, so it
        // needs a material (a transparent thead would let rows show through) and it
        // needs the row geometry: the same 7px the row pill uses, on the bar's outer
        // top corners, or the bar reads as a square block inside a rounded surface
        // while every row under it is a rounded pill. Sticky lives on the <th>, not
        // the <thead>/<tr> — those are internal table boxes and don't take position.
        sticky &&
          "[&>tr>th]:sticky [&>tr>th]:top-0 [&>tr>th]:z-10 [&>tr>th]:bg-[var(--acr-surface)] [&>tr>th]:backdrop-blur-xl [&>tr>th:first-child]:rounded-tl-[7px] [&>tr>th:last-child]:rounded-tr-[7px]",
        className
      )}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        "[&_tr:not(:last-child)>td]:border-b [&_tr:not(:last-child)>td]:border-b-[var(--acr-border-soft)]",
        // A highlighted row drops its own separator AND the one above it — the
        // pill is a closed shape, so a hairline must never cross either edge.
        // All four suppressors live HERE, next to the rule they cancel: the
        // separator is a tbody-level rule, so a canceller written on TableRow
        // ([data-state=selected]>td, 0-2-1) loses to it (0-2-2) and silently
        // does nothing. The :not(:last-child) is what buys the extra weight.
        "[&_tr:hover:not(:last-child)>td]:border-b-transparent [&_tr[data-state=selected]:not(:last-child)>td]:border-b-transparent",
        "[&_tr:has(+tr:hover)>td]:border-b-transparent [&_tr:has(+tr[data-state=selected])>td]:border-b-transparent",
        // Hover is the NEUTRAL highlight only — never on a selected row, whose
        // accent fill would otherwise lose to it on specificity.
        "[&_tr:hover:not([data-state=selected])>td]:bg-[var(--acr-hover)] [&_tr:hover>td:first-child]:rounded-l-[7px] [&_tr:hover>td:last-child]:rounded-r-[7px]",
        className
      )}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "font-medium [&>tr>td]:bg-[var(--acr-chip)] [&>tr>td:first-child]:rounded-l-[7px] [&>tr>td:last-child]:rounded-r-[7px]",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "group/table-row",
        "[&>td]:transition-colors [&>td]:[transition-timing-function:var(--acr-spring-default)] [&>td]:[transition-duration:var(--acr-spring-default-duration)]",
        // Selected = the macOS key-window selection: SOLID accent, white label.
        // Every cell goes to primary-foreground (a muted column would be
        // illegible on the fill); dim a secondary column back with the
        // group-data-[state=selected]/table-row: hook, like Badge does in Item.
        "data-[state=selected]:[&>td]:bg-primary data-[state=selected]:[&>td]:text-primary-foreground data-[state=selected]:[&>td:first-child]:rounded-l-[7px] data-[state=selected]:[&>td:last-child]:rounded-r-[7px]",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-3 text-left align-middle font-medium whitespace-nowrap text-muted-foreground text-[length:var(--text-subheadline)] [letter-spacing:var(--text-subheadline-tracking)] [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-muted-foreground text-[length:var(--text-footnote)] [letter-spacing:var(--text-footnote-tracking)]", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
}
