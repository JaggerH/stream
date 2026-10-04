import type { DiagnosticSession } from './types.ts'

/** 10 秒一条 × 60 分钟 = 360。spec：保留最近 60 分钟。 */
export const SAMPLE_CAP = 360
/** spec：最多保留最近 200 条即时事件。 */
export const EVENT_CAP = 200
/**
 * 保留的会话数：当前 1 个 + 历史 2 个。
 *
 * 上限**按会话**施加，不是全局 —— 全局共享上限会让新会话的样本挤掉上次崩溃会话的
 * 证据，而那恰恰是本功能唯一要保住的东西。会话数则用这个上限兜住 1MB 数据库预算。
 */
export const SESSION_CAP = 3

/** 保留最新的 `max` 条，丢最旧的。OOM 前最后那几分钟才是证据。 */
export function trimToCapacity<T>(entries: T[], max: number): T[] {
  return entries.length <= max ? entries : entries.slice(entries.length - max)
}

/** 淘汰优先级：`ended` 是例行记录，先丢；`suspected-abnormal` 是崩溃证据，后丢。 */
const dropRank = (s: DiagnosticSession): number => (s.status === 'ended' ? 0 : 1)

/**
 * 超过 `keep` 个会话时，该丢哪些（返回 id）。`running` 永不丢 —— 那是当前正在写入的这一个。
 *
 * 两条规则都是真机测出来的，缺一个就会把崩溃证据自己删掉：
 *
 * 1. **按 `lastWriteAt` 排，不是 `startedAt`。** 一个播了 70 分钟才崩的会话，`startedAt`
 *    恰恰是全场最早的 —— 按开始时间排就成了「最旧」的头号淘汰对象。真正的新旧看它
 *    最后一次还在写是什么时候。
 * 2. **先丢 `ended`，再丢 `suspected-abnormal`。** 崩溃后用户可能先刷新几次才想起来去
 *    导出；若只按时间排，那几次例行重开就把唯一的证据冲掉了。
 *
 * 症状:崩溃 → 重开页面 → recoverAbnormal 刚把它标成疑似异常,startSession 转手就因为
 * 「它最老」把它清了 —— 用户还没点到导出,证据已经没了。
 */
export function sessionsToDrop(sessions: DiagnosticSession[], keep: number): string[] {
  const excess = sessions.length - keep
  if (excess <= 0) return []
  const droppable = sessions
    .filter((s) => s.status !== 'running')
    .sort((a, b) => dropRank(a) - dropRank(b) || a.lastWriteAt - b.lastWriteAt)
  return droppable.slice(0, excess).map((s) => s.id)
}
