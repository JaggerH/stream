import * as React from "react"
import { Check, ChevronDown, Plus } from "lucide-react"
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

// Acrylic Combobox — the kit's macOS 26 Combo Box: an Input-styled trigger with a
// trailing chevron opening the frosted Popover + searchable Command list. Ported from
// app/ verbatim so the extension shares the official style; extended here with an inline
// `onCreate` row (type a new name → "＋ Create …") for the channel picker.
export interface ComboboxOption {
  value: string
  label: string
}

type ComboboxProps = {
  options?: ComboboxOption[]
  value?: string
  onValueChange?: (value: string) => void
  /** When set, a query with no exact match shows a "＋ Create …" row that calls this. */
  onCreate?: (label: string) => void
  createLabel?: (query: string) => string
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  contentClassName?: string
} & VariantProps<typeof inputVariants>

function Combobox({
  options = [],
  value,
  onValueChange,
  onCreate,
  createLabel = (q) => `Create “${q}”`,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  size = "medium",
  className,
  contentClassName,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const selected = options.find((o) => o.value === value)

  const q = query.trim()
  const exact = options.some((o) => o.label.toLowerCase() === q.toLowerCase())
  const canCreate = !!onCreate && q.length > 0 && !exact

  const close = () => { setOpen(false); setQuery("") }

  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
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
        className={cn("w-[var(--radix-popover-trigger-width)] min-w-[12rem] p-0", contentClassName)}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList>
            {!canCreate && <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => { onValueChange?.(o.value); close() }}
                >
                  <Check className={cn("size-3.5", o.value === value ? "opacity-100" : "opacity-0")} />
                  {o.label}
                </CommandItem>
              ))}
              {canCreate && (
                <CommandItem
                  value={q}
                  onSelect={() => { onCreate?.(q); close() }}
                  className="text-[var(--acr-blue)]"
                >
                  <Plus className="size-3.5" />
                  {createLabel(q)}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { Combobox }
