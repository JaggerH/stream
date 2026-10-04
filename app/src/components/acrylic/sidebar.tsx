"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { PanelLeftIcon } from "lucide-react"
import { Slot as SlotPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { useIsMobile } from "./use-mobile"
import { Button } from "./button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "./hover-card"
import { Input } from "./input"
import { Separator } from "./separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./sheet"
import { Skeleton } from "./skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"

const SIDEBAR_COOKIE_NAME = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH = "15rem" // 240px — the macOS 26 kit sidebar width
const SIDEBAR_WIDTH_MOBILE = "18rem"
const SIDEBAR_WIDTH_ICON = "3rem"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"

type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [setOpenProp, open]
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleSidebar])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed"

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            // `relative` so the sidebar's absolutely-positioned container is scoped
            // to THIS wrapper (full-page or a contained box alike) instead of needing
            // the consumer to set up a fixed-positioning containing block.
            "group/sidebar-wrapper relative flex min-h-svh w-full has-data-[variant=inset]:bg-[var(--acr-surface)]",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right"
  variant?: "sidebar" | "floating" | "inset"
  collapsible?: "offcanvas" | "icon" | "none"
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          // shrink-0: the sidebar keeps its width and is never compressed by the
          // flex row — the content pane gives way instead. Width stays flexible via
          // --sidebar-width.
          // bg-[var(--sidebar)] follows the theme: a white, dark-text sidebar in plain
          // Light; a dark, white-text material in Dark and Acrylic (translucent in
          // Acrylic so backdrop-blur frosts it). It re-points --foreground/
          // --muted-foreground and the --acr-* interaction tokens at the per-theme
          // --sidebar-* set, so all descendants flip with it — no per-child overrides.
          "flex h-full w-(--sidebar-width) shrink-0 flex-col bg-[var(--sidebar)] text-[var(--sidebar-foreground)] [--foreground:var(--sidebar-foreground)] [--muted-foreground:var(--sidebar-muted-foreground)] [--acr-hover:var(--sidebar-hover)] [--acr-chip:var(--sidebar-active)] [--acr-chip-hover:var(--sidebar-active)] [--acr-control:var(--sidebar-control)] [--acr-input:var(--sidebar-input)] [--acr-border:var(--sidebar-border)] backdrop-blur-2xl",
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="w-(--sidebar-width) p-0 text-foreground [&>button]:hidden"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer hidden shrink-0 text-foreground md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)]",
          "group-data-[collapsible=offcanvas]:w-0",
          "group-data-[side=right]:rotate-180",
          variant === "floating" || variant === "inset"
            ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          // `absolute` (not `fixed`) + `inset-y-0` (no h-svh): the rail is scoped to
          // the SidebarProvider wrapper and its height follows the wrapper, so it
          // works inside a contained box without any consumer CSS — no transform
          // containing-block trick, no height override.
          "absolute inset-y-0 z-10 hidden w-(--sidebar-width) transition-[left,right,width] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)] md:flex",
          side === "left"
            ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
            : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
          // Adjust the padding for floating and inset variants.
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          // rounded-[inherit]: the surface inherits whatever radius the consumer
          // puts on the Sidebar, so rounding the sidebar clips the frosted fill too
          // (no square corner poking out) without an overflow-hidden that would clip
          // the rail.
          className="flex h-full w-full flex-col rounded-[inherit] bg-[var(--sidebar)] text-[var(--sidebar-foreground)] [--foreground:var(--sidebar-foreground)] [--muted-foreground:var(--sidebar-muted-foreground)] [--acr-hover:var(--sidebar-hover)] [--acr-chip:var(--sidebar-active)] [--acr-chip-hover:var(--sidebar-active)] [--acr-control:var(--sidebar-control)] [--acr-input:var(--sidebar-input)] [--acr-border:var(--sidebar-border)] backdrop-blur-2xl group-data-[variant=floating]:rounded-xl group-data-[variant=floating]:border group-data-[variant=floating]:border-[var(--acr-border)] group-data-[variant=floating]:shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      icon
      className={cn("size-7 text-muted-foreground hover:text-foreground", className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar()

  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        "absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-[var(--acr-border)] sm:flex",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-[var(--acr-surface)]",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        // The main panel just follows the theme background — no dedicated content
        // material. Opaque in plain light/dark (the backdrop-blur is a no-op); in
        // Acrylic `--background` is a dark translucent veil, so it frosts the Backdrop
        // and reads white-on-dark. Under Tauri vibrancy the native OS material shows
        // through instead. Pass a custom bg to override (tailwind-merge wins).
        "relative flex w-full flex-1 flex-col bg-[var(--background)] text-foreground backdrop-blur-2xl",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn("h-8 w-full shadow-none", className)}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
}

function SidebarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn("mx-2 w-auto bg-[var(--acr-border)]", className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto group-data-[collapsible=icon]:overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? SlotPrimitive.Slot : "div"

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-[11px] [letter-spacing:var(--text-subheadline-tracking)] font-medium text-[var(--muted-foreground)] ring-[var(--ring)] outline-hidden transition-[margin,opacity] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)] focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const Comp = asChild ? SlotPrimitive.Slot : "button"

  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        "absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-foreground ring-[var(--ring)] outline-hidden transition-transform hover:bg-[var(--acr-hover)] focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        // Increases the hit area of the button on mobile.
        "after:absolute after:-inset-2 md:after:hidden",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("w-full text-[13px]", className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-0", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({
  className,
  children,
  ...props
}: React.ComponentProps<"li">) {
  const { state, isMobile } = useSidebar()
  const collapsed = state === "collapsed" && !isMobile

  // Collapsed icon rail: the inline SidebarMenuSub is `hidden`, which would strand
  // every nested route. If this item pairs a button with a sub-menu, surface that
  // sub-menu as a flyout HoverCard anchored to the button so the sub-items stay
  // reachable on hover. The flyout renders the SAME SidebarMenuSub/SubButton the
  // expanded rail uses, so it reads identically — only the left indent is dropped
  // (no nesting context inside the popover).
  const items = React.Children.toArray(children)
  const sub = items.find(
    (child) => React.isValidElement(child) && child.type === SidebarMenuSub
  )
  const button = items.find(
    (child) => React.isValidElement(child) && child.type === SidebarMenuButton
  )

  if (collapsed && sub && button) {
    return (
      <li
        data-slot="sidebar-menu-item"
        data-sidebar="menu-item"
        className={cn("group/menu-item relative", className)}
        {...props}
      >
        <HoverCard openDelay={100} closeDelay={150}>
          <HoverCardTrigger asChild>{button}</HoverCardTrigger>
          <HoverCardContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-48 p-1 [&_[data-slot=sidebar-menu-sub-button]]:w-full [&_[data-slot=sidebar-menu-sub-button]]:pl-2 [&_[data-slot=sidebar-menu-sub]]:flex"
          >
            {sub}
          </HoverCardContent>
        </HoverCard>
      </li>
    )
  }

  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    >
      {children}
    </li>
  )
}

