/**
 * `get_events` —— 后端事件（通知中心的拉取口）。每条 `{id,type,at,title,body?,severity,ref?}`
 * （`src/events/store.ts`）。
 *
 * 深链：只有 `ref.kind === 'stream'` 那种能落到一个验证过的路由（`/c/<id>`）。
 * `ref.kind === 'item'` **不发链接**——Stream 前端点这类通知走的是应用内事件
 * （`NotificationBell.tsx` 的 `open-artifact`），地址栏里没有对应的 item 路由。
 * `facility` 同理（重登面板是应用内抽屉）。
 */
import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readToolCall, asRecord, asList } from '../../tool-result.ts'
import { channelUrl } from '../../deep-links.ts'
import { Badge, Card, DeepLink, FallbackText, Muted } from './frame.tsx'

const MAX_ROWS = 10

/** severity 高的那档标红，其余走默认色。 */
function severityTone(severity: unknown): 'muted' | 'error' {
  return severity === 'error' ? 'error' : 'muted'
}

export function EventsCard({ block }: { block: ToolCallBlock }): ReactNode {
  const call = readToolCall(block)
  if (call.running) return <Card title="通知" badge={<Badge text="进行中" />}>{null}</Card>

  const rows = asList(call.data, 'events')
  if (rows.length === 0) {
    const parsed = Array.isArray(call.data) || Array.isArray(asRecord(call.data)?.events)
    return (
      <Card title="通知" badge={call.isError ? <Badge text="失败" tone="error" /> : undefined}>
        {parsed && !call.isError ? <Muted>没有新通知</Muted> : <FallbackText text={call.text} />}
      </Card>
    )
  }

  const shown = rows.slice(0, MAX_ROWS)
  return (
    <Card title="通知" badge={<Badge text={`${rows.length} 条`} />}>
      {shown.map((raw, i) => {
        const e = asRecord(raw) ?? {}
        const type = typeof e.type === 'string' ? e.type : '事件'
        const title = typeof e.title === 'string' && e.title !== '' ? e.title : type
        const ref = asRecord(e.ref)
        const streamRef = ref?.kind === 'stream' && typeof ref.id === 'string' ? ref.id : undefined
        return (
          <div key={typeof e.id === 'number' || typeof e.id === 'string' ? String(e.id) : i} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ alignItems: 'center', display: 'flex', gap: 6 }}>
              <Badge text={type} tone={severityTone(e.severity)} />
              <span style={{ fontSize: 13 }}>{title}</span>
            </span>
            {typeof e.body === 'string' && e.body !== '' ? <Muted>{e.body}</Muted> : null}
            {streamRef !== undefined ? <DeepLink href={channelUrl(streamRef)}>在 Stream 打开这个频道 →</DeepLink> : null}
          </div>
        )
      })}
      {rows.length > shown.length ? <Muted>{`还有 ${rows.length - shown.length} 条`}</Muted> : null}
    </Card>
  )
}
