"use client"

import * as React from "react"
import { Toaster as Sonner, toast as rawToast } from "sonner"

import { cn } from "@/lib/utils"
import { Spinner } from "./spinner"

type ToasterProps = React.ComponentProps<typeof Sonner>

export interface ToastOptions extends Omit<NonNullable<Parameters<typeof rawToast>[1]>, "icon"> {
  variant?: "img" | "icon"
  icon?: React.ReactNode
}

function getFormattedOptions(variant: "img" | "icon", options?: ToastOptions) {
  const isIcon = variant === "icon"
  const paddingAndGapClass = isIcon 
    ? "group/toast-icon !pl-4 !gap-2.5" 
    : "group/toast-img !pl-[10px] !gap-1.5"

  if (!options) {
    return {
      className: paddingAndGapClass,
      classNames: {
        icon: isIcon ? "!size-5 [&_svg]:!size-5" : "!size-8",
      },
      style: {
        "--loader-size": isIcon ? "20px" : "32px",
      } as React.CSSProperties,
    }
  }

  const { className, classNames = {}, style, ...rest } = options
  return {
    ...rest,
    className: cn(paddingAndGapClass, className),
    classNames: {
      ...classNames,
      icon: cn(
        isIcon ? "!size-5 [&_svg]:!size-5" : "!size-8",
        classNames.icon
      ),
    },
    style: {
      "--loader-size": isIcon ? "20px" : "32px",
      ...style,
    } as React.CSSProperties,
  }
}

type ToastT = string | number

const toastFn = (message: string | React.ReactNode, options?: ToastOptions): ToastT => {
  const variant = options?.variant || (options?.icon ? "img" : undefined)
  const formatted = variant ? getFormattedOptions(variant, options) : options
  return rawToast(message, formatted)
}

const wrapMethod = (rawMethod: any, defaultVariant: "img" | "icon") => {
  return (message: string | React.ReactNode, options?: ToastOptions): ToastT => {
    const variant = options?.variant || defaultVariant
    const formatted = getFormattedOptions(variant, options)
    return rawMethod(message, formatted)
  }
}

export const toast = Object.assign(toastFn, {
  success: wrapMethod(rawToast.success, "icon"),
  error: wrapMethod(rawToast.error, "icon"),
  warning: wrapMethod(rawToast.warning, "icon"),
  info: wrapMethod(rawToast.info, "icon"),
  loading: wrapMethod(rawToast.loading, "icon"),
  custom: rawToast.custom,
  dismiss: rawToast.dismiss,
  message: wrapMethod(rawToast.message, "img"),
  promise: <T,>(
    promise: Promise<T> | (() => Promise<T>),
    options?: {
      // 本地补丁：phase 回调允许返回 string | ReactNode——上游类型只写了 ToastOptions，
      // 但运行时 formatPhase 本就把 string/element 原样放行（sonner 原生也支持）。
      loading?: string | React.ReactNode | ToastOptions
      success?: string | React.ReactNode | ((data: T) => ToastOptions | string | React.ReactNode) | ToastOptions
      error?: string | React.ReactNode | ((error: any) => ToastOptions | string | React.ReactNode) | ToastOptions
    } & ToastOptions
  ): any => {
    if (!options) return rawToast.promise(promise, options)

    const { loading, success, error, ...restGlobalOptions } = options
    const globalVariant = restGlobalOptions.variant || "icon"
    const formattedGlobal = getFormattedOptions(globalVariant, restGlobalOptions)

    const formatPhase = (phase: any, defaultVar: "img" | "icon") => {
      if (typeof phase === "string" || React.isValidElement(phase)) {
        return phase
      }
      if (phase && typeof phase === "object") {
        const variant = phase.variant || defaultVar
        return getFormattedOptions(variant, phase)
      }
      if (typeof phase === "function") {
        return (data: any) => {
          const res = phase(data)
          if (typeof res === "string" || React.isValidElement(res)) {
            return res
          }
          if (res && typeof res === "object") {
            const variant = res.variant || defaultVar
            return getFormattedOptions(variant, res)
          }
          return res
        }
      }
      return phase
    }

    return rawToast.promise(promise, {
      loading: formatPhase(loading, "icon"),
      success: formatPhase(success, "icon"),
      error: formatPhase(error, "icon"),
      ...formattedGlobal,
    } as any)
  },
})

// Acrylic Toaster — modeled on the Apple macOS 26 UI Kit Notifications page. A
// Sonner toast is the web equivalent of a macOS notification *banner*: a frosted,
// translucent card that slides in and auto-dismisses. Geometry is lifted from the
// kit banner (344×78, radius 16, 12/14/12/10 padding, 6px icon→text gap, Bold/13
// title + Regular/13 body — both the same near-black/near-white ink, hierarchy is
// weight only; the gray is the 11px timestamp). The surface uses the acrylic toast
// var (--acr-toast, a translucent
// material over a backdrop blur) so the frosted look flips light/dark for free.
//
// Why CSS variables instead of just classes: Sonner injects its CSS at runtime,
// UNLAYERED — so it beats our Tailwind utilities (which live in @layer utilities)
// no matter the specificity (layer order trumps specificity). Fighting that with
// classes silently fails (the bg/border stay Sonner's). So we drive Sonner through
// its OWN variables, set inline (highest precedence): --normal-bg = our acrylic
// material, --normal-border = transparent (no edge — Apple uses the shadow alone,
// which also kills the dark-mode hairline), --border-radius/--width = kit metrics.
// Only props with no Sonner variable (padding, box-shadow) need `!` on a class.

