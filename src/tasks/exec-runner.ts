/**
 * 调度中心的第二种任务类型：跑一条外部命令。
 *
 * 在此之前调度中心只有进程内 handler。A 股任务和数据下载都住在 conda 环境里的 Python，
 * 所以需要这一层。它只管**怎么跑、结果怎么回来**；跑什么由 `scheduled_tasks` 表定义。
 *
 * **失败必须 throw**：`StreamTaskJob` 靠 throw 记 failed、发通知、按 maxAttempts 重试。
 * 返回一个"内容是失败"的 outcome 会被账本记成 completed——那是把失败静默掉。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { errText } from '../err-text.ts'
import { parseOutcome, type ExecResult } from './outcome.ts'
import type { TaskOutcome } from './types.ts'

export interface ExecSpec {
  command: string
  args: string[]
  cwd?: string
  /** 追加到继承的 env 上（不是替换）——任务通常还要 PATH/HOME */
  env?: Record<string, string>
  /** 默认 30 分钟。到点先 SIGTERM，2s 后 SIGKILL。 */
  timeoutMs?: number
  /** stdout+stderr 的落盘路径（追加写）。目录不存在会建。 */
  logFile?: string
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const KILL_GRACE_MS = 2_000
/** 内存里最多留多少输出参与解析——只为找末尾那行 outcome 和 stderr 末几行，全量在 logFile 里。 */
const KEEP_TAIL_BYTES = 256 * 1024

function keepTail(buf: string, chunk: string): string {
  const next = buf + chunk
  return next.length > KEEP_TAIL_BYTES ? next.slice(next.length - KEEP_TAIL_BYTES) : next
}

export async function runExternal(spec: ExecSpec): Promise<TaskOutcome> {
  let timedOut = false
  const result = await new Promise<ExecResult>((resolve, reject) => {
    let log: ReturnType<typeof createWriteStream> | undefined
    let child
    try {
      // 建目录/开日志文件必须在 spawn 之前：等子进程已经起来了才建目录，这里一 throw，
      // 子进程就没人管了——不 kill 也不进结果里，成了一个孤儿进程，且这条 throw 走的还不是
      // 下面这个「无法启动」的形状（调用方读错误消息以为压根没跑起来）。
      if (spec.logFile) {
        mkdirSync(dirname(spec.logFile), { recursive: true })
        log = createWriteStream(spec.logFile, { flags: 'a' })
      }
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      log?.end()
      reject(new Error(`无法启动 ${spec.command}: ${errText(e)}`))
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout = keepTail(stdout, d.toString()); log?.write(d) })
    child.stderr.on('data', (d: Buffer) => { stderr = keepTail(stderr, d.toString()); log?.write(d) })

    // 到点先礼后兵：SIGTERM 给 Python 一个 finally 的机会，宽限期后 SIGKILL 保证收得掉。
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
    }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    timer.unref()

    child.on('error', (e) => {
      clearTimeout(timer); log?.end()
      reject(new Error(`无法启动 ${spec.command}: ${errText(e)}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const done = (): void => resolve({ stdout, stderr, exitCode: code, signal })
      // **等日志真的落盘再回**：`end()` 是异步的，不等它就回，调用方拿到结果时文件可能还是空的。
      // 表现是"页面上这次执行有摘要、点开日志却是空文件"，而且随机——写得快的时候又是对的。
      // 'error' 也走 done：日志写不下去不该把一次成功的执行判失败（全量输出丢了，摘要还在）。
      if (!log) { done(); return }
      log.end()
      log.once('finish', done)
      log.once('error', done)
    })
  })

  const { ok, outcome } = parseOutcome(result)
  // 超时必须 throw，不看 parseOutcome 怎么判：子进程若拦住 SIGTERM 自己善后再退出(code=0,
  // signal=null)，ok 会是 true——一个跑到超时被杀的任务就这样被记成 completed，没通知没重试
  // （见头注「失败必须 throw」）。timedOut 优先于 ok 判。
  if (timedOut) throw new Error(`${outcome.summary}（超时）`)
  if (!ok) throw new Error(outcome.summary)
  return outcome
}
