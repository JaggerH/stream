/**
 * WSL 下把「本插件跑在 Linux 侧」和「host-agent 永远是 Windows 版 exe」这条边界接起来：
 * 判断是不是 WSL、把 Linux 路径翻成 Windows 路径、让环境变量真的跨过这条边界。
 *
 * **本包里这几条判据只有这一份**——`host-agent/index.ts` 里那两个消费者（常驻 agent 的 spawn、
 * `--register` 那次一次性 spawn）都从这里取。手抄第二份的话，两份各自内部自洽、单测各自全绿，
 * 分歧却只在真机上现形：WSLENV 名单算错，agent 会去读一个 Stream 从没写过的目录里的 token，
 * 扩展握手每次被拒，症状和「用户压根没装扩展」一模一样。
 *
 * `isWslVersionString` 的判据照抄 `app/host-agent/src/register.rs` 的 `is_wsl`，不自己发明：
 * 两边对「是不是 WSL」给出两种答案时，一边挑 Windows agent、另一边按非 WSL 登记，行为对不上
 * 却各自看起来都没错。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/**
 * 判断 `/proc/version` 的内容是不是 WSL。
 *
 * 判据：转小写后包含 `"microsoft"` 或 `"wsl"`——和 `app/host-agent/src/register.rs` 的
 * `is_wsl` 用的是**同一条判据**，照抄，不自己发明。两边对「是不是 WSL」给出两种答案是
 * 最难查的分歧：一边认为要挑 Windows agent，另一边（`--register` 的默认目标判断）却认为
 * 不是 WSL，行为对不上却各自看起来都「没错」。
 *
 * 纯函数，方便测试直接喂字符串，不用真的在 WSL 里跑。
 * @param procVersionText - `/proc/version` 的原始内容。
 */
export function isWslVersionString(procVersionText: string): boolean {
  const v = procVersionText.toLowerCase()
  return v.includes('microsoft') || v.includes('wsl')
}

/**
 * 读一次 `/proc/version` 判断本机是不是 WSL。读不到（非 Linux，或这台机器压根没有这个文件）
 * 就当不是 WSL——`host-agent/index.ts` 的 `defaultDeps()` 也走这一格。
 * @param readProcVersion - 注入点，只为测试；默认真读 `/proc/version`。
 */
export function detectWsl(readProcVersion: () => string = () => readFileSync('/proc/version', 'utf8')): boolean {
  try {
    return isWslVersionString(readProcVersion())
  } catch {
    return false
  }
}

/**
 * 把一个 WSL(Linux) 路径翻译成 Windows 能读的 UNC 形式，给 Windows 版 host-agent 读
 * `STREAM_DATA_DIR` 用（它要从这个目录下的 `ext-relay-token` 读握手令牌）。
 *
 * 走 `wslpath -w`，同步调一次即可——这条命令走的量极小，不值得为它引入异步。**翻译失败
 * （`wslpath` 不存在、路径非法等）返回 `undefined`，调用方据此决定要不要 spawn**：拿一个
 * Linux 路径直接喂给 Windows 进程，症状是 agent 起来但读不到 token——和「没装」长得一模
 * 一样，这是本仓库反复踩过的坑，宁可不起也不让它再复现一次。
 * @param linuxPath - 要翻译的 WSL 侧路径。
 * @param runWslpath - 注入点：真实调用 `wslpath -w`；测试里换成假实现。
 * @returns 翻译后的 Windows 路径；失败则 `undefined`。
 */
export function translateToWindowsPath(
  linuxPath: string,
  runWslpath: (path: string) => { status: number | null; stdout: string } = (p) => {
    const r = spawnSync('wslpath', ['-w', p], { encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout }
  },
): string | undefined {
  const r = runWslpath(linuxPath)
  if (r.status !== 0) return undefined
  const out = r.stdout.trim()
  return out || undefined
}

/**
 * WSL 下起 Windows 版进程时，往一份 env 上加一个 `WSLENV`，环境变量才能真的跨过 WSL→Windows
 * 这条边界。
 *
 * 不设 `WSLENV`，环境变量根本传不进 Windows 进程——实测：`PROBE_X=hello cmd.exe /c
 * "echo [%PROBE_X%]"` 打出 `[%PROBE_X%]`（没展开＝没传过去），加一个
 * `WSLENV=PROBE_X cmd.exe /c "echo [%PROBE_X%]"` 才打出 `[hello]`。
 *
 * 名单直接取 `Object.keys(env)`，不在这里手写一份变量名——调用方传进来的就应该是「这次真正
 * 要递给 Windows 进程的那份 env」，手写一份会在调用方加/删变量时悄悄漏掉一个。
 * @param env - 要连同一起递给 Windows 进程的 env。
 * @returns 新对象，多一个 `WSLENV`；不改原对象。
 */
export function buildWindowsAgentEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, WSLENV: Object.keys(env).join(':') }
}

/**
 * `--register` 子进程该带的 env。消费者是 `host-agent/index.ts` 的 `defaultDeps().register`。
 *
 * **`dataDir` 必须是已经为 agent 所在平台解析好的那个路径**（WSL 下 = `wslpath -w` 翻译过
 * 的 Windows 路径），不是插件 node 进程看到的 Linux 路径。翻译只做一次，在
 * `mountHostAgent` 里（它拿翻译结果同时喂给常驻 agent 的 spawn 和这里，翻不出来就直接不起，
 * 连 register 都不做）。这个函数**故意不自己翻**：同一个答案推两遍就是两份实现，而它们
 * 分歧时的表现是 agent 与 register 指向两个不同的目录，两边单看都正常。
 *
 * 于是这里只剩一件事——WSL 下补 `WSLENV`，否则这条环境变量根本传不过 WSL→Windows 这条边界
 * （见 {@link buildWindowsAgentEnv} 头注的实测）。漏了它，Rust 侧 `write_datadir_pointer()`
 * 读不到 `STREAM_DATA_DIR`、掉回它自己在 Windows 侧的默认落点，铸出一份 Stream 从没碰过的
 * token；中继据此拒绝所有握手，表现和「扩展没装」一模一样，且没有一处会报错。
 *
 * @param dataDir - 已解析好的 data 目录（WSL 下是 Windows 路径）。
 * @param wsl - 本机是不是 WSL（`detectWsl()` 的结果）。
 */
export function buildRegisterEnv(dataDir: string, wsl: boolean): Record<string, string> {
  const env = { STREAM_DATA_DIR: dataDir }
  return wsl ? buildWindowsAgentEnv(env) : env
}
