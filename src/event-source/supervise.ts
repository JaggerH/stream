/**
 * 后端对外部事件源子进程的监督：spawn → onExit → 退避 respawn → dispose。
 *
 * 镜像 `capabilities/desktop/src/host-agent/agent.ts` 的 `startAgent`（同一套 spawn/退避/
 * dispose 骨架），扩展点是 adopt：spawn 前先看 `deps.lockHeld()`——上一个子进程还活着
 * （它持着单例锁，见 `worker/main.ts`）就不 spawn，只等它自己经 relay 重连，重启期不会
 * 起出第二个子进程抢同一份 Outbox/锁。
 */
export interface WorkerProcess {
  onExit(cb: (code: number | null) => void): void
  kill(): void
}
export interface SuperviseDeps {
  spawn(entry: string, env: Record<string, string>): WorkerProcess
  /** 上一个子进程是否还活着（它持着单例锁）。真 → 认领，不 spawn。 */
  lockHeld(): boolean
  now(): number
  setTimer(fn: () => void, ms: number): () => void
}
const defaultBackoff = (n: number) => Math.min(500 * 2 ** Math.min(n, 5), 10_000)

/**
 * 起子进程并一直看着它。
 * @returns dispose：杀子进程、取消待跑的重启，且此后不再 spawn。
 */
export function superviseWorker(
  deps: SuperviseDeps,
  opts: { entry: string; env: Record<string, string>; backoffMs?: (n: number) => number },
): () => void {
  const backoff = opts.backoffMs ?? defaultBackoff
  let disposed = false
  let cancelTimer: (() => void) | undefined
  let current: WorkerProcess | undefined
  let attempt = 0

  function start() {
    if (disposed) return
    if (deps.lockHeld()) return // adopt：上一个还活着，等它重连
    const p = deps.spawn(opts.entry, opts.env)
    current = p
    p.onExit(() => {
      if (disposed) return
      current = undefined
      cancelTimer = deps.setTimer(() => {
        cancelTimer = undefined
        start()
      }, backoff(attempt++))
    })
  }
  start()

  return function dispose() {
    disposed = true
    cancelTimer?.()
    current?.kill()
  }
}
