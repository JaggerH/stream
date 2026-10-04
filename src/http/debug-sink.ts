/** 失败现场落盘：把 `ok:false` 的 DebugEntry append 成一行 JSON。
 *
 *  **为什么必须落盘**：debug bus 本身是一个 200 条、跨全部频道共用、进程重启即清空的内存环
 *  （`debug-log.ts`）。开发期 `tsx watch` 一天重载几十次，一轮采集就能把环冲干净——于是所有
 *  写着「观测已埋好，等撞一次现场」的排查（`Page.navigate` 偶发挂满 30s、插件容器重建后
 *  `pluginTarget` 答空、图床偶发 403）实际上**永远等不到**：探针写在一块几分钟就被抹掉的白板上。
 *  这类墙/竞态还都会自己好，现场不留下来就再也复现不了。
 *
 *  只收 `ok:false`：顺利那一路内存环已经够看，文件是**证据**不是流水账。读法就是 grep 这个文件
 *  （`<dataDir>/debug-failures.jsonl`，一行一条，最旧在上），轮转只留一代（`.jsonl.1`）。
 *
 *  **一字不差的重复条目会被折叠**（见 `DEDUPE_WINDOW_MS`）：常态噪音每分钟一条，几天就能把
 *  真正要等的偶发现场挤出轮转窗口——那样等于没留住证据，只是把"几分钟被清空"换成"几天被冲掉"。
 *
 *  绝不向调用方抛错：它挂在 debug bus 的 record 上，落盘失败也不许连累正在跑的那件事。
 */
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DebugEntry } from '../debug.ts'

export const FAILURE_FILE = 'debug-failures.jsonl'

/** 默认 4MB —— 撑得下几个月的失败条目，又不至于让人 grep 不动。 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * 折叠窗口：同一条**一字不差**的条目在窗口内只落第一条，其余记数、下一条落盘时随行带出
 * （`_repeated`）。10 分钟是照实测定的——voiceprint 的"容器睡着所以没地址"每分钟一条、
 * 连打 21 小时 1184 条内容完全相同（2026-08-23）；按 10 分钟折叠后同样的信息只占 126 行。
 *
 * **判据必须是"一字不差"（channel+key+summary+fields）**，不能放宽成 channel+key：真实现场的
 * summary 里带着耗时/状态码这类变量，几乎不可能撞重复；而放宽之后，同一 key 的第二次真现场
 * 会被前一条挡掉——那正是这个文件存在的理由。
 */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000

/** 折叠表的容量上限：只防内存无界（键是 channel|key|summary，正常也就几十个）。 */
const MAX_TRACKED_KEYS = 500

export function createFailureSink(
  dir: string,
  opts: { maxBytes?: number; dedupeWindowMs?: number; now?: () => number } = {},
): (entry: DebugEntry) => void {
  const path = join(dir, FAILURE_FILE)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const windowMs = opts.dedupeWindowMs ?? DEDUPE_WINDOW_MS
  const now = opts.now ?? Date.now
  /** key → 上次真正落盘的时刻 + 从那以后被折叠掉的条数 */
  const seen = new Map<string, { lastWriteAt: number; repeated: number }>()
  return (entry: DebugEntry) => {
    if (entry.ok !== false) return
    try {
      // `id` 与 `at` 每次都不同（`channel:key@时间戳`），必须排除在折叠键之外，否则永远不重复。
      const dedupeKey = `${entry.channel}|${entry.key}|${entry.summary}|${JSON.stringify(entry.fields)}`
      const t = now()
      const prev = seen.get(dedupeKey)
      if (prev && t - prev.lastWriteAt < windowMs) {
        prev.repeated++
        return
      }
      const repeated = prev?.repeated ?? 0
      if (seen.size >= MAX_TRACKED_KEYS && !prev) seen.clear()
      seen.set(dedupeKey, { lastWriteAt: t, repeated: 0 })
      // 轮转在写**之前**判：超了就把整份挪成 .1（覆盖上一代），新文件从这一条开始。只留一代
      // 是有意的——两代以上就得回答"该翻哪一份"，而这里要的只是"最近一段现场还在"。
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        /* 还没有这个文件 */
      }
      if (size >= maxBytes) renameSync(path, path + '.1')
      // `_repeated` 只出现在被折叠过的那几行：读的人看到它就知道"这条在上一段窗口里还出现了 N 次"，
      // 不写这个数就会把一条每分钟都在响的噪音误读成偶发。
      appendFileSync(path, JSON.stringify(repeated > 0 ? { ...entry, _repeated: repeated } : entry) + '\n')
    } catch {
      /* 落盘失败绝不连累调用方：这是旁路证据，不是主路 */
    }
  }
}
