import type { StreamItem } from '../types.ts'
import type { StoryFoldStore } from './store.ts'
import { indexRowOf } from './inbox.ts'

/**
 * 采集入库之后那一跳。**它现在只做两件事：记候选信号、排进待判队列。**
 *
 * 判据本身（比文本，必要时先转写）搬到了后台（`./worker.ts`）——转写实测平均 16 秒、
 * 最慢 142 秒，挂在采集热路径上是不可接受的。这一跳仍然要有，因为**只有它知道
 * "刚入库了哪些"**；但它现在纯粹是记账，不下任何结论。
 *
 * 三条硬约束照旧：不联网、不算重活、绝不外溢（异常吞掉，入库已经完成，不该被拖下水）。
 */

export interface StoryFoldRecorderOpts {
  store: StoryFoldStore
  /** 排完队叫一声，让后台 worker 醒过来干活（不传 = 等它自己下一轮）。 */
  onQueued?: () => void
}

export class StoryFoldRecorder {
  constructor(private readonly opts: StoryFoldRecorderOpts) {}

  /** 刚入库的一批：记指纹信号 + 排队。**永不抛**。 */
  record(items: StreamItem[]): void {
    let queued = 0
    for (const item of items) {
      try {
        this.opts.store.index(indexRowOf(item))
        this.opts.store.enqueue(item.id)
        queued++
      } catch (e) {
        console.error('[story-fold] 记账失败（不影响入库）:', (e as Error).message)
      }
    }
    if (queued > 0) this.opts.onQueued?.()
  }
}
