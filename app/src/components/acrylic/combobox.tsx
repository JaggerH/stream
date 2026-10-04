"use client"

import * as React from "react"
import { Check, ChevronDown } from "lucide-react"
import { type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { inputVariants } from "./input"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command"

// Acrylic Combobox — the macOS 26 Combo Box: a Text-Field-styled trigger (reuses
// the Input geometry, all five control sizes) with a trailing chevron, opening a
// frosted Popover with a searchable Command list. Assembled from Input + Popover +
// Command, matching the kit's composite (Text Field + Menu Button).
export interface ComboboxOption {
  value: string
  label: string
}

export interface ComboboxGroupData {
  heading?: string
  options: ComboboxOption[]
}

type ComboboxProps = {
  /** Flat option list. Ignored when `groups` is provided. */
  options?: ComboboxOption[]
  /** Grouped options — each renders a CommandGroup with an optional heading. Takes
   *  precedence over `options`; use for visually separating categories (e.g. Stream
   *  vs Provider) instead of prefixing labels. */
  groups?: ComboboxGroupData[]
  value?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  contentClassName?: string
  /** Set when the Combobox lives inside a modal Dialog/Sheet — makes the Popover its
   *  own top-most interactive layer. Prefer `container` for popover-inside-dialog; a
   *  modal popover nested in a modal dialog can leave body pointer-events stuck on close. */
  modal?: boolean
  /** Portal the popover into this node (e.g. the Sheet's content) instead of document.body.
   *  The recommended fix for a Combobox inside a modal Sheet/Dialog: the list renders in
   *  the dialog's interactive subtree, staying clickable + scrollable, with no extra lock. */
  container?: React.ComponentProps<typeof PopoverContent>["container"]
} & VariantProps<typeof inputVariants>

function Combobox({
  options = [],
  groups,
  value,
  onValueChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  size = "medium",
  className,
  contentClassName,
  modal,
  container,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false)
  // groups, when present, define the render + the flat lookup for the selected label
  const renderGroups: ComboboxGroupData[] = groups ?? [{ options }]
  const allOptions = renderGroups.flatMap((g) => g.options)
  const selected = allOptions.find((o) => o.value === value)

  const renderItem = (o: ComboboxOption) => (
    <CommandItem
      key={o.value}
      value={o.label}
      onSelect={() => {
        onValueChange?.(o.value === value ? "" : o.value)
        setOpen(false)
      }}
    >
      <Check className={cn("size-3.5", o.value === value ? "opacity-100" : "opacity-0")} />
      {o.label}
    </CommandItem>
  )

  return (
    <Popover open={open} onOpenChange={setOpen} modal={modal}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          data-slot="combobox-trigger"
          className={cn(
            inputVariants({ size }),
            "items-center justify-between gap-2",
            !selected && "text-muted-foreground",
            className
          )}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        container={container}
        className={cn("w-[var(--radix-popover-trigger-width)] min-w-[12rem] p-0", contentClassName)}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {renderGroups.map((g, i) => (
              <CommandGroup key={g.heading ?? i} heading={g.heading}>
                {g.options.map(renderItem)}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { Combobox }