// Resolve the active theme from the `.dark` class on <html> — the substrate EVERY
// shadcn theme setup writes to: next-themes (`attribute="class"`), shadcn's Vite
// custom ThemeProvider, or a single-theme app that just pins the class. Reading it
// directly keeps this Toaster theme-PROVIDER-agnostic — no `next-themes` (or any)
// dependency to install, no per-consumer import swap (the manual step shadcn's Vite
// users do), and it still reacts live to a toggle (the class mutates → the observer
// re-reads). Pass an explicit `theme` prop to override.
function useDocumentTheme(): "light" | "dark" {
  const read = React.useCallback(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark")
        ? "dark"
        : "light",
    []
  )
  const [theme, setTheme] = React.useState<"light" | "dark">(read)
  React.useEffect(() => {
    setTheme(read())
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [read])
  return theme
}

export function Toaster({ className, toastOptions, ...props }: ToasterProps) {
  const theme = useDocumentTheme()
  return (
    <Sonner
      theme={theme}
      position="top-center"
      offset={56}
      className={cn("toaster group", className)}
      icons={{
        loading: <Spinner />,
      }}
      style={
        {
          // Sonner hard-codes a system font-family on the toaster (unlayered, so it
          // beats our classes); inherit instead so toasts use the host app's font
          // (SF Pro / Inter / whatever) and match the rest of the UI.
          fontFamily: "inherit",
          "--normal-bg": "var(--acr-toast)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "transparent",
          "--border-radius": "16px",
          "--width": "344px",
          // Sonner nudges the icon with negative/extra margins (-3px / +4px); zero
          // them so the 32px app icon sits cleanly with just the gap-4 (kit metric).
          "--toast-icon-margin-start": "0px",
          "--toast-icon-margin-end": "0px",
          "--toast-svg-margin-start": "0px",
          "--toast-svg-margin-end": "0px",
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          // Frosted acrylic banner. bg / radius / width / (no) border come from the
          // Sonner vars above; here we add the real material — a backdrop blur +
          // saturate (Sonner sets no backdrop-filter, so the class applies cleanly) —
          // plus kit padding and a soft drop shadow. `!` on padding/shadow because
          // Sonner's unlayered container rule would otherwise win. The kit's 10px
          // left pad assumes a 32px app-icon sits there; when a toast has no icon
          // (Sonner renders no [data-icon]), bump the left pad so the text isn't
          // crammed against the edge.
          // (gap between icon and text is Sonner's own 6px, kept for the tighter look)
          toast: cn(
            "group/toast items-center text-foreground !py-3 !pr-[14px] !shadow-[0_8px_30px_rgba(0,0,0,0.22)] backdrop-blur-2xl backdrop-saturate-150",
            // Fallback paddings and gaps if toast is not triggered via wrapped helper:
            "group-[&:not(.group\/toast-icon):not(.group\/toast-img)]/toast:!pl-[10px] group-[&:not(.group\/toast-icon):not(.group\/toast-img)]/toast:!gap-1.5",
            "[&:not(:has([data-icon]))]:!pl-4"
          ),
          // App-icon slot — 32×32 leading glyph, matching the kit. `!size-8` beats
          // Sonner's unlayered 16px [data-icon] rule so a passed app icon fills it;
          // we do NOT force the inner svg size, so Sonner's own status icons
          // (success/error) keep their intrinsic size instead of blowing up and
          // overlapping the text.
          icon: cn(
            "shrink-0 flex items-center justify-center",
            // Fallback size if not triggered via wrapped helper:
            "group-[&:not(.group\/toast-icon):not(.group\/toast-img)]/toast:!size-8"
          ),
          content: "gap-0",
          // Title SFPro-Bold/13 uses foreground ink; description is the secondary
          // line and must use muted foreground. `!` is required because Sonner's
          // runtime CSS sets [data-description] color outside Tailwind layers.
          // `!` on weight: Sonner's unlayered [data-title]{font-weight:500} would
          // otherwise beat the layered font-bold utility, so the live title would
          // render medium while a static replica renders bold.
          title: "text-[13px] !font-bold leading-tight",
          description: "text-[13px] leading-snug !text-muted-foreground",
          // Action / cancel mirror the acrylic Button (default + neutral, small
          // size). Sonner styles its buttons via a runtime-injected, (0,3,0) rule
          // [data-sonner-toast][data-styled] [data-button] that sets radius/padding/
          // height/font-size/color/background — utility classes can't outrank it, so
          // we force our look with `!` on exactly those props.
          actionButton:
            "self-center !h-5 !gap-1 !rounded-[5px] !bg-primary !px-[10px] !text-[11px] !font-medium !text-primary-foreground !shadow-sm hover:!brightness-110 [&_svg]:!size-3",
          cancelButton:
            "self-center !h-5 !gap-1 !rounded-[5px] !bg-[var(--acr-chip)] !px-[10px] !text-[11px] !font-medium !text-foreground hover:!bg-[var(--acr-chip-hover)] [&_svg]:!size-3",
          // Close affordance — subtle ghost (kit banners have no persistent X).
          closeButton:
            "border-[var(--acr-border-soft)] bg-[var(--acr-chip)] text-foreground hover:bg-[var(--acr-chip-hover)]",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )
}

