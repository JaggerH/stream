"use client"

import * as React from "react"
import { Slot as SlotPrimitive } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Acrylic Button Group — modeled on the Apple macOS 26 UI Kit "Segmented Controls"
// page. The kit's grouped-control anatomy maps to three composition variants:
//
//  • attached  (default) — action buttons sharing ONE rounded gray "well"
//    (--acr-field, the kit's rgba(0,0,0,0.05) track), flush, separated by
//    `ButtonGroupSeparator` hairlines. The children's outer corners are rounded
//    to the inner (well − padding) radius and inner corners collapsed to square,
//    exactly like the macOS −/value/+ and indent toolbar groups.
//  • segmented — a selectable control: the same gray well, but the ACTIVE item is
//    a RAISED rounded pill (--acr-button-group-control) with a soft shadow floating
//    over the well. macOS SLIDES that pill to the newly-selected segment, so the
//    preferred API is CONTROLLED: pass `value`/`defaultValue`/`onValueChange` on
//    `ButtonGroup` and `ButtonGroupItem` children keyed by `value`. The pill is a
//    single absolutely-positioned indicator that transitions across equal-width
//    segments. For uncontrolled use, the `data-active`/`aria-pressed` styling on
//    plain children still paints the pill (no slide).
//  • ghost — the attached layout without the shared well. Use when the surrounding
//    surface already provides the chrome but the group still needs dividers.
//  • split — separate buttons with a small gap (no shared well), still grouped
//    semantically (role="group"). For sub-groups sitting side by side.
//
// Geometry is lifted from the kit: a uniform 2px well inset (p-0.5) so the white
// pill / flush items sit evenly inset on all four sides; the inner radius is the
// well radius (6) minus the 2px inset = 4, keeping pill and well corners
// concentric. Every color resolves through the acrylic theme vars so the whole
// group flips light/dark for free.

// ── Size scale ────────────────────────────────────────────────────────────────
// The kit's Segmented Controls ship five sizes (1 Mn … 5 XL), the same scale as
// Button/Select: height 16/20/24/28/36, well radius 4/5/6/14/18 (the pill/segment
// radius = well − the uniform 2px inset), font 10/11/13/13/13. Set `size` ONCE on
// <ButtonGroup>; it flows through context to the well, segments, pill and dividers.
type ButtonGroupSize = "mini" | "small" | "medium" | "large" | "xl"
type ButtonGroupShape = "auto" | "rect" | "capsule"

const SIZE: Record<
  ButtonGroupSize,
  {
    well: string
    item: string
    divider: string
    text: string
  }
> = {
  mini: {
    well: "p-0.5",
    item: "h-4 gap-1 px-2 text-[10px] [&_svg]:size-3",
    divider: "inset-y-0.5",
    text: "h-4 px-2 text-[10px]",
  },
  small: {
    well: "p-0.5",
    item: "h-5 gap-1 px-2.5 text-[11px] [&_svg]:size-3",
    divider: "inset-y-0.5",
    text: "h-5 px-2.5 text-[11px]",
  },
  medium: {
    well: "p-0.5",
    item: "h-6 gap-1.5 px-4 text-[13px] [&_svg]:size-3.5",
    divider: "inset-y-1",
    text: "h-6 px-3 text-[13px]",
  },
  // large/xl: the kit radius (14 / 18) equals half the segment height (28 / 36),
  // i.e. a FULL capsule — so the well and pill are rounded-full (concentric capsules
  // across the 2px inset), not a 12 / 16px not-quite-round rect.
  large: {
    well: "p-0.5",
    item: "h-7 gap-1.5 px-4 text-[13px] [&_svg]:size-4",
    divider: "inset-y-1.5",
    text: "h-7 px-3.5 text-[13px]",
  },
  xl: {
    well: "p-0.5",
    item: "h-9 gap-2 px-5 text-[13px] [&_svg]:size-4",
    divider: "inset-y-2",
    text: "h-9 px-4 text-[13px]",
  },
}

const SHAPE: Record<
  ButtonGroupShape,
  Record<
    ButtonGroupSize,
    {
      well: string
      childrenL: string
      childrenR: string
      childrenAll: string
      pill: string
      item: string
    }
  >
