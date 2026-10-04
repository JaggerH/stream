"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/acrylic/button"

// Acrylic InputGroup — the shadcn/ui composable input group, restyled with the
// Acrylic tokens so it matches our Input field. The GROUP owns the chrome
// (border + control surface + radius + focus ring via `focus-within`); the inner
// control (InputGroupInput / InputGroupTextarea) is bare — no border, bg, or ring
// of its own. Addons (icons / text / buttons) sit alongside the control; per
// shadcn, place the addon AFTER the control in the DOM and let `align` handle the
// visual placement. Clicking an addon focuses the control. This supersedes the old
// AutoTextarea: auto-grow now lives on InputGroupTextarea via `autoResize`.

function InputGroup({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex w-full min-w-0 flex-wrap items-center",
        "border border-[var(--acr-control-border)] bg-[var(--acr-control)] rounded-[6px]",
        "text-foreground outline-none transition-colors",
        "hover:border-[var(--acr-border)]",
        "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        // When an addon sits on a block edge, stack the rows vertically AND
        // stretch them full-width (otherwise items-center centers the control
        // horizontally and the textarea collapses to content width).
        "has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:items-stretch",
        "has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:items-stretch",
        className
      )}
      // Clicking anywhere in the group (the padding / addons) focuses the control.
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (target.closest("button, a, input, textarea, select")) return
        e.currentTarget
          .querySelector<HTMLElement>("[data-slot=input-group-control]")
          ?.focus()
      }}
      {...props}
    />
  )
}

function InputGroupInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input-group-control"
      className={cn(
        "order-1 h-6 min-w-0 flex-1 border-0 bg-transparent px-2 text-[13px] text-foreground outline-none",
        "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
        "disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  )
}

interface InputGroupTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with content from 1 row up to `maxRows`, then scroll. */
  autoResize?: boolean
  /** Max rows before the textarea scrolls instead of growing. */
  maxRows?: number
}

const InputGroupTextarea = React.forwardRef<
  HTMLTextAreaElement,
  InputGroupTextareaProps
>(
  (
    { autoResize = false, maxRows = 3, className, value, onChange, onInput, ...props },
    ref
  ) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null)
    const setRef = (el: HTMLTextAreaElement | null) => {
      innerRef.current = el
      if (typeof ref === "function") ref(el)
      else if (ref) ref.current = el
    }

    // Ported from the old AutoTextarea: reset height, measure scrollHeight, clamp
    // to lineHeight * maxRows + vertical padding, then toggle the overlay scrollbar.
    const resize = React.useCallback(() => {
      if (!autoResize) return
      const el = innerRef.current
      if (!el) return
      el.style.height = "auto"
      const cs = getComputedStyle(el)
      const lh = parseFloat(cs.lineHeight) || 20
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const max = lh * maxRows + pad
      el.style.height = `${Math.min(el.scrollHeight, max)}px`
      el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden"
    }, [autoResize, maxRows])

    // Re-measure on mount and whenever the controlled value changes.
    React.useEffect(resize, [resize, value])

    return (
      <textarea
        ref={setRef}
        data-slot="input-group-control"
        rows={1}
        value={value}
        onChange={(e) => {
          onChange?.(e)
          resize()
        }}
        // Covers uncontrolled usage (no `value`/`onChange`): grow as the user types.
        onInput={(e) => {
          onInput?.(e)
          resize()
        }}
        className={cn(
          "order-1 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-[13px] leading-5 text-foreground outline-none",
          "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
          "disabled:cursor-not-allowed scrollbar-mac",
          className
        )}
        {...props}
      />
    )
  }
)
InputGroupTextarea.displayName = "InputGroupTextarea"

type InputGroupAddonAlign =
  | "inline-start"
  | "inline-end"
  | "block-start"
  | "block-end"

interface InputGroupAddonProps extends React.ComponentProps<"div"> {
  /** Where the addon renders. Place addons AFTER the control; `align` positions them. */
  align?: InputGroupAddonAlign
}

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: InputGroupAddonProps) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        "flex items-center gap-1.5 text-muted-foreground [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        // Inline addons hug the start/end and keep the control between them.
        // Icon/text addons keep a roomy 8px inset; but when the addon holds a
        // Button, tighten the inset to ~the 2px vertical gap (the h-6 input sets
        // a 24px row, the h-5 button centers with 2px top/bottom) so the button
        // nests evenly on all four sides instead of floating off the edge.
        align === "inline-start" &&
          "order-0 pl-2 has-[>[data-slot=input-group-button]]:pl-0.5",
        align === "inline-end" &&
          "order-2 pr-2 has-[>[data-slot=input-group-button]]:pr-0.5",
        // Block addons span the full width above/below the control. Footer text
        // (a counter / hint) is caption-sized (11px) to match the button label so
        // the two read as one row and center cleanly. When the addon holds a
        // Button pinned to the far edge (ml-auto), tighten BOTH that edge's insets
        // to ~2px so the button's two exposed sides (e.g. bottom-right) get an
        // equal, evenly-nested gap; the left keeps its 8px so the counter still
        // lines up under the control's text.
        align === "block-start" &&
          "order-0 w-full px-2 pt-1.5 [&_[data-slot=input-group-text]]:text-[11px] has-[>[data-slot=input-group-button]]:pt-0.5 has-[>[data-slot=input-group-button]]:pr-0.5",
        align === "block-end" &&
          "order-2 w-full px-2 pb-1.5 [&_[data-slot=input-group-text]]:text-[11px] has-[>[data-slot=input-group-button]]:pb-0.5 has-[>[data-slot=input-group-button]]:pr-0.5",
        className
      )}
      // Focus the control when the addon's empty space is clicked.
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (target.closest("button, a, input, textarea, select")) return
        e.currentTarget
          .closest("[data-slot=input-group]")
          ?.querySelector<HTMLElement>("[data-slot=input-group-control]")
          ?.focus()
      }}
      {...props}
    />
  )
}

function InputGroupButton({
  className,
  variant = "ghost",
  size = "small",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="input-group-button"
      variant={variant}
      size={size}
      className={cn("h-5", className)}
      {...props}
    />
  )
}

function InputGroupText({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="input-group-text"
      className={cn(
        "text-[13px] text-muted-foreground select-none",
        className
      )}
      {...props}
    />
  )
}

export {
  InputGroup,
  InputGroupInput,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
}
