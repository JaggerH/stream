/**
 * `stream cdp-bind` 的进程入口。
 *
 * 三件事，和 `src/install/cli-entry.ts` 里别的子命令一样薄：**把配对码从 stdin 读进来**、
 * 起绑定、等信号。它不 chdir、不 import 后端——这是一条独立的长驻进程（systemd 管），
 * 与 `stream serve` 没有父子关系。
 *
 * **配对码只从 stdin 读**：命令行会进 `ps` 与 shell 历史，环境变量会进 `/proc/<pid>/environ`，
 * 两者都比"喂一行给 stdin"更容易被同机的别人看到。有状态文件时这一句根本不会问。
 */
import { createInterface } from 'node:readline'

export interface CdpBindCommandOptions {
  /** 缺省 `http://127.0.0.1:9222`。 */
  cdpUrl?: string
  serverUrl: string
  stateFile: string
}

export interface CdpBindCommandDeps {
  /** 测试缝：替掉真的 stdin / 信号。 */
  readPairingCode?: () => Promise<string>
  log?: (line: string) => void
  /** 测试缝：绑定起来之后叫一声（拿到句柄就能从测试里关它）。 */
  onStarted?: (binding: { close(): Promise<void>; done: Promise<void> }) => void
}

export async function runCdpBindCommand(cmd: CdpBindCommandOptions, deps: CdpBindCommandDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.error(line))
  const { startCdpBinding } = await import('../cdp-binding/index.ts')
  let binding: Awaited<ReturnType<typeof startCdpBinding>>
  try {
    binding = await startCdpBinding({
      ...(cmd.cdpUrl ? { cdpUrl: cmd.cdpUrl } : {}),
      serverUrl: cmd.serverUrl,
      stateFile: cmd.stateFile,
      readPairingCode: deps.readPairingCode ?? readLineFromStdin,
      log,
    })
  } catch (e) {
    // 起不来（地址不是回环、没读到配对码、配对被拒……）：一句人话 + 非零退出码，不打一屏栈。
    // systemd 那边看到的是 failed，日志里是原因。
    log(`stream cdp-bind: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  deps.onStarted?.(binding)
  log(`[cdp-binding] 已启动（binding=${binding.bindingId}）`)
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
      resolve()
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    void binding.done.then(stop)
  })
  await binding.close()
  return 0
}

/** 读一行配对码。stdin 已经结束 / 没有内容 → 空串（调用方据此报"没有读到配对码"）。 */
export function readLineFromStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false })
    let got = false
    rl.once('line', (line) => {
      got = true
      rl.close()
      resolve(line)
    })
    rl.once('close', () => {
      if (!got) resolve('')
    })
  })
}
