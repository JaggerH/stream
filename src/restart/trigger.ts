import { reexecSelf, RESTART_EXIT_CODE, touchRestartSentinel, type RestartMode } from './policy.ts'

/** `serve.ts` 的优雅关：关停步骤对信号退出和重启是同一份，只有最后一步 `finale` 不同。 */
export type Shutdown = (finale: () => void, label: string) => Promise<void>

/**
 * `POST /api/restart` 的触发器。两条硬约束都在这里：
 *
 * 1. **先交出 mode，下一拍才开始关**——同步开始关会把 HTTP server 一起带走，202 就永远发不出去。
 * 2. **开机窗口要拒绝，不能崩**——HTTP 已在听、优雅关还没装好（`serve.ts` 里它装在 main() 末尾）
 *    的那几秒，一个 restart 请求若照样排进 setImmediate，会在那里撞 undefined → 未捕获异常 →
 *    进程以 1 退出，reexec 根本没发生。所以 `shutdown` 是**现取**的 thunk：取不到就 throw，
 *    路由的 onError 把它变成 500，进程还活着，用户过几秒再点一次就好。
 *
 * `watch` 档**不走 shutdown**：只碰哨兵，监视器（`tsx watch`）随即给这个进程发 SIGTERM，
 * 走的是正常的 SIGTERM 处理器 → 同一份优雅关 → 监视器再拉起一份。自己关自己反而坏事：
 * 监视器不看退出码，子进程一退它就干等下一次文件改动。
 */
export function makeRestartTrigger(deps: {
  mode: RestartMode
  /** 现取优雅关：还没装好 → undefined。 */
  shutdown: () => Shutdown | undefined
  schedule?: (fn: () => void) => void
  exit?: (code: number) => never
  reexec?: () => void
  /** `watch` 档碰哨兵的那只手；默认碰 `RESTART_SENTINEL`。 */
  touch?: () => void
  log?: (msg: string) => void
}): () => Promise<RestartMode> {
  const schedule = deps.schedule ?? ((fn) => { setImmediate(fn) })
  const exit = deps.exit ?? ((code) => process.exit(code))
  const reexec = deps.reexec ?? reexecSelf
  const touch = deps.touch ?? (() => touchRestartSentinel())
  const log = deps.log ?? ((m) => console.log(m))
  return async () => {
    const shutdown = deps.shutdown()
    if (!shutdown) throw new Error('backend still booting — retry in a moment')
    log(`[stream] restart requested → mode=${deps.mode}`)
    if (deps.mode === 'watch') {
      schedule(() => touch())
      return deps.mode
    }
    schedule(() => void shutdown(
      deps.mode === 'supervised'
        ? () => exit(RESTART_EXIT_CODE)
        : () => { reexec(); exit(0) },
      `restart(${deps.mode})`,
    ))
    return deps.mode
  }
}
