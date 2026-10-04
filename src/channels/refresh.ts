// src/channels/refresh.ts
//
// 频道级「重新抓取」：把一次点击扇出成该频道全部成员流的真实 tick。
//
// 为什么这一层在服务端而不是让前端连发 N 个请求：扇出策略（并发上限、部分失败怎么算、
// 结果怎么汇总）是一件事，放前端等于每个调用方各写一遍，而且第一个写的人就会写成
// `Promise.all` 无上限——采集是重活（有的还要骑那个唯一的浏览器），7 个流一起冲能把内存打穿。

/** 单个成员流的结果。`error` 在场 = 这条没抓成，其余字段缺席。 */
export interface StreamRefreshOutcome {
  streamId: string
  fetched?: number
  written?: number
  error?: string
}

export interface ChannelRefreshResult {
  /** 按**成员顺序**排列（不是完成顺序）——调用方要能对着频道里的流列表逐行读。 */
  streams: StreamRefreshOutcome[]
  /** 成功那些流的合计。 */
  fetched: number
  written: number
  /** 失败的流数。部分失败是常态（某个 facility 掉登录态），不该让整次刷新算失败。 */
  failed: number
}

/** 采集是重活，默认保守。调大之前先想清楚：有的流骑的是同一个真浏览器，抢不动。 */
const DEFAULT_CONCURRENCY = 3

export async function refreshStreams(
  streamIds: string[],
  refresh: (streamId: string) => Promise<{ fetched: number; written: number }>,
  opts: { concurrency?: number } = {}
): Promise<ChannelRefreshResult> {
  const ids = [...new Set(streamIds)] // 同一个流在频道里出现两次，不该抓两遍
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const outcomes: StreamRefreshOutcome[] = new Array(ids.length)

  // 固定大小的工人从共享游标取活儿：完成顺序随快慢变，但结果按下标回填，所以对外仍是成员顺序。
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= ids.length) return
      const streamId = ids[i]!
      try {
        const { fetched, written } = await refresh(streamId)
        outcomes[i] = { streamId, fetched, written }
      } catch (e) {
        // 抓不成的流如实记一行就够了——调用方据此告诉用户"哪几条没成"，而不是整次报错。
        outcomes[i] = { streamId, error: (e as Error)?.message ?? String(e) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, () => worker()))

  return {
    streams: outcomes,
    fetched: outcomes.reduce((n, o) => n + (o.fetched ?? 0), 0),
    written: outcomes.reduce((n, o) => n + (o.written ?? 0), 0),
    failed: outcomes.filter((o) => o.error !== undefined).length,
  }
}
