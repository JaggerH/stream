/**
 * 一条排期的三行说明：**人话在上、原始表达式在下、接下来三次在旁边**。
 *
 * 卡片和排期编辑器共用同一份——两处各画各的，迟早会出现「卡上说每 5 分钟、编辑器里说每 5 秒」
 * 这种谁也发现不了的漂移。
 */
import type { ReactElement } from 'react'
import { describeCronOrNull, nextRuns } from '../../lib/cronFriendly.ts'

function fmtClock(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 「还有多久」——人对 `14:55` 的反应远不如对「还有 12 分钟」快。 */
export function fmtRelative(target: number, now: number): string {
  const s = Math.round((target - now) / 1000)
  const abs = Math.abs(s)
  const unit = abs < 60 ? `${abs} 秒`
    : abs < 3600 ? `${Math.round(abs / 60)} 分钟`
      : abs < 86400 ? `${Math.round(abs / 3600)} 小时`
        : `${Math.round(abs / 86400)} 天`
  return s >= 0 ? `${unit}后` : `${unit}前`
}

/** 排期那一行的人话；认不出就是 null，由调用方决定怎么退。 */
export function scheduleSentence(schedule: string, timezone?: string): string | null {
  const s = describeCronOrNull(schedule)
  return s === null ? null : timezone ? `${s}（${timezone}）` : s
}

/**
 * @param bare - 去掉「下次」这个前缀词。**给表格用**：列头已经写着「下次」，格子里再说一遍
 *   是纯噪音，而且那三个字挤掉的正是右边「（还有多久）」的位置，逼它折行——一列里有的行
 *   一行、有的行两行，整张表就参差了。散在页面上（排期编辑器、展开层）时前缀必须留着，
 *   那里没有列头替它说话。
 */
export function NextRuns({
  schedule, timezone, count = 3, now = Date.now(), testId, bare = false,
}: { schedule: string; timezone?: string; count?: number; now?: number; testId?: string; bare?: boolean }): ReactElement {
  const runs = nextRuns(schedule, { from: new Date(now), count, timeZone: timezone })
  const prefix = bare ? '' : '下次：'
  // null = 这次**算不出来**（跨时区、或日与周几同时限定，见 cronFriendly.ts 头注），
  // 空数组 = 有解但永不触发（`0 0 0 30 2 *`）。两件事不能都画成一片空白：前者要说清
  // 为什么不算，后者是一条该被删掉的任务。
  if (runs === null) {
    const full = `${prefix}按 ${timezone} 计算，本机算不出来`
    // 表格档给短句：整句在 196px 的列里必被截断，而"截断的解释"等于没解释。短句 + `title`
    // 全文，展开层里还有一份不截断的（非 bare）。
    return (
      <div data-testid={testId} title={full} className="truncate text-[12px] text-muted-foreground">
        {bare ? `算不出来（${timezone}）` : full}
      </div>
    )
  }
  if (runs.length === 0) {
    const text = `${prefix}永不触发——这条排期没有任何匹配的时刻`
    return <div data-testid={testId} title={text} className="truncate text-[12px] text-destructive">{text}</div>
  }
  return (
    // bare（表格档）**不许折行**：这一列的内容宽度贴着列宽（实测 164px vs 162px 可用），
    // 允许折行的结果是同一列里一部分行 37px、一部分行 53px，整张表看着就是坏的。
    // 宁可让它溢出被裁掉（时刻在前，先裁掉的是括号里的相对时间），也不要参差不齐的行高。
    <div
      data-testid={testId}
      className={`flex items-baseline gap-x-2 text-[12px] text-muted-foreground ${bare ? 'overflow-hidden' : 'flex-wrap gap-y-0.5'}`}
    >
      {!bare && <span>下次</span>}
      <span className="shrink-0 text-foreground">{fmtClock(runs[0]!)}</span>
      <span className={bare ? 'truncate' : undefined}>（{fmtRelative(runs[0]!.getTime(), now)}）</span>
      {runs.length > 1 && (
        <span className="opacity-70">此后 {runs.slice(1).map(fmtClock).join(' · ')}</span>
      )}
    </div>
  )
}