> = {
  auto: {
    mini: {
      well: "rounded-[4px]",
      childrenL: "[&>*:first-child]:rounded-l-[2px]",
      childrenR: "[&>*:last-child]:rounded-r-[2px]",
      childrenAll: "[&>*]:rounded-[2px]",
      pill: "rounded-[2px]",
      item: "rounded-[2px]",
    },
    small: {
      well: "rounded-[5px]",
      childrenL: "[&>*:first-child]:rounded-l-[3px]",
      childrenR: "[&>*:last-child]:rounded-r-[3px]",
      childrenAll: "[&>*]:rounded-[3px]",
      pill: "rounded-[3px]",
      item: "rounded-[3px]",
    },
    medium: {
      well: "rounded-[6px]",
      childrenL: "[&>*:first-child]:rounded-l-[4px]",
      childrenR: "[&>*:last-child]:rounded-r-[4px]",
      childrenAll: "[&>*]:rounded-[4px]",
      pill: "rounded-[4px]",
      item: "rounded-[4px]",
    },
    large: {
      well: "rounded-full",
      childrenL: "[&>*:first-child]:rounded-l-full",
      childrenR: "[&>*:last-child]:rounded-r-full",
      childrenAll: "[&>*]:rounded-full",
      pill: "rounded-full",
      item: "rounded-full",
    },
    xl: {
      well: "rounded-full",
      childrenL: "[&>*:first-child]:rounded-l-full",
      childrenR: "[&>*:last-child]:rounded-r-full",
      childrenAll: "[&>*]:rounded-full",
      pill: "rounded-full",
      item: "rounded-full",
    },
  },
  rect: {
    mini: {
      well: "rounded-[4px]",
      childrenL: "[&>*:first-child]:rounded-l-[2px]",
      childrenR: "[&>*:last-child]:rounded-r-[2px]",
      childrenAll: "[&>*]:rounded-[2px]",
      pill: "rounded-[2px]",
      item: "rounded-[2px]",
    },
    small: {
      well: "rounded-[5px]",
      childrenL: "[&>*:first-child]:rounded-l-[3px]",
      childrenR: "[&>*:last-child]:rounded-r-[3px]",
      childrenAll: "[&>*]:rounded-[3px]",
      pill: "rounded-[3px]",
      item: "rounded-[3px]",
    },
    medium: {
      well: "rounded-[6px]",
      childrenL: "[&>*:first-child]:rounded-l-[4px]",
      childrenR: "[&>*:last-child]:rounded-r-[4px]",
      childrenAll: "[&>*]:rounded-[4px]",
      pill: "rounded-[4px]",
      item: "rounded-[4px]",
    },
    large: {
      well: "rounded-[8px]",
      childrenL: "[&>*:first-child]:rounded-l-[6px]",
      childrenR: "[&>*:last-child]:rounded-r-[6px]",
      childrenAll: "[&>*]:rounded-[6px]",
      pill: "rounded-[6px]",
      item: "rounded-[6px]",
    },
    xl: {
      well: "rounded-[10px]",
      childrenL: "[&>*:first-child]:rounded-l-[8px]",
      childrenR: "[&>*:last-child]:rounded-r-[8px]",
      childrenAll: "[&>*]:rounded-[8px]",
      pill: "rounded-[8px]",
      item: "rounded-[8px]",
    },
  },
  capsule: {
    mini: {
      well: "rounded-full",
      childrenL: "[&>*:first-child]:rounded-l-full",
      childrenR: "[&>*:last-child]:rounded-r-full",
      childrenAll: "[&>*]:rounded-full",
      pill: "rounded-full",
      item: "rounded-full",
    },
    small: {
      well: "rounded-full",
      childrenL: "[&>*:first-child]:rounded-l-full",
      childrenR: "[&>*:last-child]:rounded-r-full",
      childrenAll: "[&>*]:rounded-full",
      pill: "rounded-full",
      item: "rounded-full",
    },
    medium: {
      well: "rounded-full",
      childrenL: "[&>*:first-child]:rounded-l-full",
      childrenR: "[&>*:last-child]:rounded-r-full",
      childrenAll: "[&>*]:rounded-full",
      pill: "rounded-full",
      item: "rounded-full",
    },
    large: {
      well: "rounded-full",
      childrenL: "[&>*:first-child]:rounded-l-full",
      childrenR: "[&>*:last-child]:rounded-r-full",
      childrenAll: "[&>*]:rounded-full",
      pill: "rounded-full",
      item: "rounded-full",
    },
    xl: {
      well: "rounded-full",
      childrenL: "[&>*:first-child]:rounded-l-full",
      childrenR: "[&>*:last-child]:rounded-r-full",
      childrenAll: "[&>*]:rounded-full",
      pill: "rounded-full",
      item: "rounded-full",
    },
  },
}

