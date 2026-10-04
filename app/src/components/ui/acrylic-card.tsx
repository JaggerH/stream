import * as React from 'react'

import { cn } from '@/lib/utils.ts'

/** Card — a dark-glass (acrylic) surface card. A charcoal translucent pane over a blurred
 *  backdrop (the background shows through, softly darkened) — flat at rest with NO shadow,
 *  no rim/border, no inner bevel. `interactive` adds a hover lift + a touch lighter fill +
 *  a soft float shadow that appears only on hover. Ported verbatim from acrylic-ui
 *  (registry/acrylic/card.tsx); the glass is `bg-[var(--acr-surface)] backdrop-blur-xl`,
 *  the `--acr-surface*` tokens live in index.css. */
const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    interactive?: boolean
    /** 声明本卡是一层"面"：其**内嵌**的 Card 走 --acr-card-nested 嵌套着色（上游同款）。
     *  规则是后代选择器，**不作用于本卡自己**——要让这张卡退色，标记挂它的父容器上。 */
    nestedSurface?: boolean
  }
>(({ className, interactive = false, nestedSurface = false, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card"
    data-nested-surface={nestedSurface || undefined}
    className={cn(
      'acr-frosted relative rounded-xl bg-[var(--acr-surface)] backdrop-blur-xl',
      'transition-[transform,background-color] duration-200',
      interactive &&
        'hover:-translate-y-px hover:bg-[var(--acr-surface-hover)] ' +
        'before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-xl ' +
        'before:shadow-[0_12px_28px_rgba(0,0,0,0.28)] before:opacity-0 ' +
        'before:transition-opacity before:duration-200 hover:before:opacity-100',
      className
    )}
    {...props}
  />
))
Card.displayName = 'Card'

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto]',
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('self-center text-[15px] font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-[13px] leading-snug text-muted-foreground', className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-start-1 flex items-start self-start justify-self-end', className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-6', className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="card-footer" className={cn('flex items-center px-6', className)} {...props} />
  )
}

export { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter }
