import type { ReactNode } from 'react'
import { CopyIcon } from 'lucide-react'
import { toast } from './acrylic/sonner.tsx'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card.tsx'
import type { FailureCategory, SourceHealthError } from '../lib/types.ts'

// Human-readable failure classes (mirrors backend src/failure.ts categories).
const CATEGORY_LABEL: Record<FailureCategory, string> = {
  drift: '源结构变化',
  auth: '登录失效',
  timeout: '超时',
  network: '网络错误',
  blocked: '被拦截/限流',
  empty: '持续无内容',
  unknown: '未知错误',
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** One-shot copy blob — pasteable into a bug report or log search. */
function copyText(err: SourceHealthError, sourceLabel: string | undefined, stateLabel: string): string {
  return [
    sourceLabel ? `来源: ${sourceLabel}` : null,
    `状态: ${stateLabel}`,
    `类别: ${CATEGORY_LABEL[err.category]} (${err.category})`,
    `时间: ${fmtTime(err.at)}`,
    `错误: ${err.message}`,
  ].filter(Boolean).join('\n')
}

/** The plain at-a-glance status dot. `colorClass` + `label` are resolved by the caller so
 *  each page keeps its own health vocabulary and palette. The failure detail lives in the
 *  row-level hover card (`SourceHealthHover`), not here — a dead Source is unusable as a
 *  whole, so the whole row is the affordance, not this 8px dot. */
export function SourceHealthDot({ colorClass, label }: { colorClass: string; label: string }) {
  return <span title={label} className={`inline-block size-2 shrink-0 rounded-full ${colorClass}`} />
}

/**
 * Wraps a whole Source row. No `error` → renders the row unchanged. With an `error`, the
 * entire row becomes a hover-card trigger (hover anywhere on it) revealing the failure
 * reason (category), message, time, and a one-click copy button.
 */
export function SourceHealthHover({
  error,
  sourceLabel,
  stateLabel,
  children,
}: {
  error?: SourceHealthError
  sourceLabel?: string
  stateLabel: string
  children: ReactNode
}) {
  if (!error) return <>{children}</>

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(error, sourceLabel, stateLabel))
      toast.success('已复制错误信息')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div className="w-full cursor-help">{children}</div>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium">
              {CATEGORY_LABEL[error.category]}
              <span className="ml-1 text-muted-foreground">· {stateLabel}</span>
            </span>
            <button
              type="button"
              onClick={onCopy}
              title="复制错误信息"
              className="inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-[var(--acr-border-soft)] hover:text-foreground"
            >
              <CopyIcon className="size-3" />
              复制
            </button>
          </div>
          <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
            {error.message}
          </p>
          <p className="text-[10px] text-muted-foreground">{fmtTime(error.at)}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
