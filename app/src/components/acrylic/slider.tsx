"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// Acrylic Slider — the macOS 26 "Sliders and Dials" page, aligned onto Radix Slider.
// Anatomy lifted verbatim from the Apple macOS 26 UI Kit (tokens/slider.json):
//   • Track (rail): a CAPSULE translucent rail — kit `Track - Unfilled` = black/white
//     6%. Wired to --acr-chip (the kit's translucent control fill) so it flips
//     light/dark for free. Height 4px (mini/small) / 6px (medium/large/xl).
//   • Range (filled): a CAPSULE accent fill — kit `Track - Filled` = #0088FF, which
//     IS --primary (dark #0091FF), so bg-primary matches the kit exactly.
//   • Thumb (knob): the kit's frosted-white rounded PILL (horizontal 16×12 … 24×20,
//     radius = height/2; swapped on the vertical axis). White (--acr-control) with a
//     hairline border + the kit's soft ambient shadow.
//
// The kit decomposes the slider into two orthogonal axes the wrapper exposes as props:
//   • `variant`  — fill origin. `standard` fills from the start (left/bottom); `center`
//     is the kit's *Center-biased* slider: the range fills from the track midpoint
//     toward the thumb, for bipolar values (pan/balance, EQ, −100…+100).
//   • `marks`    — the kit's *Ticked* add-on: small 2×2 capsule dots (foreground/25)
//     laid under the track. `true` derives marks from `step` (else 9 even dots), or
//     pass an explicit array of values.
// Both compose with the 5 control `size`s and either `orientation`. The kit's
// "Over-glass" material is intentionally NOT a separate variant — its tokens are
// identical to the standard set (it only signals placement over a glass surface).
//
// API stays shadcn-compatible (defaultValue/value/min/max/step/onValueChange) and
// supports horizontal + vertical orientation.

const sizeStyles = {
  // kit pill knob (horizontal w×h) + track height (4px mini/small · 6px md/lg/xl)
  mini: { track: 4, w: 16, h: 12 },
  small: { track: 4, w: 18, h: 14 },
  medium: { track: 6, w: 20, h: 16 },
  large: { track: 6, w: 24, h: 20 },
  xl: { track: 6, w: 24, h: 20 },
} as const

