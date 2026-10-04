// src/live/watch.ts — live 源的变更信号器（spec §一）。
//
// 推的是「变了」这个事实，不是数据本身：{type:'live-changed', streamId} 只有几十字节，
// 走无主题全量广播也无所谓，前端拿到后自己判断当前打开的是不是这个频道。
// 等实时行情真要推增量时再上主题订阅——那时才有需求撑着。
//
// 变更信号器对 live 源是**可选的**：没有它就退化成「打开页面时查一次」。
import { watch as nodeWatch } from 'node:fs'
import { listRunIds } from '../board/run-source.ts'

export interface WatchOpts {
  dir: string
  streamId: string
  /** 一个 run 会连写好几个文件，去抖把它们并成一次。 */
  debounceMs?: number
  onChanged(streamId: string): void
  onNewRun(runId: string): void
  watch?: typeof nodeWatch
  listRuns?: (dir: string) => string[]
}

export function watchArtifactsDir(opts: WatchOpts): () => void {
  const watch = opts.watch ?? nodeWatch
  const listRuns = opts.listRuns ?? listRunIds
  const debounceMs = opts.debounceMs ?? 300
  const seen = new Set<string>(safeList(listRuns, opts.dir))
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    timer = undefined
    for (const id of safeList(listRuns, opts.dir)) {
      if (!seen.has(id)) { seen.add(id); opts.onNewRun(id) }
    }
    opts.onChanged(opts.streamId)
  }

  const watcher = watch(opts.dir, { recursive: true }, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  })

  return () => {
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}

/** 目录一时读不到（正在被换、权限变了）不该把 watcher 打死——信号通道没资格掀翻主链路。 */
function safeList(listRuns: (dir: string) => string[], dir: string): string[] {
  try { return listRuns(dir) } catch { return [] }
}
