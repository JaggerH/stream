import { streamRecordToStream } from './compat.ts'
import type { StreamRecord } from './types.ts'
import type { Stream } from '../streams/types.ts'

/** 判据那一端：`UserStore` 的两个方法。**别在这里写第二份 present 判断**——
 *  `isCollected` 背后就是开机装载用的 `collectedStreamIds()`，两条路必须同源。 */
export interface CollectionPolicyStore {
  isCollected(streamId: string): boolean
  getStream(streamId: string): StreamRecord | null
}

/** 动作那一端：`StreamService` 的资源面。结构化取用，测试可以塞个假的进来。 */
export interface CollectionPolicyScheduling {
  streamsResource(): Stream[]
  scheduleResourceStream(stream: Stream): void
  rescheduleResourceStream(stream: Stream): void
  unscheduleResourceStream(id: string): void
}

/**
 * 把这几条流的调度状态对齐到「该不该采集」。
 *
 * **不变量**：每条会改变「流—频道」关系或流调度的写入路径，都要跑一次这个函数——
 * POST /api/streams、POST/PATCH/DELETE /api/channels、`reconcile_open` 补下架来源。
 * 漏一处的症状是安静的：那条 live present（research/search）的流照常入库，一直采到进程重启，
 * 「不入库」于是只在开机那一刻成立，没有任何一处会喊。
 *
 * 判据只有一个出处：`UserStore.isCollected`（见那里的注释，含「未被引用的流算采集」这条
 * 刻意的默认）。**这里只施加，不判断**。
 *
 * 只对**状态真的要变**的那条流动手：`scheduleResourceStream` 会立刻跑一次 tick，
 * 每次 PATCH 都无条件调等于把改个频道名变成一次全量重抓。
 *
 * @param store - 频道/流库。`undefined`（没配频道库）→ 整体空操作。
 * @param service - 调度面。
 * @param streamIds - 这次动过的流（重复 id 只处理一次）。
 * @param opts.reschedule - 成员表 / cadence 变了：已在表里的也要 remove+add，
 *   否则调度器手里还是旧那份，新加的来源到重启前一次都不会被采。
 */
export function applyCollectionPolicy(
  store: CollectionPolicyStore | undefined,
  service: CollectionPolicyScheduling,
  streamIds: Iterable<string>,
  opts?: { reschedule?: boolean },
): void {
  if (!store) return
  const scheduled = new Set(service.streamsResource().map((s) => s.id))
  for (const id of new Set(streamIds)) {
    const want = store.isCollected(id)
    if (!want) {
      if (scheduled.has(id)) service.unscheduleResourceStream(id)
      continue
    }
    if (scheduled.has(id) && !opts?.reschedule) continue
    const rec = store.getStream(id)
    if (!rec) continue
    if (scheduled.has(id)) service.rescheduleResourceStream(streamRecordToStream(rec))
    else service.scheduleResourceStream(streamRecordToStream(rec))
  }
}
