import * as React from "react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/lib/utils"

type ItemVariant = "default" | "outline" | "muted"
type ItemSize = "default" | "sm" | "xs"

function Item({
  className,
  variant = "default",
  size = "default",
  selected,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: ItemVariant
  size?: ItemSize
  selected?: boolean
  asChild?: boolean
}) {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp
      data-slot="item"
      data-variant={variant}
      data-size={size}
      data-selected={selected || undefined}
      className={cn(itemClasses({ variant, size }), className)}
      {...props}
    />
  )
}

function itemClasses({
  variant,
  size,
}: {
  variant: ItemVariant
  size: ItemSize
}) {
  return cn(
    "group/item flex min-w-0 items-center gap-3 rounded-[10px] text-left outline-none",
    "has-data-[slot=item-header]:flex-wrap has-data-[slot=item-footer]:flex-wrap",
    "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
    // Selected = the macOS key-window selection: SOLID accent, white label — the
    // same language as a selected TableRow. Every text slot escalates through the
    // group-data-[selected=true]/item: hook (ItemMedia and Badge already read it),
    // so a call site never hand-rolls the per-slot retargeting.
    "data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground",
    variant === "outline" &&
      "acr-frosted bg-[var(--acr-surface)] backdrop-blur-xl",
    variant === "muted" && "bg-[var(--acr-card-nested)]",
    size === "default" && "p-3",
    size === "sm" && "gap-2 rounded-[8px] px-2.5 py-2",
    size === "xs" && "gap-2 rounded-[7px] px-2 py-1.5"
  )
}

function ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "icon" | "image" | "avatar"
}) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[8px] text-muted-foreground",
        "group-data-[size=sm]/item:rounded-[6px] group-data-[size=xs]/item:rounded-[5px]",
        // Same assumption as Badge's secondary/outline (see badge.tsx): the icon
        // color and the --acr-card-nested wash both read against a normal panel
        // backdrop. Nested in a selected Item (solid bg-primary), the wash barely
        // tints the accent color while the icon stays muted-foreground — escalate
        // through the same group-data-[selected=true]/item: hook.
        "group-data-[selected=true]/item:text-primary-foreground/85",
        variant === "default" &&
          "size-10 group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-7 [&>svg]:size-5 group-data-[size=sm]/item:[&>svg]:size-4 group-data-[size=xs]/item:[&>svg]:size-3.5",
        variant === "icon" &&
          "size-10 bg-[var(--acr-card-nested)] group-data-[selected=true]/item:bg-white/15 group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-7 [&>svg]:size-5 group-data-[size=sm]/item:[&>svg]:size-4 group-data-[size=xs]/item:[&>svg]:size-3.5",
        variant === "image" &&
          "size-12 overflow-hidden bg-[var(--acr-card-nested)] group-data-[selected=true]/item:bg-white/15 group-data-[size=sm]/item:size-10 group-data-[size=xs]/item:size-8 [&>img]:size-full [&>img]:object-cover",
        variant === "avatar" &&
          "size-10 rounded-full bg-transparent group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-7",
        className
      )}
      {...props}
    />
  )
}

function ItemRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-row"
      className={cn(
        "flex min-w-0 basis-full items-start gap-2",
        className
      )}
      {...props}
    />
  )
}

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn("flex basis-full flex-col gap-1", className)}
      {...props}
    />
  )
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn("min-w-0 flex-1", className)}
      {...props}
    />
  )
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn(
        "truncate text-[13px] font-medium leading-snug text-foreground group-data-[size=sm]/item:text-[12px] group-data-[size=xs]/item:text-[11px]",
        "group-data-[selected=true]/item:text-primary-foreground",
        className
      )}
      {...props}
    />
  )
}

function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "line-clamp-2 text-[12px] leading-snug text-muted-foreground group-data-[size=sm]/item:text-[11px] group-data-[size=xs]/item:text-[10px]",
        "group-data-[selected=true]/item:text-primary-foreground/80",
        className
      )}
      {...props}
    />
  )
}

function ItemMeta({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-meta"
      className={cn(
        "shrink-0 whitespace-nowrap text-[11px] leading-snug text-muted-foreground group-data-[size=xs]/item:text-[10px]",
        "group-data-[selected=true]/item:text-primary-foreground/80",
        className
      )}
      {...props}
    />
  )
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn(
        "flex shrink-0 items-center justify-end gap-1",
        "group-data-[selected=true]/item:text-primary-foreground/80",
        className
      )}
      {...props}
    />
  )
}

const ItemAction = ItemActions

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        "flex basis-full items-center gap-2 pt-1 text-[12px] text-muted-foreground group-data-[size=sm]/item:text-[11px] group-data-[size=xs]/item:text-[10px]",
        "group-data-[selected=true]/item:text-primary-foreground/80",
        className
      )}
      {...props}
    />
  )
}

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-group"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function ItemSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-separator"
      role="separator"
      className={cn("h-px bg-[var(--acr-border)]", className)}
      {...props}
    />
  )
}

export {
  Item,
  ItemAction,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMeta,
  ItemMedia,
  ItemRow,
  ItemSeparator,
  ItemTitle,
}
