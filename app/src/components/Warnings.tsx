// Generic warning list: each row shows a CORE one-liner; the copy button copies the full
// diagnostic (label + message + caller-supplied context + browser context + optional detail/stack)
// for pasting into a bug report. Not tied to any feature — pass whatever warnings you have.
import { useState } from 'react'
import { CheckIcon, CopyIcon, TriangleAlertIcon } from 'lucide-react'
import { Button } from './acrylic/button.tsx'

export interface WarningEntry {
  /** short identifier shown bold (e.g. the failing source / subsystem name) */
  label: string
  /** core one-line message shown to the user */
  message: string
  /** full detail copied to clipboard (e.g. a backend stack); label/message/context always included */
  detail?: string
  /** Present when this is NOT a failure but a missing precondition the user can supply — a dead
   *  login, a disconnected extension. Text alone cannot change any of those; a button can. The
   *  copy-diagnostic button stays regardless: being fixable does not make it un-reportable. */
  action?: { text: string; onAct: () => void }
}

/** Compose the full diagnostic blob: caller context + browser context + optional detail. */
function diagnostic(w: WarningEntry, context?: Record<string, string>): string {
  const lines = [`label:   ${w.label}`, `message: ${w.message}`]
  for (const [k, v] of Object.entries(context ?? {})) lines.push(`${k}: ${v}`)
  lines.push(`where:   ${location.href}`, `ua:      ${navigator.userAgent}`)
  const front = lines.join('\n')
  return w.detail ? `${front}\n\n--- detail ---\n${w.detail}` : front
}

function WarningRow({ w, context }: { w: WarningEntry; context?: Record<string, string> }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostic(w, context))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — nothing to do */
    }
  }
  return (
    <div className="flex items-start gap-2 rounded-[9px] border border-[var(--acr-border-soft)] bg-[var(--acr-card-nested)] px-3 py-2">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium">{w.label}</div>
        <div className="break-words text-[11px] leading-4 text-muted-foreground">{w.message}</div>
      </div>
      {w.action ? (
        <Button variant="default" size="mini" onClick={w.action.onAct}>
          {w.action.text}
        </Button>
      ) : null}
      <Button variant="ghost" size="mini" disabled={copied} aria-label={`复制 ${w.label} 的错误详情`} onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? '已复制' : '复制'}
      </Button>
    </div>
  )
}

export function Warnings({ warnings, context }: { warnings: WarningEntry[]; context?: Record<string, string> }) {
  if (!warnings.length) return null
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {warnings.map((w) => (
        <WarningRow key={w.label} w={w} context={context} />
      ))}
    </div>
  )
}
