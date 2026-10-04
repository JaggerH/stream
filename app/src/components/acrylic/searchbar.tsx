import * as React from "react"
import { Search, X } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const searchbarVariants = cva(
  cn(
    "relative flex items-center w-full min-w-0 rounded-full outline-none",
    // Motion on the shared spring token (matches button/card/badge), not shadcn's
    // flat 0.15s ease. Name the visual props only — never `all`, which would also
    // animate layout. Covers hover border, focus ring (box-shadow), over-glass hover.
    "transition-[background-color,border-color,box-shadow] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)]",
    "text-foreground selection:bg-primary selection:text-primary-foreground",
    "disabled:cursor-not-allowed disabled:opacity-50"
  ),
  {
    variants: {
      variant: {
        default: "border border-[var(--acr-input-border)] bg-[var(--acr-input)] hover:border-[var(--acr-border)] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
        // Token-based, not `dark:`-hardcoded: acrylic is its own `.acrylic` class (NOT
        // `.dark`), so a `dark:` tint never fires under it and the field falls back to
        // the light-theme black/5 — invisible on dark glass. --acr-chip resolves to the
        // right floating tint in every theme (light black/6, dark white/8, acrylic white/10).
        "over-glass": "bg-[var(--acr-chip)] hover:bg-[var(--acr-chip-hover)] border border-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
      },
      size: {
        // Type scales WITH the control (Apple §15): text carries its size-specific
        // tracking companion — small type drifts too tight → positive tracking; body/
        // title3 (13/15px) sit at 0; the 17px xl gets a slight negative like a title.
        // Only the non-zero companions need an explicit letter-spacing. large/xl step
        // the font up (was capped at 13px, which left the icon out-scaling the text in
        // the taller pills) so the text keeps command of the field.
        mini: "h-4 pl-5 pr-4 text-[10px] [letter-spacing:var(--text-footnote-tracking)]",
        small: "h-5 pl-6 pr-5 text-[11px] [letter-spacing:var(--text-subheadline-tracking)]",
        medium: "h-6 pl-7 pr-6 text-[13px]",
        large: "h-7 pl-8 pr-6 text-[15px]",
        xl: "h-9 pl-9 pr-8 text-[17px] [letter-spacing:var(--text-title2-tracking)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "medium",
    },
  }
)

export interface SearchbarProps
  extends Omit<React.ComponentProps<"input">, "size">,
    VariantProps<typeof searchbarVariants> {
  onClear?: () => void
  /** Optional trailing keyboard-shortcut hint (e.g. "⌘K"), rendered as a keycap
   *  while the field is empty and hidden once the clear button appears. Purely
   *  visual + pointer-events-none — bind the actual hotkey yourself (or let the
   *  host bind it, e.g. Fumadocs' global ⌘K), so the Searchbar can double as a
   *  search-dialog trigger. */
  shortcut?: React.ReactNode
}

const Searchbar = React.forwardRef<HTMLInputElement, SearchbarProps>(
  ({ className, variant, size = "medium", onClear, shortcut, value, onChange, disabled, ...props }, ref) => {
    const [localValue, setLocalValue] = React.useState("")
    const isControlled = value !== undefined
    const currentValue = isControlled ? value : localValue

    const handleClear = () => {
      if (!isControlled) {
        setLocalValue("")
      }
      onClear?.()
      if (onChange) {
        const event = {
          target: { value: "" },
          currentTarget: { value: "" },
        } as React.ChangeEvent<HTMLInputElement>
        onChange(event)
      }
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!isControlled) {
        setLocalValue(e.target.value)
      }
      onChange?.(e)
    }

    const hasContent = currentValue !== ""

    return (
      <div
        data-slot="searchbar"
        className={cn(searchbarVariants({ variant, size, className }))}
      >
        <Search
          className={cn("absolute text-muted-foreground pointer-events-none", {
            // mini + small share a 12px glyph at left-1.5 — kept as ONE key: two object
            // keys with the same class string would collapse (last wins) and silently
            // drop the icon size class off whichever lost.
            "left-1.5 size-3": size === "mini" || size === "small",
            "left-2 size-3.5": size === "medium" || !size,
            "left-2 size-4": size === "large",
            "left-2.5 size-4.5": size === "xl",
          })}
        />
        <input
          ref={ref}
          type="text"
          value={currentValue}
          onChange={handleChange}
          disabled={disabled}
          className={cn(
            "w-full h-full bg-transparent border-0 outline-none p-0 focus:ring-0 focus:outline-none placeholder:text-muted-foreground"
          )}
          {...props}
        />
        {hasContent && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            className={cn(
              "absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/45 text-background focus:outline-none transition-[background-color,scale] active:scale-90",
              {
                "right-1 size-3": size === "mini",
                "right-1 size-3.5": size === "small",
                "right-1.5 size-3.5": size === "medium" || !size,
                "right-1.5 size-4": size === "large",
                "right-2 size-4.5": size === "xl",
              }
            )}
          >
            <X
              className={cn({
                "size-2": size === "mini",
                "size-2.5": size === "small" || size === "medium" || size === "large" || !size,
                "size-3": size === "xl",
              })}
            />
          </button>
        )}
        {!hasContent && shortcut && !disabled ? (
          <kbd
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1/2 -translate-y-1/2 inline-flex items-center gap-0.5 rounded border border-[var(--acr-border-soft)] bg-[var(--acr-chip)] font-sans font-medium leading-none text-muted-foreground",
              {
                "right-1 px-1 py-0.5 text-[9px]": size === "mini" || size === "small",
                "right-1.5 px-1 py-0.5 text-[10px]": size === "medium" || size === "large" || !size,
                "right-2 px-1.5 py-1 text-[11px]": size === "xl",
              }
            )}
          >
            {shortcut}
          </kbd>
        ) : null}
      </div>
    )
  }
)
Searchbar.displayName = "Searchbar"

export { Searchbar }