const ButtonGroupSizeContext = React.createContext<ButtonGroupSize>("medium")
const ButtonGroupShapeContext = React.createContext<ButtonGroupShape>("auto")
const useButtonGroupSize = () => React.useContext(ButtonGroupSizeContext)
const useButtonGroupShape = () => React.useContext(ButtonGroupShapeContext)
const shapeClasses = (shape: ButtonGroupShape, size: ButtonGroupSize) =>
  SHAPE[shape][size]

// The well structure per variant — fill, inset behaviour, child-fill stripping. The
// radius/inset come from SIZE (applied at render), so the cva no longer hard-codes
// the medium-only radii.
const buttonGroupVariants = cva(
  "inline-flex isolate text-foreground",
  {
    variants: {
      variant: {
        // One shared gray well; uniform 2px inset; children flush with collapsed
        // inner radii and outer corners rounded to the inner (6 − 2) radius.
        attached: cn(
          "items-stretch bg-[var(--acr-field)]",
          // Items sit FLAT on the shared well: strip any per-button fill/shadow so
          // the single gray surface (and the hairline separators between items) show
          // through instead of a second gray slab stacked on top; foreground text +
          // a faint hover give press feedback. The attribute selector here is (0,2,0)
          // — it outweighs the Button variant's own single-class bg/text, so this
          // wins regardless of which variant the caller passes.
          "[&>[data-slot=button]]:bg-transparent [&>[data-slot=button]]:text-foreground [&>[data-slot=button]]:shadow-none",
          "[&>[data-slot=button]:hover]:bg-[var(--acr-hover)]",
          // inner corners go square so adjacent children read as one continuous
          // capsule; the outer corners (SIZE.childrenL/R) follow the well radius.
          "[&>*]:rounded-none"
        ),
        // Selectable segmented control: gray well + active item = white raised pill.
        // Uniform 2px inset; pill radius 4 (= 6 − 2) stays concentric with the well.
        // This styling is the UNCONTROLLED fallback (instant swap, no slide). When
        // controlled via value/ButtonGroupItem the sliding indicator is rendered
        // instead (see ButtonGroup below).
        segmented: cn(
          "items-stretch gap-px bg-[var(--acr-field)]",
          "[&>*]:shadow-none [&>*]:bg-transparent",
          // the active item (data-active or aria-pressed) becomes the white pill.
          "[&>[data-active=true]]:bg-[var(--acr-control)] [&>[aria-pressed=true]]:bg-[var(--acr-control)]",
          "[&>[data-active=true]]:shadow-[0_1px_2px_rgba(0,0,0,0.16),0_0_0_0.5px_rgba(0,0,0,0.04)]",
          "[&>[aria-pressed=true]]:shadow-[0_1px_2px_rgba(0,0,0,0.16),0_0_0_0.5px_rgba(0,0,0,0.04)]"
        ),
        // Same flush geometry as attached, but no shared well fill. The surrounding
        // surface carries the chrome; this group only supplies grouping, hover, and
        // visible dividers.
        ghost: cn(
          "items-stretch bg-transparent",
          "[&>[data-slot=button]]:bg-transparent [&>[data-slot=button]]:text-foreground [&>[data-slot=button]]:shadow-none",
          "[&>[data-slot=button]:hover]:bg-[var(--acr-hover)]",
          "[&>*]:rounded-none"
        ),
        // Separate buttons, small gap, no shared surface.
        split: "items-center gap-1.5",
      },
    },
    defaultVariants: { variant: "attached" },
  }
)

// ── Controlled segmented context ──────────────────────────────────────────────
// Shared by the sliding-pill ButtonGroup and its ButtonGroupItem children so each
// item knows its own selected state and can report clicks back to the group.
type SegmentedContextValue = {
  value: string | undefined
  setValue: (value: string) => void
}

