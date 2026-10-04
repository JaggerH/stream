/**
 * `inbox_search` —— 在**已经采集进库**的条目里搜（`src/mcp/inbox-search.ts` 的瘦身投影：
 * id/stream_id/title/author/timestamp/url/excerpt）。
 *
 * 和 `ContentSearchCard` 长得像但**不是一件事**，所以是两张卡：那张是现搜（联网扇出、结果不
 * 落库），这张是用户自己的存量。卡头写清楚这一点，用户一眼能分出"这批是我订过的"。
 *
 * 深链两种：每行去站外原文 `url`，以及回 `/c/<stream_id>` 的具名频道。
 * `matched > returned` 时必须显式说"还有多少没显示"——那是回执里唯一说得清"你没看全"的一格。
 */
import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readToolCall, asRecord, asList } from '../../tool-result.ts'
import { channelUrl } from '../../deep-links.ts'
import { Badge, Card, DeepLink, FallbackText, Muted } from './frame.tsx'

/** 一次搜索能回上百条；对话里摊开超过这个数就成了刷屏。 */
const MAX_ROWS = 8

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function InboxSearchCard({ block }: { block: ToolCallBlock }): ReactNode {
  const call = readToolCall(block)
  const q = str(call.args?.q)
  const author = str(call.args?.author)
  const scope = [author, q].filter((s): s is string => s !== undefined).join(' · ')
  const title = scope !== '' ? `已采集内容：${scope}` : '已采集内容'

  if (call.running) return <Card title={title} badge={<Badge text="进行中" />}>{null}</Card>

  const items = asList(call.data, 'items')
  if (items.length === 0) {
    // 空结果和「读不出来」是两件事：数据确实是个数组就说没搜到，否则摆原文。
    const rec = asRecord(call.data)
    const parsed = Array.isArray(call.data) || Array.isArray(rec?.items)
    const note = str(rec?.note)
    return (
      <Card title={title} badge={call.isError ? <Badge text="失败" tone="error" /> : undefined}>
        {parsed && !call.isError ? <Muted>{note ?? '库里没有匹配的条目'}</Muted> : <FallbackText text={call.text} />}
      </Card>
    )
  }

  const matchedRaw = asRecord(call.data)?.matched
  const matched = typeof matchedRaw === 'number' ? matchedRaw : items.length
  const shown = items.slice(0, MAX_ROWS)
  return (
    <Card title={title} badge={<Badge text={matched > items.length ? `命中 ${matched} 条` : `${items.length} 条`} />}>
      {shown.map((raw, i) => {
        const it = asRecord(raw) ?? {}
        const itemTitle = str(it.title) ?? '(无标题)'
        const url = str(it.url)
        const streamId = str(it.stream_id)
        const at = str(it.timestamp)?.slice(0, 10)
        const meta = [str(it.author), at].filter((s): s is string => s !== undefined)
        const excerpt = str(it.excerpt)
        return (
          <div key={str(it.id) ?? i} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {url !== undefined ? <DeepLink href={url}>{itemTitle}</DeepLink> : <span style={{ fontSize: 13 }}>{itemTitle}</span>}
            {excerpt !== undefined ? <Muted>{excerpt}</Muted> : null}
            <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
              {meta.length > 0 ? <Muted>{meta.join(' · ')}</Muted> : null}
              {streamId !== undefined ? <DeepLink href={channelUrl(streamId)}>在 Stream 打开</DeepLink> : null}
            </span>
          </div>
        )
      })}
      {/* 「你没看全」必须写出来：回执里 matched 是唯一说得清这件事的一格。 */}
      {matched > shown.length ? <Muted>{`共命中 ${matched} 条，这里显示 ${shown.length} 条`}</Muted> : null}
    </Card>
  )
}
