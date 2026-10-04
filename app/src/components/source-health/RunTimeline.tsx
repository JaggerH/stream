import type { ReactElement } from 'react'
import type { InterventionEvent } from '../../lib/api.interventions.ts'

/** 事件 `kind` 的人话。认不出的原样显示——编一个名字会把"这是新东西"这件事盖掉。 */
const EVENT_LABEL: Record<string, string> = {
  message: '说明', tool_call: '调用', tool_result: '回应', tool_failed: '工具失败',
  usage: '用量', proposal: '提议', cache_hit: '命中缓存', status_changed: '状态',
  permission_requested: '请求权限', permission_answered: '已答', heartbeat: '心跳',
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 原始事件流——「详情」抽屉里那份，给排查用。`heartbeat` 只留最后一条（逐条画会把真正的事件挤没）；
 * `tool_failed` 标红；agent 的 stderr（`message` 且 `data.stream === 'stderr'`）灰掉。
 */
export function RunTimeline({ events }: { events: InterventionEvent[] }): ReactElement {
  const lastHeartbeat = events.map((e) => e.kind).lastIndexOf('heartbeat')
  const visible = events.filter((e, i) => e.kind !== 'heartbeat' || i === lastHeartbeat)
  if (visible.length === 0) return <p className="text-[12px] text-muted-foreground">还没有事件。</p>
  return (
    <ol className="flex flex-col gap-1 text-[12px]">
      {visible.map((e) => {
        const stderr = e.kind === 'message' && (e.data as { stream?: string } | undefined)?.stream === 'stderr'
        return (
          <li key={e.seq} className={`flex gap-2 ${e.kind === 'tool_failed' ? 'text-destructive' : stderr ? 'text-muted-foreground/70' : ''}`}>
            <span className="w-14 shrink-0 tabular-nums text-muted-foreground">{timeOf(e.at)}</span>
            <span className="w-16 shrink-0 text-muted-foreground">{EVENT_LABEL[e.kind] ?? e.kind}</span>
            <span className="min-w-0 break-words">{e.title}</span>
          </li>
        )
      })}
    </ol>
  )
}