const SegmentedContext = React.createContext<SegmentedContextValue | null>(null)

// ── Multi-select (toggle) context ─────────────────────────────────────────────
// For `type="multiple"`: a set of selected values + a toggle callback. Each
// ButtonGroupToggle child reads its own on/off state and flips it on click. This
// is the macOS "select any" mode — selected items tint to the accent, multiple at
// once, no sliding pill (unlike the single-select segmented radio).
type MultiSelectContextValue = {
  value: string[]
  toggle: (value: string) => void
}

const MultiSelectContext = React.createContext<MultiSelectContextValue | null>(
  null
)

type ButtonGroupBaseProps = Omit<
  React.ComponentProps<"div">,
  "defaultValue" | "onChange"
> &
  VariantProps<typeof buttonGroupVariants> & {
    /** One of the five kit sizes — scales the well, segments, pill and dividers. */
    size?: ButtonGroupSize
    /** Corner geometry. `auto` follows the kit; `rect` keeps large toolbars square-ish. */
    shape?: ButtonGroupShape
  }

// Well radius/inset for the uncontrolled (non-sliding) paths. `split` has no shared
// well, so no radius/inset; attached/multi round their outer children; segmented
// (uncontrolled fallback) rounds every child.
function wellClasses(
  variant: "attached" | "segmented" | "ghost" | "split",
  size: ButtonGroupSize,
  shape: ButtonGroupShape
) {
  const s = SIZE[size]
  const g = shapeClasses(shape, size)
  if (variant === "split") return ""
  if (variant === "segmented") return cn(s.well, g.well, g.childrenAll)
  return cn(s.well, g.well, g.childrenAll, g.childrenL, g.childrenR)
}

// Single-select (default): segmented radio with the sliding white pill.
type ButtonGroupSingleProps = ButtonGroupBaseProps & {
  type?: "single"
  /** Controlled selected value (segmented variant). */
  value?: string
  /** Uncontrolled initial value (segmented variant). */
  defaultValue?: string
  /** Fires with the new value when a segment is selected. */
  onValueChange?: (value: string) => void
}

// Multi-select: a toggle group (shadcn-style array API) — selected items tint to
// the accent and several can be on at once. Children are `ButtonGroupToggle`.
type ButtonGroupMultipleProps = ButtonGroupBaseProps & {
  type: "multiple"
  /** Controlled set of selected values. */
  value?: string[]
  /** Uncontrolled initial set of selected values. */
  defaultValue?: string[]
  /** Fires with the new set whenever a toggle flips. */
  onValueChange?: (value: string[]) => void
}

type ButtonGroupProps = ButtonGroupSingleProps | ButtonGroupMultipleProps

function ButtonGroup(props: ButtonGroupProps) {
  // Multi-select toggle group (type="multiple").
  if (props.type === "multiple") {
    const { className, size, shape, value, defaultValue, onValueChange, children, ...rest } =
      props
    return (
      <MultiToggleGroup
        className={className}
        size={size}
        shape={shape}
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        {...rest}
      >
        {children}
      </MultiToggleGroup>
    )
  }

  const {
    className,
    variant,
    size = "medium",
    shape = "auto",
    value,
    defaultValue,
    onValueChange,
    children,
    type: _type,
    ...rest
  } = props

  // The sliding pill only applies to the segmented variant when used as a
  // value-driven control (any of value/defaultValue/onValueChange supplied).
  const isControlledSegmented =
    variant === "segmented" &&
    (value !== undefined ||
      defaultValue !== undefined ||
      onValueChange !== undefined)

  if (isControlledSegmented) {
    return (
      <SegmentedSlider
        className={className}
        size={size}
        shape={shape}
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        {...rest}
      >
        {children}
      </SegmentedSlider>
    )
  }

  return (
    <ButtonGroupSizeContext.Provider value={size}>
      <ButtonGroupShapeContext.Provider value={shape}>
        <div
          role="group"
          data-slot="button-group"
          data-variant={variant ?? "attached"}
          data-size={size}
          data-shape={shape}
          className={cn(
            buttonGroupVariants({ variant }),
            wellClasses(variant ?? "attached", size, shape),
            className
          )}
          {...rest}
        >
          {children}
        </div>
      </ButtonGroupShapeContext.Provider>
    </ButtonGroupSizeContext.Provider>
  )
}

