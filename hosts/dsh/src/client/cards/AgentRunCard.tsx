/**
 * `get_agent_run` —— 一次异步 run 的读口。**purchase 档**（`purchase_decide` 起的）在这里落成对比卡：
 * 跑着时画阶段进度（枚举 → 读横评 → 比价 → 斩杀，哪一步在走），跑完把 `receipt` 交给
 * `ReceiptView`（和 `purchase_decide` 同一张表，不做第二张会漂移的）。
 *
 * 发现档（search_agent / enumerate_candidates）不在这里画：它们的轨迹 DSH 自己有视图，
 * 这里只摆原文回落。
 */
import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readToolCall, asRecord } from '../../tool-result.ts'
import { Badge, Card, FallbackText, Muted } from './frame.tsx'
import { ReceiptView } from './PurchaseDecideCard.tsx'

interface Stage { note: string; at?: string | undefined }

function readStages(v: unknown): Stage[] {
  if (!Array.isArray(v)) return []
  return v
    .map((s) => asRecord(s))
    .filter((s): s is Record<string, unknown> => s !== null && typeof s.note === 'string')
    .map((s) => ({ note: s.note as string, at: typeof s.at === 'string' ? s.at : undefined }))
}

export function AgentRunCard({ block }: { block: ToolCallBlock }): ReactNode {
  const call = readToolCall(block)
  if (call.running) return <Card title="读取运行" badge={<Badge text="进行中" />}>{null}</Card>
  const data = asRecord(call.data)
  if (data === null || data.domain !== 'purchase') {
    return (
      <Card title="运行记录" badge={call.isError ? <Badge text="失败" tone="error" /> : undefined}>
        <FallbackText text={call.text} />
      </Card>
    )
  }
  const status = typeof data.status === 'string' ? data.status : 'unknown'
  if (status === 'done') return <ReceiptView data={data.receipt} text={call.text} isError={call.isError} />

  const stages = readStages(data.stages)
  if (status === 'error') {
    return (
      <Card title="选品对比" badge={<Badge text="失败" tone="error" />}>
        <Muted>{typeof data.error === 'string' ? data.error : '决策 job 中途挂了'}</Muted>
        {stages.length > 0 ? <Muted>走到：{stages[stages.length - 1]!.note}</Muted> : null}
      </Card>
    )
  }
  // running / queued：把阶段一条条摆出来——超时之后至少知道卡在哪一步。
  return (
    <Card title="选品对比" badge={<Badge text="进行中" />}>
      <div data-stream-stages="" style={{ display: 'flex', flexDirection: 'column', fontSize: 12, gap: 2 }}>
        {stages.length === 0 ? <Muted>排队中…</Muted> : null}
        {stages.map((s, i) => (
          <span key={i}>
            {i === stages.length - 1 ? '▶ ' : '✓ '}
            {i === stages.length - 1 ? <strong>{s.note}</strong> : <Muted>{s.note}</Muted>}
          </span>
        ))}
      </div>
    </Card>
  )
}
