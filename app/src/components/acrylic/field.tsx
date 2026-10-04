import * as React from "react"
import { Slot as SlotPrimitive } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Acrylic Field — the macOS 26 Form layout family. A macOS Form is a LAYOUT
// wrapper, not a control: each Field is one row (a leading label column + a
// trailing control sharing one baseline), rows stacked with a uniform vertical
// rhythm and divided by 1px hairline separators. Tokens here are spacing +
// typography lifted from the Apple macOS 26 UI Kit (tokens/form.json). Colors
// resolve through the Acrylic theme vars (--foreground/--muted-foreground/
// --destructive/--acr-field) so they flip light/dark.
//
// API mirrors shadcn/ui's Field family verbatim (Field, FieldLabel, FieldTitle,
// FieldDescription, FieldError, FieldContent, FieldGroup, FieldSet, FieldLegend,
// FieldSeparator). Most pieces are presentational; only FieldError holds derived
// state and stays a plain function component (no hooks needed).

const fieldVariants = cva("group/field data-[invalid=true]:text-destructive", {
  variants: {
    orientation: {
      // horizontal (the macOS standard, default) = label hugs the left, control
      // fills the right, and the description/error sit BELOW the control, aligned
      // under it (col 2). A 2-col grid handles a full-width Input (w-full) cleanly.
      horizontal:
        "grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 [&>[data-slot=field-description]]:col-start-2 [&>[data-slot=field-error]]:col-start-2",
      // vertical = label over control (use for wide controls / textareas).
      vertical: "flex flex-col gap-1.5",
      // responsive = vertical on a narrow FieldGroup, the macOS row once wide.
      responsive:
        "flex flex-col gap-1.5 @md/field-group:grid @md/field-group:grid-cols-[auto_1fr] @md/field-group:items-center @md/field-group:gap-x-4 @md/field-group:gap-y-1 @md/field-group:[&>[data-slot=field-description]]:col-start-2 @md/field-group:[&>[data-slot=field-error]]:col-start-2",
    },
  },
  defaultVariants: { orientation: "horizontal" },
})

// The control-size axis, named exactly like Input/Select/Combobox's so a row
// declares ONE size and both halves agree: Input already scales its type with the
// control (10/11/13/15/17), but FieldLabel used to sit pinned at 13px — pair it
// with an xl control and the label reads 4px smaller than the value beside it.
// Field owns the axis because the label can't see its control; children read it
// off group/field, the same mechanism ItemMedia uses for group-data-[size=*]/item:.
type FieldSize = "mini" | "small" | "medium" | "large" | "xl"

function Field({
  className,
  orientation,
  size = "medium",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof fieldVariants> & { size?: FieldSize }) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation ?? "horizontal"}
      data-size={size}
      className={cn(fieldVariants({ orientation, className }))}
      {...props}
    />
  )
}

// Label/title type per Field size — the same sizes + tracking companions the
// controls use (§15: tracking is size-specific, never one value for all sizes).
const fieldLabelSize = cn(
  "text-[13px]",
  "group-data-[size=mini]/field:text-[10px] group-data-[size=mini]/field:[letter-spacing:var(--text-footnote-tracking)]",
  "group-data-[size=small]/field:text-[11px] group-data-[size=small]/field:[letter-spacing:var(--text-subheadline-tracking)]",
  "group-data-[size=large]/field:text-[15px]",
  "group-data-[size=xl]/field:text-[17px] group-data-[size=xl]/field:[letter-spacing:var(--text-title2-tracking)]"
)

function FieldLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"label"> & { asChild?: boolean }) {
  const Comp = asChild ? SlotPrimitive.Slot : "label"
  return (
    <Comp
      data-slot="field-label"
      className={cn(
        // SFPro-Medium 13 at the default size / foreground; mutes when the field
        // is disabled and tints destructive when the field is invalid.
        "flex select-none items-center gap-2 font-medium text-foreground",
        fieldLabelSize,
        "group-data-[disabled=true]/field:text-muted-foreground",
        "group-data-[invalid=true]/field:text-destructive",
        "has-[[disabled]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-title"
      className={cn(
        "flex items-center gap-2 font-medium text-foreground",
        fieldLabelSize,
        "group-data-[disabled=true]/field:text-muted-foreground",
        "group-data-[invalid=true]/field:text-destructive",
        className
      )}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        // The macOS "Subtitle": SFPro-Regular 11 / muted, ~2px below the label.
        // 11px carries the subheadline positive tracking companion (§15). It
        // steps up on the two big sizes so it stays a subtitle rather than
        // collapsing to a footnote next to a 15/17px label — always one step
        // below the label, never equal to it.
        "text-[11px] font-normal leading-snug [letter-spacing:var(--text-subheadline-tracking)] text-muted-foreground",
        "group-data-[size=large]/field:text-[12px] group-data-[size=xl]/field:text-[13px] group-data-[size=xl]/field:[letter-spacing:normal]",
        "group-data-[disabled=true]/field:opacity-60",
        className
      )}
      {...props}
    />
  )
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      // Groups a control with its title/description in a tight vertical stack
      // (gap ≈ 2px). Used inside horizontal rows and choice rows.
      className={cn("flex flex-1 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<"div"> & {
  errors?: Array<{ message?: string } | undefined>
}) {
  // Render nothing when there's no content to show.
  const list = errors?.filter((e) => e?.message)
  if (!children && (!list || list.length === 0)) return null

  let content: React.ReactNode = children
  if (!content && list) {
    content =
      list.length === 1 ? (
        list[0]?.message
      ) : (
        <ul className="ml-4 flex list-disc flex-col gap-0.5">
          {list.map((e, i) => (
            <li key={i}>{e?.message}</li>
          ))}
        </ul>
      )
  }

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn(
        // Same metrics as the description, recolored to the kit destructive red.
        "text-[11px] font-normal leading-snug [letter-spacing:var(--text-subheadline-tracking)] text-destructive",
        className
      )}
      {...props}
    >
      {content}
    </div>
  )
}

const fieldGroupVariants = cva("@container/field-group", {
  variants: {
    variant: {
      // rows (default) = macOS settings rows: each Field is its own row, the
      // label hugs the left of THAT row (column widths are per-field).
      rows: "flex flex-col gap-5",
      // aligned = the classic macOS dialog form: ONE shared label column across
      // all rows — labels right-aligned to the widest, so every control starts at
      // the same x and the inputs are equal width. Achieved with a 2-col grid
      // whose Fields become column subgrids, so col 1 (max-content) sizes to the
      // widest label across the whole group.
      aligned: cn(
        "grid grid-cols-[max-content_1fr] gap-x-4 gap-y-5",
        "[&>[data-slot=field]]:col-span-2 [&>[data-slot=field]]:grid [&>[data-slot=field]]:grid-cols-subgrid [&>[data-slot=field]]:items-center [&>[data-slot=field]]:gap-y-1",
        "[&_[data-slot=field-label]]:justify-self-end [&_[data-slot=field-label]]:text-right",
        "[&>[data-slot=field-separator]]:col-span-2"
      ),
    },
  },
  defaultVariants: { variant: "rows" },
})

function FieldGroup({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof fieldGroupVariants>) {
  return (
    <div
      data-slot="field-group"
      data-variant={variant ?? "rows"}
      // Stacks Field rows with the kit row rhythm (~21px) and opens a container
      // query context so `responsive` Fields can flip to horizontal.
      className={cn(fieldGroupVariants({ variant, className }))}
      {...props}
    />
  )
}

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  )
}

const fieldLegendVariants = cva("font-medium text-foreground", {
  variants: {
    variant: {
      legend: "text-[15px]",
      label: "text-[13px]",
    },
  },
  defaultVariants: { variant: "legend" },
})

function FieldLegend({
  className,
  variant,
  ...props
}: React.ComponentProps<"legend"> & VariantProps<typeof fieldLegendVariants>) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant ?? "legend"}
      className={cn(fieldLegendVariants({ variant, className }))}
      {...props}
    />
  )
}

function FieldSeparator({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-separator"
      role="separator"
      // 1px hairline using the exact kit separator var (rgba black/white 0.05).
      // -my-2.5 cancels one FieldGroup gap (gap-5/20px) so the separator sits
      // centered WITHIN the row rhythm (~21px, the kit value) instead of adding a
      // full extra gap on each side. Optional children render centered over the line.
      className={cn("relative -my-2.5 h-px bg-[var(--acr-field)]", className)}
      {...props}
    >
      {children && (
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--acr-panel)] px-2 text-[11px] [letter-spacing:var(--text-subheadline-tracking)] text-muted-foreground">
          {children}
        </span>
      )}
    </div>
  )
}

export {
  Field,
  FieldLabel,
  FieldTitle,
  FieldDescription,
  FieldError,
  FieldContent,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldSeparator,
  fieldVariants,
  fieldGroupVariants,
}
