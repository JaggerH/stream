/**
 * `content_search` —— 在用户已配置的可搜索源里取内容。产出是一批 `StoredItem`
 * （`src/item-store.ts` → `src/types.ts` 的 `StreamItem`：id/title/url/author/timestamp/stream_id）。
 *
 * 深链两种，都是验证过的：卡头去 `/search`（这批结果在 Stream 里落的就是内容搜索频道），
 * 每行去 `/c/<stream_id>`（该条所属的具名频道）。条目本身的 `url` 是**站外**原文，另开一条。
 */
import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readToolCall, asRecord, asList } from '../../tool-result.ts'
import { channelUrl, contentSearchUrl } from '../../deep-links.ts'
import { Badge, Card, DeepLink, FallbackText, Muted } from './frame.tsx'

/** 一次搜索能回几十条；对话里摊开超过这个数就成了刷屏。 */
const MAX_ROWS = 8

export function ContentSearchCard({ block }: { block: ToolCallBlock }): ReactNode {
  const call = readToolCall(block)
  const query = typeof call.args?.query === 'string' ? call.args.query : undefined
  const title = query !== undefined ? `内容搜索：${query}` : '内容搜索'

  if (call.running) return <Card title={title} badge={<Badge text="进行中" />}>{null}</Card>

  const items = asList(call.data, 'items')
  if (items.length === 0) {
    // 空结果和「读不出来」是两件事：数据确实是个数组就说没搜到，否则摆原文。
    const parsed = Array.isArray(call.data) || Array.isArray(asRecord(call.data)?.items)
    return (
      <Card title={title} badge={call.isError ? <Badge text="失败" tone="error" /> : undefined}>
        {parsed && !call.isError ? <Muted>没有结果</Muted> : <FallbackText text={call.text} />}
      </Card>
    )
  }

  const shown = items.slice(0, MAX_ROWS)
  return (
    <Card title={title} badge={<Badge text={`${items.length} 条`} />}>
      {shown.map((raw, i) => {
        const it = asRecord(raw) ?? {}
        const itemTitle = typeof it.title === 'string' && it.title !== '' ? it.title : '(无标题)'
        const url = typeof it.url === 'string' && it.url !== '' ? it.url : undefined
        const streamId = typeof it.stream_id === 'string' && it.stream_id !== '' ? it.stream_id : undefined
        const author = typeof it.author === 'string' && it.author !== '' ? it.author : undefined
        const at = typeof it.timestamp === 'string' && it.timestamp !== '' ? it.timestamp.slice(0, 10) : undefined
        const meta = [author, at].filter((s): s is string => s !== undefined)
        return (
          <div key={typeof it.id === 'string' ? it.id : i} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {url !== undefined ? (
              <DeepLink href={url}>{itemTitle}</DeepLink>
            ) : (
              <span style={{ fontSize: 13 }}>{itemTitle}</span>
            )}
            <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
              {meta.length > 0 ? <Muted>{meta.join(' · ')}</Muted> : null}
              {streamId !== undefined ? <DeepLink href={channelUrl(streamId)}>在 Stream 打开</DeepLink> : null}
            </span>
          </div>
        )
      })}
      {items.length > shown.length ? <Muted>{`还有 ${items.length - shown.length} 条`}</Muted> : null}
      <DeepLink href={contentSearchUrl()}>去 Stream 的内容搜索页 →</DeepLink>
    </Card>
  )
}
