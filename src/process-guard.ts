/**
 * 进程级的兜底网：孤儿 promise 的 rejection、以及穿透到顶的同步异常。
 *
 * **为什么要有它**：2026-09-04 一台跑发行包的机器上，`RsshubClient` 里一条没人 await 的
 * `this.ready`（被后一次赋值覆盖掉的那份）在 worker spawn 失败时 reject，Node 默认策略
 * （`--unhandled-rejections=throw`）**把整个后端进程带走了**。用户看到的只是"它自己没了"——
 * 采集、任务、工作台一起停，没有一处会喊。那个具体的逃逸口已经堵上（`d8fcea9a`），但下一个
 * 孤儿在别处时，代价还是整个进程。
 *
 * **它不是消音器。** 这道网的价值是"不再用整个死掉来表达一个局部失败"，不是让错误消失，
 * 所以三条硬约束（改动前先读）：
 *   1. 日志必须是 **error 级 + 完整堆栈**（`err.stack`，不是 `String(err)`）。绝不降级成
 *      debug、绝不只打一行摘要——摘要救不了任何一次排查。
 *   2. 必须发一条 **severity:'error'** 的通知（`process.unhandled-rejection` /
 *      `process.uncaught-exception`）。只有日志等于没人知道：日志没人看，通知中心才有人看。
 *   3. **这里不许做任何"分类后忽略某几种"的逻辑。** 一旦长出白名单，它就从兜底网变成了
 *      消音器，而且是那种"看起来很懂"的消音器。要治的是那条孤儿 promise 本身，不是这里。
 *
 * **两者不是一回事，处理也不同**：
 *   - `unhandledRejection`：一条被丢下的异步链，进程状态仍然自洽 —— **记录 + 通知，不退出**。
 *   - `uncaughtException`：同步栈被撕断在半路（谁知道哪个不变量只做了一半）—— 记录 + 通知
 *     之后**仍然退出**，让 supervisor（计划任务 / systemd）把它拉起来。带着
 *     可能已经不一致的状态继续服务，比死掉更坏：那会把一次局部损坏写进数据。
 */
import { inspect } from 'node:util'
import type { EventInput } from './events/store.ts'

export interface ProcessGuardDeps {
  /** 事件入口。用 `lazyNotify(() => kernel.streamEvents)` 包一层——事件层比进程钩子晚装配。 */
  notify: (input: EventInput) => void
  /** 默认 console.error。**必须是 error 级**，见头注约束 1。 */
  logError?: (msg: string) => void
  /** 默认 `process.exit`。只有 uncaughtException 会用到。 */
  exit?: (code: number) => void
  /** 默认全局 `process`。测试注入一个假的，别往真 process 上挂钩子。 */
  target?: Pick<NodeJS.Process, 'on' | 'off'>
}

/** 拿到能贴给 AI 的最全那一份文本：Error 走 `stack`（含 cause 链），非 Error 值原样 inspect。 */
export function describeThrown(err: unknown): string {
  if (err instanceof Error) {
    // `stack` 里已经含 message；cause 链 Node 的 stack 不一定展开，补一行保证不丢。
    const stack = err.stack ?? `${err.name}: ${err.message}`
    const cause = (err as { cause?: unknown }).cause
    return cause == null ? stack : `${stack}\n  cause: ${inspect(cause, { depth: 3 })}`
  }
  // reject 一个非 Error 值时**没有堆栈可言**——如实说出来，别拿处理器自己的栈冒充现场。
  return `非 Error 的拒绝值（没有堆栈）：${inspect(err, { depth: 3 })}`
}

/**
 * 挂上两个进程钩子，返回撤销函数（内核 effect / 测试都靠它摘干净）。
 */
export function installProcessGuards(deps: ProcessGuardDeps): () => void {
  const log = deps.logError ?? ((m: string) => console.error(m))
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const target = deps.target ?? process

  const onRejection = (reason: unknown) => {
    const detail = describeThrown(reason)
    log(`[stream] unhandledRejection（进程没退，但这是个 bug）:\n${detail}`)
    // 通知发不出去不许反过来再掀翻一次——这道网的唯一职责就是别让局部失败变成整体失败。
    try {
      deps.notify({
        type: 'process.unhandled-rejection',
        severity: 'error',
        title: '后端内部出错了（一条没人接住的异步失败）',
        body: '有一段后台工作失败了，而且没有任何一处代码接住这次失败——进程已经保住，'
          + '其余功能照常，但**刚才那件事没做成**，而且它不属于任何一次采集失败。'
          + '这是代码缺陷，把这条通知复制出去交给 AI 排查。',
        detail: `kind=unhandledRejection\n${detail}`,
        // 同一个逃逸口每轮都能再炸一次；未读期间只刷新一条，别把通知中心刷满。
        // 编进 key 的是**堆栈首行**——不同的逃逸口仍然各报各的。
        dedupeKey: `process-unhandled-rejection:${detail.split('\n')[0]}`,
      })
    } catch { /* 见上 */ }
  }

  const onException = (err: unknown) => {
    const detail = describeThrown(err)
    log(`[stream] uncaughtException（进程即将退出，等待 supervisor 拉起）:\n${detail}`)
    try {
      deps.notify({
        type: 'process.uncaught-exception',
        severity: 'error',
        title: '后端崩了一次（未捕获异常，进程正在退出）',
        // EventStore 是 writeFileSync 落盘的，所以这条在 exit 之前就已经写进去了——
        // 重启之后用户仍然看得到"上次是怎么没的"。
        body: '有一个异常一路穿到了顶层，进程状态可能已经不一致，所以后端选择退出并等待被拉起，'
          + '而不是带着半截状态继续跑。重启后如果反复出现同一条，就是这条缺陷还在。',
        detail: `kind=uncaughtException\n${detail}`,
        dedupeKey: `process-uncaught-exception:${detail.split('\n')[0]}`,
      })
    } catch { /* 通知失败不许挡住退出 */ }
    exit(1)
  }

  target.on('unhandledRejection', onRejection as NodeJS.UnhandledRejectionListener)
  target.on('uncaughtException', onException as NodeJS.UncaughtExceptionListener)
  return () => {
    target.off('unhandledRejection', onRejection as NodeJS.UnhandledRejectionListener)
    target.off('uncaughtException', onException as NodeJS.UncaughtExceptionListener)
  }
}