// Selection follows the macOS 26 kit: a NEUTRAL gray pill (--acr-chip ≈ black 11%),
// radius 8, NOT the accent. The icon stays the system label color too (Apple keeps
// the selected row monochrome) — no System Blue tint.
const sidebarMenuButtonVariants = cva(
  // No hover background on rows — matches the macOS source list, where only the
  // SELECTED row is highlighted (data-[active]); hovering an item shows nothing, so
  // a selected row and a hovered neighbour never grow touching highlight pills.
  // `active:` (mouse-down press feedback) is kept.
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-lg px-2 text-left text-[13px] whitespace-nowrap ring-[var(--ring)] outline-hidden transition-[width,height,padding] [transition-timing-function:var(--acr-spring-default)] [transition-duration:var(--acr-spring-default-duration)] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! focus-visible:ring-2 active:bg-[var(--acr-chip)] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-[var(--acr-chip)] data-[active=true]:font-medium [&>*]:min-w-0 [&>span:not([data-slot=avatar])]:flex-1 [&>span:not([data-slot=avatar])]:overflow-hidden [&>span:not([data-slot=avatar])]:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [&>span:not([data-slot=avatar])]:[mask-repeat:no-repeat] [&>span:not([data-slot=avatar])]:[mask-size:100%_100%] [&>div:not(.aspect-square):not([data-slot=avatar])]:overflow-hidden [&>div:not(.aspect-square):not([data-slot=avatar])]:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [&>div:not(.aspect-square):not([data-slot=avatar])]:[mask-repeat:no-repeat] [&>div:not(.aspect-square):not([data-slot=avatar])]:[mask-size:100%_100%] [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "",
        outline:
          "bg-[var(--acr-control)] shadow-[0_0_0_1px_var(--acr-border)] hover:bg-[var(--acr-hover)] hover:shadow-[0_0_0_1px_var(--acr-border)]",
      },
      size: {
        default: "h-8 text-[13px]",
        sm: "h-6 text-[11px] [letter-spacing:var(--text-subheadline-tracking)]",
        lg: "h-10 text-[15px] group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string | React.ComponentProps<typeof TooltipContent>
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? SlotPrimitive.Slot : "button"
  const { isMobile, state } = useSidebar()

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isMobile}
        {...tooltip}
      />
    </Tooltip>
  )
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  showOnHover?: boolean
}) {
  const Comp = asChild ? SlotPrimitive.Slot : "button"

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        "absolute top-1/2 right-1 flex aspect-square w-5 -translate-y-1/2 items-center justify-center rounded-md p-0 text-foreground ring-[var(--ring)] outline-hidden transition-transform hover:bg-[var(--acr-hover)] focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        // Increases the hit area of the button on mobile.
        "after:absolute after:-inset-2 md:after:hidden",
        "group-data-[collapsible=icon]:hidden",
        showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute top-1/2 right-1 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-md px-1 text-[11px] [letter-spacing:var(--text-subheadline-tracking)] font-medium text-[var(--muted-foreground)] tabular-nums select-none",
        "peer-data-[active=true]/menu-button:text-foreground",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean
}) {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`
  }, [])

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  )
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        // macOS keeps the selection highlight full-width at every nesting level —
        // only the row CONTENT indents (no left rail, no narrowed pill).
        "flex w-full min-w-0 flex-col gap-0",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSubItem({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("group/menu-sub-item relative", className)}
      {...props}
    />
  )
}

function SidebarMenuSubButton({
  asChild = false,
  size = "md",
  isActive = false,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean
  size?: "sm" | "md"
  isActive?: boolean
}) {
  const Comp = asChild ? SlotPrimitive.Slot : "a"

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        // Full-width row, gray-pill selection like top level; content indented via
        // pl so the highlight stays edge-to-edge (matches the kit's nested rows).
        "flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg pr-2 pl-8 text-foreground whitespace-nowrap ring-[var(--ring)] outline-hidden focus-visible:ring-2 active:bg-[var(--acr-chip)] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>*]:min-w-0 [&>span:not([data-slot=avatar])]:flex-1 [&>span:not([data-slot=avatar])]:overflow-hidden [&>span:not([data-slot=avatar])]:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [&>span:not([data-slot=avatar])]:[mask-repeat:no-repeat] [&>span:not([data-slot=avatar])]:[mask-size:100%_100%] [&>div:not(.aspect-square):not([data-slot=avatar])]:overflow-hidden [&>div:not(.aspect-square):not([data-slot=avatar])]:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [&>div:not(.aspect-square):not([data-slot=avatar])]:[mask-repeat:no-repeat] [&>div:not(.aspect-square):not([data-slot=avatar])]:[mask-size:100%_100%] [&>svg]:size-4 [&>svg]:shrink-0",
        "data-[active=true]:bg-[var(--acr-chip)] data-[active=true]:font-medium",
        size === "sm" && "text-[11px] [letter-spacing:var(--text-subheadline-tracking)]",
        size === "md" && "text-[13px]",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
}

