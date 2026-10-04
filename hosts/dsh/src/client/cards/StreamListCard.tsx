/**
 * `stream_list` —— 列出已订阅的 Stream。产出是 `{id, description}[]`
 * （`src/mcp/tools.ts` 的 `StreamSummary`）。
 *
 * 深链：每行 `/c/<id>`（验证过的具名频道路由）。这是这张表存在的全部理由——一屏订阅里
 * 用户最常做的动作就是点进去看。
 */
import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readToolCall, asRecord, asList } from '../../tool-result.ts'
import { channelUrl, timelineUrl } from '../../deep-links.ts'
import { Badge, Card, DeepLink, FallbackText, Muted } from './frame.tsx'

/** 订阅可以有几百条；卡里只摊这么多，其余给个计数。 */
const MAX_ROWS = 12

export function StreamListCard({ block }: { block: ToolCallBlock }): ReactNode {
  const call = readToolCall(block)
  if (call.running) return <Card title="订阅清单" badge={<Badge text="进行中" />}>{null}</Card>

  const rows = asList(call.data, 'streams')
  if (rows.length === 0) {
    const parsed = Array.isArray(call.data) || Array.isArray(asRecord(call.data)?.streams)
    return (
      <Card title="订阅清单" badge={call.isError ? <Badge text="失败" tone="error" /> : undefined}>
        {parsed && !call.isError ? <Muted>还没有订阅</Muted> : <FallbackText text={call.text} />}
      </Card>
    )
  }

  const shown = rows.slice(0, MAX_ROWS)
  return (
    <Card title="订阅清单" badge={<Badge text={`${rows.length} 个`} />}>
      {shown.map((raw, i) => {
        const s = asRecord(raw) ?? {}
        const id = typeof s.id === 'string' && s.id !== '' ? s.id : undefined
        const description = typeof s.description === 'string' && s.description !== '' ? s.description : id
        if (id === undefined) return null
        return (
          <div key={id ?? i} style={{ alignItems: 'baseline', display: 'flex', gap: 8, minWidth: 0 }}>
            <DeepLink href={channelUrl(id)}>{description ?? id}</DeepLink>
            {description !== id ? <Muted>{id}</Muted> : null}
          </div>
        )
      })}
      {rows.length > shown.length ? <Muted>{`还有 ${rows.length - shown.length} 个`}</Muted> : null}
      <DeepLink href={timelineUrl()}>去 Stream 的时间线 →</DeepLink>
    </Card>
  )
}