// The macOS multi-select toggle group: an attached gray well with always-visible
// hairline separators; each ButtonGroupToggle child tints to the accent when on.
// Controlled via value/defaultValue/onValueChange (an array, shadcn-style).
function MultiToggleGroup({
  className,
  size = "medium",
  shape = "auto",
  value: valueProp,
  defaultValue,
  onValueChange,
  children,
  ...props
}: Omit<ButtonGroupMultipleProps, "type">) {
  const s = SIZE[size]
  const g = shapeClasses(shape, size)
  const [uncontrolled, setUncontrolled] = React.useState<string[]>(
    defaultValue ?? []
  )
  const isControlled = valueProp !== undefined
  const value = isControlled ? valueProp! : uncontrolled

  const toggle = React.useCallback(
    (next: string) => {
      const set = value.includes(next)
        ? value.filter((v) => v !== next)
        : [...value, next]
      if (!isControlled) setUncontrolled(set)
      onValueChange?.(set)
    },
    [value, isControlled, onValueChange]
  )

  return (
    <div
      role="group"
      data-slot="button-group"
      data-variant="multiple"
      data-size={size}
      data-shape={shape}
      className={cn(
        // Same shared gray well as the attached variant; flush items with the outer
        // corners rounded to the well's inner radius (well − 2px inset), per size.
        "inline-flex isolate items-stretch bg-[var(--acr-field)] text-foreground",
        "[&>*]:rounded-none",
        s.well,
        g.well,
        g.childrenAll,
        g.childrenL,
        g.childrenR,
        className
      )}
      {...props}
    >
      <ButtonGroupSizeContext.Provider value={size}>
        <ButtonGroupShapeContext.Provider value={shape}>
          <MultiSelectContext.Provider value={{ value, toggle }}>
            {children}
          </MultiSelectContext.Provider>
        </ButtonGroupShapeContext.Provider>
      </ButtonGroupSizeContext.Provider>
    </div>
  )
}

