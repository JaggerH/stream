import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"

// Acrylic Popover — a frosted floating panel (same translucent material + 72px-ish
// blur family as the Dialog). Used as the dropdown surface for Combobox/Select.
const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    /** Portal target. Set to a modal Dialog/Sheet's content node so the popover renders
     *  INSIDE the dialog's interactive subtree (clickable + scrollable) instead of on
     *  document.body, avoiding the modal dialog's `pointer-events: none`. */
    container?: React.ComponentProps<typeof PopoverPrimitive.Portal>["container"]
  }
>(({ className, align = "start", sideOffset = 4, container, ...props }, ref) => (
  <PopoverPrimitive.Portal container={container}>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-[10px] bg-[var(--acr-panel)] p-4 text-foreground backdrop-blur-xl shadow-[0_0_0_1px_rgba(190,190,190,0.16),0_16px_48px_rgba(0,0,0,0.45)] outline-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
