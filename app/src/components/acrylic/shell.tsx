"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { SidebarProvider } from "./sidebar"

type ShellVariant = "default" | "inset"
type ShellPanelVariant = "default" | "list" | "detail"
type ShellNavbarSize = "default" | "compact" | "large"
type ShellContentPadding = "flush" | "default" | "reading"
type ShellLength = number | string

function shellLength(value: ShellLength | undefined) {
  if (value === undefined) return undefined
  return typeof value === "number" ? `${value}px` : value
}

function Shell({
  className,
  variant = "default",
  sidebarWidth,
  sidebarCollapsedWidth,
  style,
  defaultOpen,
  open,
  onOpenChange,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: ShellVariant
  sidebarWidth?: ShellLength
  sidebarCollapsedWidth?: ShellLength
  defaultOpen?: React.ComponentProps<typeof SidebarProvider>["defaultOpen"]
  open?: React.ComponentProps<typeof SidebarProvider>["open"]
  onOpenChange?: React.ComponentProps<typeof SidebarProvider>["onOpenChange"]
}) {
  const shellStyle = {
    ...style,
    ...(sidebarWidth !== undefined && {
      "--sidebar-width": shellLength(sidebarWidth),
    }),
    ...(sidebarCollapsedWidth !== undefined && {
      "--sidebar-width-icon": shellLength(sidebarCollapsedWidth),
    }),
  } as React.CSSProperties

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      data-slot="shell"
      data-variant={variant}
      style={shellStyle}
      className={cn(
        "relative min-h-0 overflow-hidden bg-background text-foreground",
        variant === "inset" &&
          "acr-frosted rounded-xl bg-[var(--acr-surface)] shadow-[0_8px_24px_rgba(0,0,0,0.28)] backdrop-blur-xl",
        className
      )}
      {...props}
    />
  )
}

function ShellInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="shell-inset"
      className={cn("flex min-w-0 flex-1 flex-col overflow-hidden", className)}
      {...props}
    />
  )
}

function ShellBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-body"
      className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", className)}
      {...props}
    />
  )
}

function ShellPanel({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"section"> & {
  variant?: ShellPanelVariant
}) {
  return (
    <section
      data-slot="shell-panel"
      data-variant={variant}
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden",
        "[&+&]:border-l [&+&]:border-[var(--acr-border-soft)]",
        variant === "list" && "w-72 flex-none",
        variant === "detail" && "flex-[1.35]",
        className
      )}
      {...props}
    />
  )
}

function ShellNavbar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  size?: ShellNavbarSize
}) {
  return (
    <div
      data-slot="shell-navbar"
      data-size={size}
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-[var(--acr-border-soft)] px-3",
        size === "compact" && "h-10",
        size === "default" && "h-11",
        size === "large" && "h-[52px]",
        className
      )}
      {...props}
    />
  )
}

function ShellNavbarActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-navbar-actions"
      className={cn("ml-auto flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  )
}

function ShellNavbarTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-navbar-title"
      className={cn("min-w-0 truncate text-[13px] font-semibold", className)}
      {...props}
    />
  )
}

function ShellNavbarSubtitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-navbar-subtitle"
      className={cn("min-w-0 truncate text-[11px] text-muted-foreground", className)}
      {...props}
    />
  )
}

function ShellNavbarHeading({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-navbar-heading"
      className={cn("min-w-0 flex-1", className)}
      {...props}
    />
  )
}

function ShellPanelHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-panel-header"
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--acr-border-soft)] px-3",
        className
      )}
      {...props}
    />
  )
}

function ShellPanelTitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-panel-title"
      className={cn("min-w-0 truncate text-[13px] font-semibold", className)}
      {...props}
    />
  )
}

function ShellPanelDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-panel-description"
      className={cn("min-w-0 truncate text-[11px] text-muted-foreground", className)}
      {...props}
    />
  )
}

function ShellPanelActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="shell-panel-actions"
      className={cn("ml-auto flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  )
}

function ShellContent({
  className,
  padding = "flush",
  ...props
}: React.ComponentProps<"div"> & {
  padding?: ShellContentPadding
}) {
  return (
    <div
      data-slot="shell-content"
      data-padding={padding}
      className={cn(
        "min-h-0 flex-1 overflow-auto",
        padding === "default" && "p-3",
        padding === "reading" && "px-8 py-7",
        className
      )}
      {...props}
    />
  )
}

const ShellPane = ShellPanel
const ShellToolbar = ShellNavbar
const ShellTitle = ShellNavbarTitle

export {
  Shell,
  ShellBody,
  ShellContent,
  ShellInset,
  ShellNavbar,
  ShellNavbarActions,
  ShellNavbarHeading,
  ShellNavbarSubtitle,
  ShellNavbarTitle,
  ShellPanel,
  ShellPanelActions,
  ShellPanelDescription,
  ShellPanelHeader,
  ShellPanelTitle,
  ShellPane,
  ShellTitle,
  ShellToolbar,
}