// The macOS sliding segmented control. Equal-width segments (each flex-1) make the
// slide pure CSS: the indicator's width is 100/N% and it is translated by
// index × 100%. We transition `transform`/`width` with a macOS easing and disable
// it under prefers-reduced-motion. role="radiogroup" + arrow-key navigation.
function SegmentedSlider({
  className,
  size = "medium",
  shape = "auto",
  value: valueProp,
  defaultValue,
  onValueChange,
  children,
  ...props
}: Omit<ButtonGroupSingleProps, "type" | "variant">) {
  const s = SIZE[size]
  const g = shapeClasses(shape, size)
  const items = React.useMemo(
    () =>
      React.Children.toArray(children).filter(
        (child): child is React.ReactElement<ButtonGroupItemProps> =>
          React.isValidElement(child) &&
          (child.type as { __isButtonGroupItem?: boolean })
            ?.__isButtonGroupItem === true
      ),
    [children]
  )
  const values = items.map((item) => item.props.value)

  const [uncontrolled, setUncontrolled] = React.useState<string | undefined>(
    defaultValue ?? values[0]
  )
  const isControlled = valueProp !== undefined
  const value = isControlled ? valueProp : uncontrolled

  const setValue = React.useCallback(
    (next: string) => {
      if (!isControlled) setUncontrolled(next)
      onValueChange?.(next)
    },
    [isControlled, onValueChange]
  )

  const activeIndex = Math.max(0, values.indexOf(value as string))
  const count = items.length || 1

  // Keyboard: arrows move selection between segments (radiogroup semantics).
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault()
      const delta = event.key === "ArrowRight" ? 1 : -1
      const target = (activeIndex + delta + count) % count
      setValue(values[target] as string)
    }
  }

  // Indicator size/offset as a fraction of the INNER TRACK (the content box inside
  // the well's 2px padding). Because the indicator and the equal-width grid columns
  // share the same un-padded positioning context, width = 100/N% and translate =
  // index×100% line up exactly — no measurement, and the pill never overruns.
  const indicatorStyle: React.CSSProperties = {
    width: `${100 / count}%`,
    transform: `translateX(${activeIndex * 100}%)`,
  }

  return (
    <div
      role="radiogroup"
      data-slot="button-group"
      data-variant="segmented"
      data-size={size}
      data-shape={shape}
      onKeyDown={onKeyDown}
      className={cn(
        // The well: gray track with a uniform 2px inset on all four sides (radius
        // per size).
        "inline-flex isolate bg-[var(--acr-field)] text-foreground",
        s.well,
        g.well,
        className
      )}
      {...props}
    >
      {/* Inner track = the content box (no padding). A grid of EQUAL tracks, not a
          flex row: in a shrink-to-fit container flex-1 can't equalize (each segment
          would collapse to its own text width, so "Week" ≠ "Month" and the pill /
          dividers drift). `repeat(N, minmax(0,1fr))` resolves every track to the
          WIDEST segment's width (the macOS equal-width segmented look), so the pill's
          100/N% and the boundary dividers land exactly on the column edges. The pill
          and dividers are absolutely positioned, so they sit outside the grid flow. */}
      <div
        data-slot="button-group-track"
        className="relative isolate grid flex-1"
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      >
        {/* The single white pill. Pinned flush to the inner track (inset-0 ⇒ 2px
            from the well edge top/bottom/left/right) and slid via transform. */}
        <div
          aria-hidden
          data-slot="button-group-indicator"
          className={cn(
            "pointer-events-none absolute left-0 top-0 z-0 h-full bg-[var(--acr-button-group-control)]",
            g.pill,
            "shadow-[0_1px_2px_rgba(0,0,0,0.35)]",
            "transition-[transform,width] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
            "motion-reduce:transition-none"
          )}
          style={indicatorStyle}
        />
        {/* Built-in hairline dividers between every pair of segments (the macOS
            default). Absolutely positioned at each boundary so they don't eat into
            the segment width — the pill's 100/N% math stays exact. The two dividers
            touching the active segment fade out, since the white pill's rounded
            edges stand in for them; they fade back as the pill slides away. */}
        {count > 1 &&
          Array.from({ length: count - 1 }, (_, i) => {
            const boundary = i + 1 // sits between segment (boundary-1) and boundary
            const hidden =
              activeIndex === boundary - 1 || activeIndex === boundary
            const pos = `${(boundary / count) * 100}%`
            return (
              <span
                key={i}
                aria-hidden
                data-slot="button-group-divider"
                className={cn(
                  "pointer-events-none absolute z-[1] w-px -translate-x-1/2 bg-[var(--acr-button-group-divider)]",
                  s.divider,
                  "transition-opacity duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
                  hidden && "opacity-0"
                )}
                style={{ left: pos }}
              />
            )
          })}
        <ButtonGroupSizeContext.Provider value={size}>
          <ButtonGroupShapeContext.Provider value={shape}>
            <SegmentedContext.Provider value={{ value, setValue }}>
              {children}
            </SegmentedContext.Provider>
          </ButtonGroupShapeContext.Provider>
        </ButtonGroupSizeContext.Provider>
      </div>
    </div>
  )
}

type ButtonGroupItemProps = React.ComponentProps<"button"> & {
  /** The value this segment selects; matched against ButtonGroup's value. */
  value: string
  asChild?: boolean
}

