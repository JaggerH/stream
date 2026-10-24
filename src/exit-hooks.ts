/**
 * 「进程要走了，先把这些收掉」的登记处（今天只有 facility 锁文件用它）。
 *
 * 两种挂法：
 * - **挂在进程上**（`createExitHooks(process)`）：第一次登记时在 SIGINT / SIGTERM / SIGHUP / exit 上各挂一个
 *   `once`，到时把登记的全跑一遍。这是 CLI（authoring）与 `stream serve` 的 runtime 用的那一档。
 * - **不挂进程**（`createExitHooks()`）：只在 `runAll()` 时跑——库入口的 runtime 在 `close()` 时叫它。库入口不注册
 *   进程信号（openspec `embeddable-engine` D1），宿主自己的信号处理里关实例就行。
 */
export interface ExitHooks {
  /** 登记一个收尾（同步、幂等的那种：删个锁文件）。回撤销函数。 */
  add(fn: () => void): () => void
  /** 把还登记着的全跑一遍并清空。一个失败不拖住其余的。 */
  runAll(): void
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export function createExitHooks(target?: Pick<NodeJS.Process, 'once'>): ExitHooks {
  const fns = new Set<() => void>()
  let installed = false
  const runAll = () => {
    for (const fn of [...fns]) {
      fns.delete(fn)
      try { fn() } catch { /* 收尾失败不该挡住其余的 */ }
    }
  }
  return {
    add(fn) {
      fns.add(fn)
      if (target && !installed) {
        installed = true
        for (const sig of SIGNALS) target.once(sig, runAll)
        target.once('exit', runAll)
      }
      return () => { fns.delete(fn) }
    },
    runAll,
  }
}

/** 没递 runtime 的调用方（authoring CLI）用的那一份：挂在真进程上，懒建。 */
let processHooks: ExitHooks | undefined
export function processExitHooks(): ExitHooks {
  processHooks ??= createExitHooks(process)
  return processHooks
}