type SliderSize = keyof typeof sizeStyles
type SliderVariant = "standard" | "center"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  step = 1,
  size = "medium",
  variant = "standard",
  marks = false,
  orientation = "horizontal",
  onValueChange,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  size?: SliderSize
  variant?: SliderVariant
  /** Kit "Ticked" add-on: `true` (derive from step, else 9 dots) or explicit values. */
  marks?: boolean | number[]
}) {
  const { track, w, h } = sizeStyles[size]
  const isVertical = orientation === "vertical"
  // pill knob: long axis runs perpendicular to the track, so swap on vertical
  const thumbW = isVertical ? h : w
  const thumbH = isVertical ? w : h

  // Mirror the value so center-fill + marks can read the live position even when
  // the slider is uncontrolled. Controlled `value` always wins.
  const [internal, setInternal] = React.useState<number[]>(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min])
  )
  const values = Array.isArray(value) ? value : internal
  const thumbCount = values.length

  const handleChange = React.useCallback(
    (next: number[]) => {
      setInternal(next)
      onValueChange?.(next)
    },
    [onValueChange]
  )

  const pct = (v: number) => ((v - min) / (max - min)) * 100

  // Center-biased single-thumb fill: a span from the midpoint (50%) to the thumb.
  // Range (two-thumb) keeps Radix's between-thumbs fill for both variants.
  const isCenterFill = variant === "center" && thumbCount === 1
  const centerStyle = (() => {
    const p = pct(values[0])
    const start = Math.min(p, 50)
    const len = Math.abs(p - 50)
    return isVertical
      ? { bottom: `${start}%`, height: `${len}%` }
      : { left: `${start}%`, width: `${len}%` }
  })()

  // Tick marks (kit "Ticked"): explicit values, or derived from step (capped), else 9.
  const markValues: number[] = React.useMemo(() => {
    if (Array.isArray(marks)) return marks
    if (!marks) return []
    const span = max - min
    if (step > 0) {
      const n = Math.round(span / step)
      if (n >= 1 && n <= 40) return Array.from({ length: n + 1 }, (_, i) => min + i * step)
    }
    return Array.from({ length: 9 }, (_, i) => min + (i * span) / 8)
  }, [marks, min, max, step])

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      data-size={size}
      data-variant={variant}
      defaultValue={Array.isArray(value) ? undefined : defaultValue}
      value={Array.isArray(value) ? value : undefined}
      min={min}
      max={max}
      step={step}
      orientation={orientation}
      onValueChange={handleChange}
      className={cn(
        "relative flex w-full touch-none select-none items-center",
        "data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        marks && !isVertical && "mb-3.5",
        marks && isVertical && "mr-3.5",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        style={{ "--slider-track": `${track}px` } as React.CSSProperties}
        className={cn(
          // capsule translucent rail (kit Track - Unfilled, black/white 6%)
          "relative grow overflow-hidden rounded-full bg-[var(--acr-chip)]",
          "data-[orientation=horizontal]:h-[var(--slider-track)] data-[orientation=horizontal]:w-full",
          "data-[orientation=vertical]:w-[var(--slider-track)] data-[orientation=vertical]:h-full"
        )}
      >
        {isCenterFill ? (
          // center-biased fill: accent span from the track midpoint to the thumb
          <div
            data-slot="slider-range"
            data-variant="center"
            style={centerStyle}
            className={cn(
              "absolute rounded-full bg-primary",
              isVertical ? "inset-x-0 w-full" : "inset-y-0 h-full"
            )}
          />
        ) : (
          <SliderPrimitive.Range
            data-slot="slider-range"
            className={cn(
              // capsule accent range (kit Track - Filled = #0088FF == --primary)
              "absolute rounded-full bg-primary",
              "data-[orientation=horizontal]:h-full",
              "data-[orientation=vertical]:w-full"
            )}
          />
        )}
      </SliderPrimitive.Track>

      {Array.from({ length: thumbCount }, (_, i) => (
        // Zero-footprint anchor. Radix normally insets the thumb by half its own
        // width to keep it inside the track — which slides the thumb CENTER off
        // the filled Range's leading edge (the "progress point") and off the tick
        // marks by up to that half width, worst at the ends and visible straight
        // through the frosted knob. Measuring 0×0 makes Radix skip that inset, so
        // the knob's center lands exactly on the progress point / mark at every
        // value. (It may overhang the capsule caps at 0/100% — correct: the caps
        // ARE those values.) The visible pill is an absolutely-centered child.
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={i}
          style={
            {
              "--slider-thumb-w": `${thumbW}px`,
              "--slider-thumb-h": `${thumbH}px`,
            } as React.CSSProperties
          }
          className="group/thumb relative block size-0 shrink-0 outline-none"
        >
          <span
            aria-hidden
            className={cn(
              // frosted-white pill knob: hairline border + soft ambient shadow,
              // centered on the zero-size anchor so its middle marks the value
              "absolute left-1/2 top-1/2 block h-[var(--slider-thumb-h)] w-[var(--slider-thumb-w)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--acr-control)]",
              "border border-[var(--acr-control-border)]",
              "shadow-[0_1px_3px_rgba(0,0,0,0.18),0_4px_10px_rgba(0,0,0,0.12)]",
              "transition-[box-shadow,transform]",
              "group-hover/thumb:shadow-[0_1px_3px_rgba(0,0,0,0.22),0_6px_14px_rgba(0,0,0,0.16)]",
              "group-focus-visible/thumb:ring-4 group-focus-visible/thumb:ring-ring/25",
              "group-active/thumb:scale-95"
            )}
          />
        </SliderPrimitive.Thumb>
      ))}

      {markValues.length > 0 && (
        <div
          data-slot="slider-marks"
          aria-hidden
          className={cn(
            "pointer-events-none absolute",
            isVertical ? "inset-y-0 left-full ml-2 w-[2px]" : "inset-x-0 top-full mt-2 h-[2px]"
          )}
        >
          {markValues.map((v, i) => {
            const p = pct(v)
            return (
              <span
                key={i}
                style={
                  isVertical
                    ? { bottom: `${p}%`, transform: "translateY(50%)" }
                    : { left: `${p}%`, transform: "translateX(-50%)" }
                }
                className="absolute size-[2px] rounded-full bg-foreground/25"
              />
            )
          })}
        </div>
      )}
    </SliderPrimitive.Root>
  )
}

export { Slider }

