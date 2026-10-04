/**
 * `stream_subscribe` —— 订阅一个 Stream。产出是一句确认（`{subscribed: <id>}`，见
 * `src/mcp/server.ts` 的 bespoke 注册），值得渲染的东西大半在**调用参数**里：订了什么、
 * 几秒刷一次、由哪几个源供货。
 *
 * 深链：`/c/<id>` —— 已验证的具名频道路由（`app/src/lib/route.ts` 的 `c` 分支）。
 */
import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readToolCall, str } from '../../tool-result.ts'
import { channelUrl } from '../../deep-links.ts'
import { Badge, Card, DeepLink, FallbackText, Muted } from './frame.tsx'

export function SubscribeCard({ block }: { block: ToolCallBlock }): ReactNode {
  const call = readToolCall(block)
  const args = call.args
  const argId = typeof args?.id === 'string' ? args.id : undefined
  const description = typeof args?.description === 'string' ? args.description : undefined
  const cadence = typeof args?.cadence_seconds === 'number' ? args.cadence_seconds : undefined
  const sources = Array.isArray(args?.sources) ? (args.sources as unknown[]).length : undefined

  if (call.running) return <Card title="订阅" badge={<Badge text="进行中" />}>{argId !== undefined ? <Muted>{argId}</Muted> : null}</Card>

  const id = str(call.data, 'subscribed') ?? argId
  if (id === undefined) {
    return (
      <Card title="订阅" badge={call.isError ? <Badge text="失败" tone="error" /> : undefined}>
        <FallbackText text={call.text} />
      </Card>
    )
  }

  const meta = [
    cadence !== undefined ? `每 ${cadence} 秒刷新` : undefined,
    sources !== undefined ? `${sources} 个源` : undefined,
  ].filter((s): s is string => s !== undefined)

  return (
    <Card title="订阅" badge={call.isError ? <Badge text="失败" tone="error" /> : <Badge text="已订阅" />}>
      <div style={{ fontSize: 13 }}>{description ?? id}</div>
      {meta.length > 0 ? <Muted>{meta.join(' · ')}</Muted> : null}
      <DeepLink href={channelUrl(id)}>在 Stream 打开这个频道 →</DeepLink>
    </Card>
  )
}