// A segment in the controlled sliding segmented control. Equal-width (flex-1),
// transparent (the white pill behind it shows selection), role="radio". Use these
// as ButtonGroup children when you pass value/onValueChange.
function ButtonGroupItem({
  className,
  value,
  asChild = false,
  onClick,
  ...props
}: ButtonGroupItemProps) {
  const ctx = React.useContext(SegmentedContext)
  const size = useButtonGroupSize()
  const shape = useButtonGroupShape()
  const selected = ctx?.value === value
  const Comp = asChild ? SlotPrimitive.Slot : "button"
  return (
    <Comp
      type={asChild ? undefined : "button"}
      role="radio"
      aria-checked={selected}
      data-slot="button-group-item"
      data-active={selected}
      // The active segment is keyboard-reachable; the rest stay out of tab order
      // (arrow keys move between them — standard radiogroup behavior).
      tabIndex={selected ? 0 : -1}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        ctx?.setValue(value)
        onClick?.(event)
      }}
      className={cn(
        "relative z-10 inline-flex flex-1 select-none items-center justify-center whitespace-nowrap",
        SIZE[size].item,
        shapeClasses(shape, size).item,
        "font-medium outline-none transition-colors",
        "bg-transparent text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        // Disabled: clearly dimmed + inert, so an unavailable segment reads as
        // unavailable next to its live neighbours.
        "disabled:pointer-events-none disabled:opacity-40",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}
// Tag the component so SegmentedSlider can distinguish real segments from other
// children (separators, stray nodes) when measuring count / values.
;(ButtonGroupItem as unknown as { __isButtonGroupItem: boolean }).__isButtonGroupItem =
  true

type ButtonGroupToggleProps = React.ComponentProps<"button"> & {
  /** The value this toggle contributes to the group's selected set. */
  value: string
  asChild?: boolean
}

// A toggle in the multi-select group (ButtonGroup type="multiple"). A flat button
// that sits on the shared well; when on it tints to the accent (text-primary) —
// the macOS "select any" look (e.g. a B/I/U/S formatting toolbar). aria-pressed
// carries the on/off state. Place `ButtonGroupSeparator`s between toggles for the
// always-visible hairlines.
function ButtonGroupToggle({
  className,
  value,
  asChild = false,
  onClick,
  ...props
}: ButtonGroupToggleProps) {
  const ctx = React.useContext(MultiSelectContext)
  const size = useButtonGroupSize()
  const shape = useButtonGroupShape()
  const on = ctx?.value.includes(value) ?? false
  const Comp = asChild ? SlotPrimitive.Slot : "button"
  return (
    <Comp
      type={asChild ? undefined : "button"}
      aria-pressed={on}
      data-slot="button-group-toggle"
      data-state={on ? "on" : "off"}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        ctx?.toggle(value)
        onClick?.(event)
      }}
      className={cn(
        "relative z-10 inline-flex flex-1 select-none items-center justify-center whitespace-nowrap",
        SIZE[size].item,
        shapeClasses(shape, size).item,
        "font-medium outline-none transition-colors",
        // Flat on the well; ON tints the label/glyph to the accent (no fill — the
        // color change is the selection hint), with a faint neutral hover.
        "bg-transparent text-foreground hover:bg-[var(--acr-hover)]",
        "data-[state=on]:text-primary data-[state=on]:font-semibold",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

// Hairline divider between flush items (attached variant). Lifted from the kit's
// 1px Separator inset ~5px top/bottom on the track — here a thin self-stretching
// rule in --acr-button-group-divider that flips orientation with the group.
function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical"
}) {
  const size = useButtonGroupSize()
  // Literal class maps (no string interpolation — Tailwind's scanner needs whole
  // class names to generate the utilities).
  const vert = { mini: "my-0.5 w-px", small: "my-0.5 w-px", medium: "my-1 w-px", large: "my-1.5 w-px", xl: "my-2 w-px" }
  const horiz = { mini: "mx-0.5 h-px", small: "mx-0.5 h-px", medium: "mx-1 h-px", large: "mx-1.5 h-px", xl: "mx-2 h-px" }
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      data-slot="button-group-separator"
      className={cn(
        "shrink-0 self-stretch bg-[var(--acr-button-group-divider)]",
        orientation === "vertical" ? vert[size] : horiz[size],
        className
      )}
      {...props}
    />
  )
}

// Non-interactive text / label slot inside the group (e.g. the value readout in a
// −/value/+ stepper, or a leading label). Matches the segment typography.
function ButtonGroupText({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? SlotPrimitive.Slot : "div"
  const size = useButtonGroupSize()
  return (
    <Comp
      data-slot="button-group-text"
      className={cn(
        // leading-none pins the text line box so an inherited (e.g. prose)
        // line-height can't inflate this auto-height slot past the fixed-height
        // buttons — which under items-stretch would top-align them and leave a gap.
        "inline-flex items-center justify-center whitespace-nowrap leading-none font-medium text-foreground select-none",
        SIZE[size].text,
        className
      )}
      {...props}
    />
  )
}

export {
  ButtonGroup,
  ButtonGroupItem,
  ButtonGroupToggle,
  ButtonGroupSeparator,
  ButtonGroupText,
  buttonGroupVariants,
}

