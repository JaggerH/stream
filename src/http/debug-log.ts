/** Generic in-app debug bus for the frontend DebugBox. Any flow (audio resolve, download,
 *  video resolve, …) pushes a DebugEntry here; the backend broadcasts it over the WS and keeps
 *  a capped ring so a box opened mid-flow can reconcile via GET /api/debug/log. Debug-only, not
 *  persisted. The renderer is domain-agnostic: it shows `summary` + `fields`, so a new channel
 *  just has to produce entries — nothing else to teach the UI. Entry shapes live in src/debug.ts
 *  (re-exported here) so producers import them without a cross-layer dependency. */
import type { DebugEntry } from '../debug.ts'

export type { DebugTone, DebugField, DebugEntry } from '../debug.ts'

/** Fixed-capacity ring of the most recent entries across all channels (newest last).
 *
 *  `sink` 是**落盘的那一份**（`debug-sink.ts`）：环是 200 条、跨全频道共用、进程一重启就清空，
 *  所以任何「等撞一次现场」的排查都不能只靠它。这里**无条件**把每条转给 sink——"哪些值得留档"
 *  的判据只有 sink 里那一份，别在这里再判一次（两份判据一定会分家）。 */
export class DebugLog {
  private entries: DebugEntry[] = []

  constructor(
    private readonly capacity = 200,
    private readonly sink?: (entry: DebugEntry) => void,
  ) {}

  put(entry: DebugEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    this.sink?.(entry)
  }

  /** Drop every entry (the debug box's "清空" button). */
  clear(): void {
    this.entries = []
  }

  /** Most-recent-first, optionally filtered by channel/key. */
  recent(opts: { channel?: string; key?: string; limit?: number } = {}): DebugEntry[] {
    let list = this.entries
    if (opts.channel) list = list.filter((e) => e.channel === opts.channel)
    if (opts.key) list = list.filter((e) => e.key === opts.key)
    const limit = opts.limit ?? 50
    return list.slice(-limit).reverse()
  }
}
