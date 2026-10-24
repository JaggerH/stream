/**
 * 进程级共享资源（design D4）。一个进程只该有一份的东西收在这里，由调用方建一次、传给多个实例：
 *
 * - **RSSHub worker**（`rsshub`）：一个 worker 线程 +168MB RSS；共用 runtime 的实例共用它（也就共用 RSSHub 的
 *   凭证环境——见 `RsshubWorker` 头注）。
 * - **Chrome 发现**（`chrome`）：本机 Chrome 装在哪，读的是进程的 PATH 与文件系统。
 * - **退出收尾**（`exitHooks`）：facility 锁文件这类「进程走之前要删掉」的东西。
 * - **进程兜底网**（`attachNotify`）：未接住的 rejection / 异常落成通知——发给挂上来的实例。
 *
 * 只有 `process: true` 时才碰进程本身（挂 `unhandledRejection` / `uncaughtException`、在信号上收尾、把全局 fetch
 * 换成「远程执行里不许直连」的陷阱）。那是 `stream serve` 这种进程入口的事；库入口自建的 runtime 一样都不挂
 * （D1：不注册进程信号），`close()` 时把登记的收尾跑一遍。
 *
 * 不在这里、但同样是进程共享的只读状态（不需要谁持有，也不会因多实例出错）：`replay/compute-sandbox.ts` 的
 * isolated-vm 模块加载 promise、`rsshub-install.ts` 的在途安装、`rsshub-worker.ts` 的包加载 promise——各自头注写着
 * 为什么可以共享。
 */
import { RsshubWorker } from '../rsshub-adapter.ts'
import { discoverChromeCandidates, nodeDiscoverFs, type ChromeCandidate } from '../browser/discover-chrome.ts'
import { createExitHooks, type ExitHooks } from '../exit-hooks.ts'
import { installProcessGuards } from '../process-guard.ts'
import { installGlobalFetchTrap } from '../devices/global-fetch-trap.ts'
import type { EventInput } from '../events/store.ts'

export interface StreamRuntime {
  /** 进程里唯一的 RSSHub worker（懒起）。 */
  readonly rsshub: RsshubWorker
  /** 本机 Chrome 候选（按 runtime 创建时拿到的 PATH 找）。 */
  readonly chrome: { discover(): Promise<ChromeCandidate[]> }
  /** 进程要走 / runtime 关时的收尾登记处。 */
  readonly exitHooks: ExitHooks
  /**
   * 实例把自己的通知口挂上来：进程兜底网接住的异常发给所有挂着的实例（`process: true` 时才有兜底网）。
   * 回撤销函数——实例关时撤。
   */
  attachNotify(notify: (input: EventInput) => void): () => void
  /** 释放 runtime 持有的进程级资源。只该由创建它的一方调。幂等。 */
  close(): Promise<void>
}

export interface CreateRuntimeOptions {
  /** 进程环境里 runtime 要用的那几样（今天只有 `PATH`，Chrome 发现用）。不传 = 一个都没有。 */
  env?: Readonly<Record<string, string | undefined>>
  /**
   * 是否接管进程级钩子：兜底网、信号上的收尾、全局 fetch 陷阱。**只有进程入口该开**（`stream serve`）；库入口
   * 嵌进别人的进程里时，这些是宿主的事。
   */
  process?: boolean
  /** 兜底网的错误日志出口（缺省 console.error）。 */
  logError?: (msg: string) => void
}

export function createRuntime(opts: CreateRuntimeOptions = {}): StreamRuntime {
  const rsshub = new RsshubWorker()
  const pathEnv = opts.env?.PATH ?? ''
  const exitHooks = createExitHooks(opts.process ? process : undefined)
  const notifiers = new Set<(input: EventInput) => void>()
  if (opts.process) {
    // 进程级兜底网（process-guard.ts 头注是权威说明）：孤儿 promise 的 rejection 不再把整个进程带走，
    // 未捕获异常仍然退出但**先留下堆栈 + 一条通知**。建 runtime 就挂——早于任何实例的装配（真事故就发生在
    // 启动装配期间，挂晚了正好错过它）。
    // 不登记撤销：兜底网要活到进程真的退出为止（关停期的异常同样该被看见），陷阱同理。
    installProcessGuards({
      notify: (input) => { for (const n of notifiers) { try { n(input) } catch { /* 一个实例发不出去不连累别的 */ } } },
      ...(opts.logError ? { logError: opts.logError } : {}),
    })
    // 全局 fetch 的运行时兜底：远程设备上的执行里直接调全局 fetch 就抛，而不是从本机发出去。
    // owned-outbound 早在进程入口首行就快照了原始 fetch，ownedFetch 不经过它。见 global-fetch-trap.ts 头注。
    installGlobalFetchTrap()
  }
  let closing: Promise<void> | undefined
  return {
    rsshub,
    chrome: { discover: () => discoverChromeCandidates(nodeDiscoverFs(pathEnv)) },
    exitHooks,
    attachNotify: (n) => {
      notifiers.add(n)
      return () => { notifiers.delete(n) }
    },
    close: () => closing ??= (async () => {
      exitHooks.runAll()
      await rsshub.dispose().catch(() => {})
    })(),
  }
}
