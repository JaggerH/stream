/**
 * 桌面那一半：**在宿主进程里持有 `stream-desktop` 的生命周期**——登记 native messaging、
 * 拉起、崩了退避重启、收摊。桌面控制的编排全部在 Stream 后端（`DesktopDriver` + `/api/host`
 * relay），agent 是薄执行器，这一层既不认识 recipe 也不认识 a11y——它只负责让那只手在本机上活着。
 *
 * **它不注册任何工具**（`ctx.registerTools` 一次都不调）：动词来自 Stream 后端的 `cdp_*`
 * （`target:'desktop'` / `'app:<进程>'`），养着 agent 是为了让那些动词有东西可驱动。
 *
 * 谁调它：Stream 后端自己在进程内 mount（`src/host-agent/mount.ts` 那张脸——`/api/host` 的
 * 消费者是后端，谁消费谁养）。它和这个包的浏览器那一半（`../index.ts`）共用同一个 exe、同一份
 * 二进制解析（`binary.ts`）、同一份 WSL 判据（`../wsl.ts`）。
 */
import { createRequire } from 'node:module'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapabilityContext } from '../../../../shared/capability/types.ts'
import { resolveAgentBinary, type BinaryLookup } from './binary.ts'
import { hostWsUrl, startAgent, stderrLineCapper, type AgentDeps, type AgentProcess } from './agent.ts'
import { STREAM_EXTENSION_ID } from '../extension-id.ts'
import { detectWsl, translateToWindowsPath, buildWindowsAgentEnv, buildRegisterEnv } from '../wsl.ts'

/** 这一次挂载收的 config。 */
export interface HostAgentConfig {
  /** Stream 后端那扇门。 */
  streamBaseUrl?: string
  /**
   * Stream 的 data 目录。**不能省**：agent 自己那套推断是「从可执行文件位置向上找
   * config.yaml」，而它现在住在 node_modules 里，向上找到的是 DSH 的 profile 目录。
   * 推断会静默推空，表现成「agent 起来了但握不上手」——和「没装」长得一模一样。
   */
  streamDataDir?: string
  /**
   * Chrome 扩展的固定 id（真相源 `src/ext-id.ts`，一路从 bootstrap.ts 传下来）。
   * 缺席 = 跳过 `--register`（记一行 warn），agent 照常起——native messaging 是给 Chrome
   * 扩展用的第二职业，注册失败/跳过不该拖累桌面控制本身。
   */
  extensionId?: string
}

/** `deps.register()` 的结果：`--register` 是否成功、以及它的 stderr（失败时用来说清原因）。 */
export interface RegisterResult {
  ok: boolean
  stderr: string
}

// WSL 那三条判据（`isWslVersionString` / `translateToWindowsPath` / `buildWindowsAgentEnv`）
// 住在 `../wsl.ts`，**全仓只许有那一份**：这里的两次 spawn（常驻 agent、`--register`）都从它取。
// 复制一份出来的代价：两份各自内部自洽、单测各自全绿，分歧只在真机上现形（WSLENV 名单算错 →
// agent 去读一个从没写过的目录里的 token → 握手每次被拒，症状和「没装扩展」一模一样）。

/**
 * I3 的姊妹坑：`child.stdin` / `child.stderr` 本身也是裸的 EventEmitter，管道被异常拆掉时
 * 发的流级 `error` 走的是同一条「没人接 → throw → 带走整个引擎」的路，只是 `child.on('error')`
 * 那份监听接不住它（那是 child 自己的 error，不是流的 error）。抽成纯函数是为了不起真进程
 * 就能测到「挂了」这件事——真的 `ChildProcess` 满足这个最小接口。
 * @param child - 只用得到 `stdin`/`stderr` 这两条流。
 * @param log - 记一行说清是哪条管道出的错。
 */
export function attachStreamErrorGuards(
  child: { stdin?: NodeJS.EventEmitter | null; stderr?: NodeJS.EventEmitter | null },
  log: (msg: string) => void,
): void {
  child.stdin?.on('error', (err: Error) => log(`host-agent stdin 管道出错：${err.message}`))
  child.stderr?.on('error', (err: Error) => log(`host-agent stderr 管道出错：${err.message}`))
}

/** 注入点，只为测试。 */
export interface ApplyDeps {
  lookup: Pick<BinaryLookup, 'platform' | 'arch' | 'wsl' | 'resolvePath' | 'resolveLocalBuild'>
  agent: AgentDeps
  /** 把 agent 登记成 Chrome 的 native messaging host（幂等）。看返回码——`--register`
   *  在没有 `--extension-id` 时必然以退出码 2 失败，静默吞掉等于这条命令永远是 no-op。
   *
   *  `dataDir` 是**已经为 agent 所在平台解析好的**那个路径（WSL 下已翻成 Windows 路径，见
   *  `mountHostAgent` 里 `effectiveDataDir` 那一段），实现要把它经 `STREAM_DATA_DIR` 递给
   *  子进程——Rust 侧 `register.rs::write_datadir_pointer()` 按**自己进程的环境**解析 data
   *  目录再写 `~/.stream/datadir` 指针。不递的表现全都不出声：它掉回自己的默认落点，铸一份
   *  Stream 从没碰过的 token，中继据此拒绝所有握手，看起来就是「扩展没装」。 */
  register(binPath: string, extensionId: string, dataDir: string): RegisterResult
  /**
   * 注入点：把 `streamDataDir` 翻成 Windows 路径。**只在 `resolveAgentBinary` 判定
   * `usesWindowsAgent` 为真时才会被调用**——非 WSL 场景这一格用不上，可以缺省。
   * 真实实现见 {@link translateToWindowsPath}（走 `wslpath -w`）。
   */
  translateToWindowsPath?(linuxPath: string): string | undefined
}

/**
 * 真实 spawn 用的 stdio/env。纯函数，方便测试直接钉住 `stdio[0] === 'pipe'` 这条不变量，
 * 不用真的起一个子进程。
 *
 * **stdin 必须是管道，且写端必须留在 node 手里（不 end/close 它）**——那根还活着的写端正是
 * host-agent `STREAM_HOST_PARENT_WATCH` 要的父活信号：父进程（这个 node 进程）活着就一直
 * 持有它，进程退出或被杀时 OS 自动收走所有 fd，agent 读到 stdin EOF 才判定「父死了」退出。
 * `stdio: 'ignore'` 给的 stdin 是 `/dev/null`，会立刻 EOF——agent 起来几毫秒就判定父死了
 * 自己退出，然后被 `agent.ts` 的退避逻辑当成崩溃重启，永远循环（`main.rs` 里那段注释
 * 逐字写着这条陷阱：手动起、stdin 是 /dev/null 的场景会立刻 EOF）。
 *
 * stdout 用不上，继续 `ignore`；stderr 用管道接出来，唯一说得出「起来了但握不上手」真因的
 * 那句诊断（`datadir.rs` 的 token 查找失败）就印在那儿（见 I2）。
 */
export function buildSpawnOptions(env: Record<string, string>): { stdio: ['pipe', 'ignore', 'pipe']; env: NodeJS.ProcessEnv } {
  return {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, ...env },
  }
}

const requireFromHere = createRequire(import.meta.url)
// src/host-agent/ → src/ → 包根。`platforms/` 是包根下的兄弟目录（本地构建产物那一档）。
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** 导出只为测试：`default-deps.test.ts` 用它直接测真实接线（stdio/'error'/stderr 转发），
 *  不像 `index.test.ts` 那样整条链路都换成假 spawn。 */
export function defaultDeps(ctx: CapabilityContext): ApplyDeps {
  // `ctx.log` 已经是正规渠道（宿主 `src/capabilities/host.ts` 给它带上 `[stream-<能力名>]`
  // 前缀再落进后端日志）——不需要 defaultDeps 自己维护一份 makeLogger。
  const log = (msg: string) => ctx.log.warn(msg)
  // WSL 判据：读 /proc/version，读不到（非 Linux，或这台机器压根没有这个文件）就当不是
  // WSL——`detectWsl()` 是全仓唯一那份，`--register` 那次 spawn 也走它。
  const wsl = detectWsl()
  return {
    lookup: {
      platform: process.platform,
      arch: process.arch,
      wsl,
      resolvePath: (specifier) => requireFromHere.resolve(specifier),
      // I3：本地档（`file:` 软链进 monorepo）里 require.resolve 会 realpath 回仓库，
      // 那里的 node_modules 没有 npm 平台包——刚编出来的二进制因此没有消费者。这里再试一次
      // 包根同级的 platforms/<pkg>/bin/<file>，命中就用，并在 mount() 里说清用的是本地档。
      resolveLocalBuild: (relPath) => {
        const p = join(packageRoot, 'platforms', relPath)
        return existsSync(p) ? p : undefined
      },
    },
    agent: {
      spawn(bin, env): AgentProcess {
        const child = nodeSpawn(bin, [], buildSpawnOptions(env))
        let exited = false
        let onExitCb: () => void = () => {}
        const fireOnce = (): void => {
          if (exited) return
          exited = true
          onExitCb()
        }
        // 听 'close' 不听 'exit'：'exit' 发出时 stderr 管道里可能还有没送到的 chunk（Node 文档
        // 明写 stdio 可能仍开着），I2 那句「拿不到 relay token」会在 onExit 之后才到、于是漏转发——
        // 实测 6 轮里红 2 轮的偶发就是它。'close' 保证 stdio 全部关完才算退出；spawn 失败那条
        // 仍走下面的 'error'（fireOnce 去重，两个都来也只算一次）。
        child.on('close', fireOnce)
        // I1：spawn 失败（EACCES 丢了执行位 / ENOEXEC 平台包里躺着错架构的二进制 / ENOENT
        // 目录被 npm 重装挪走）发的是 'error'，且 Node **不会**接着发 'exit'。EventEmitter 上
        // 没有 'error' 监听时会直接 throw，那一下发生在 ctx.effect 之后的异步栈里没人接，会
        // 把整个 DSH 引擎进程带走——这就推翻了本插件反复声明的不变量「起不来绝不拖垮工作台
        // 装载」：三种起不来在 spawn 之前就拦住了，唯独这一步是裸的。挂上监听、按一次退出
        // 处置（走同一条退避），把「起不来」降级成一次可恢复的失败。
        child.on('error', (err) => {
          log(`host-agent spawn 失败：${err.message}`)
          fireOnce()
        })
        // Minor-3：stdin/stderr 这两条流本身也是裸的 EventEmitter，同一条「uncaught → 带走
        // 引擎」的路——见 attachStreamErrorGuards 头注。
        attachStreamErrorGuards(child, log)
        // I2：唯一说得出真因的那句诊断印在 stderr 上（agent 读不到 relay token 时）。封顶转发，
        // 别让一个疯狂刷错的 agent 把插件日志灌爆——见 agent.ts 的 stderrLineCapper 头注。
        if (child.stderr) {
          const capper = stderrLineCapper()
          child.stderr.on('data', (chunk: Buffer) => {
            for (const line of capper.push(chunk.toString('utf8'))) log(`host-agent stderr: ${line}`)
          })
        }
        return {
          kill: () => { child.kill() },
          onExit: (cb) => { onExitCb = cb },
        }
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      log,
    },
    register: (binPath, extensionId, dataDir) => {
      // **不要补 `--exe`。** manifest 里那个 `path` 是 Chrome 用来拉起 host 的，必须是
      // Windows 认得的路径；而我们能递过去的是一个 WSL 侧的 Linux 路径（`/home/...`），
      // Chrome 拿到它只会说 `Specified native messaging host not found.`——扩展于是永远
      // 停在「ws off」，退避重试到 30s 一次，日志里只有 pairing-refused，没人看得出是路径的事。
      //
      // 不补也不会退化：`binPath` 在本包所有路径上**都是那个 Windows .exe**
      // （`resolveAgentBinary`：WSL 强制走 win32-x64，非 WSL 也只支持 win32-x64），
      // 而 `register.rs::resolve_exe` 在没有 `--exe` 时取的是 `current_exe()`——那是
      // Windows 进程自报的路径，天然就是 Windows 形式。活体实测（2026-08-29）：不带 --exe
      // 登记出的 path 是 `\\wsl.localhost\Ubuntu\home\...\stream-desktop.exe`，
      // Chrome 从这个 UNC 路径**能**拉起 native host（README 里长期存疑的那一半，至此实测通过）。
      const args = ['--register', '--extension-id', extensionId]
      // Minor-2：10s 超时上界——这条命令在 WSL 下会派生 cmd.exe/wslpath/reg.exe，Windows
      // interop 卡住时 spawnSync 会同步阻塞整个事件循环且无上界，现场只有
      // 「装载停在那儿」，零日志。
      const r = spawnSync(binPath, args, {
        encoding: 'utf8',
        timeout: 10_000,
        // `STREAM_DATA_DIR` + （WSL 下）`WSLENV`。和常驻 agent 那次 spawn 走同一份判据
        // （`../wsl.ts`），两处分家的表现是 agent 与登记指针指向两个不同的目录，
        // 而两边单看都正常。
        env: { ...process.env, ...buildRegisterEnv(dataDir, wsl) },
      })
      // spawn 层失败（EACCES/ENOENT 等）落在 r.error，不落在 r.stderr——r.stderr 这时是空的，
      // 之前会把这种情况打成「(no stderr)」，正是上一轮刚修掉的那类吞错。
      const stderr = (r.stderr ?? '').trim() || (r.error ? `spawn 失败：${r.error.message}` : '')
      return { ok: r.status === 0, stderr }
    },
    translateToWindowsPath: (linuxPath) => translateToWindowsPath(linuxPath),
  }
}

/**
 * 挂上桌面那一半：登记 native messaging、（桌面控制可用的平台上）拉起 agent、把收摊登记进
 * `ctx.onDispose`。
 *
 * **这只手是两半，平台可以只有一半。** 配对（`--register` + 指针 + relay token）跨平台通用；
 * 桌面控制要那个平台有自己的 a11y 后端（今天 Windows 走 UIA、macOS 走 AX）。没有后端的
 * 平台走到 `--register` 就收——见下面 `found.desktopControl` 那一段的理由。
 *
 * 三种「起不来」一律**记一条说清原因的日志然后返回**，绝不抛：桌面控制是可选能力，
 * 它起不来不该把宿主的装载搞崩。这一层不注册任何工具（`ctx.registerTools` 不调）——
 * 它唯一的产出是「host-agent 这条命活着」，编排全在 Stream 后端那边。
 * @param ctx - 宿主中立的能力上下文（后端那张脸在 `src/host-agent/mount.ts`）。
 * @param config - 这一次挂载的 config。
 * @param deps - 注入点，只为测试。
 */
export async function mountHostAgent(ctx: CapabilityContext, config: HostAgentConfig = {}, deps: ApplyDeps = defaultDeps(ctx)): Promise<void> {
  const baseUrl = config.streamBaseUrl?.trim()
  if (!baseUrl) {
    ctx.log.warn('这一行没有 streamBaseUrl，本次不起 Stream Desktop 的本机进程（桌面控制不可用）。')
    return
  }
  const dataDir = config.streamDataDir?.trim()
  if (!dataDir) {
    ctx.log.warn(
      '这一行没有 streamDataDir，本次不起 Stream Desktop 的本机进程。' +
      '缺了它读不到 relay token，会「起来然后握手失败」——那个形状和没装一模一样，所以宁可不起。',
    )
    return
  }
  const found = resolveAgentBinary({ ...deps.lookup })
  if (!found.ok) {
    ctx.log.warn(`${found.reason}`)
    return
  }
  // WSL 下挑中的是 Windows 版 host-agent（见 resolveAgentBinary 里 usesWindowsAgent 的判据）：
  // 它在 Windows 侧跑，读不了 WSL 的 Linux 路径，STREAM_DATA_DIR 得先翻成 Windows 路径；
  // 且不设 WSLENV 的话这条环境变量根本传不过 WSL→Windows 这条边界（见 buildWindowsAgentEnv
  // 头注的实测）。两件事都在这里一次做完，往下 startAgent/spawn 那段代码对「是不是 WSL」
  // 完全无感——它们只认 agentDeps.spawn 和 effectiveDataDir 这两个已经处理好的值。
  let effectiveDataDir = dataDir
  let agentDeps = deps.agent
  if (found.usesWindowsAgent) {
    const translated = deps.translateToWindowsPath?.(dataDir)
    if (!translated) {
      ctx.log.warn(
        'WSL 下要起 Windows 版的 Stream Desktop 本机进程，但 streamDataDir 翻译成 Windows 路径失败' +
        '（wslpath -w 没跑成功）。拿一个 Linux 路径直接喂给 Windows 进程，症状是它起来了' +
        '但读不到 relay token——和「没装」长得一模一样，所以宁可不起。',
      )
      return
    }
    effectiveDataDir = translated
    agentDeps = {
      ...deps.agent,
      spawn: (bin, env) => deps.agent.spawn(bin, buildWindowsAgentEnv(env)),
    }
  }
  // 登记 Chrome 的 native messaging host：Chrome 按 manifest 里的**绝对路径**拉起它，
  // 所以只要文件在、路径不变，谁管它的常驻生命周期都无所谓。幂等，重复跑无害。
  // **不在 dispose 里 unregister**：dispose 每次后端重启都会发生，撤登记再重写会留下
  // 一段扩展握不上手的窗口，而且症状是间歇性的。注销属于卸载，保持手动命令。
  //
  // **注册失败不阻止 agent 启动**：native messaging 是给 Chrome 扩展用的第二职业，
  // 和「agent 经 /api/host 被后端驱动」是两件独立的事——前者垮了不该连累后者。
  //
  // 行 config 不给 `extensionId` 是常态（profile 里那一行只写 streamBaseUrl/streamDataDir）：
  // 用包里自带的默认值，它就是 Stream Companion 扩展那个固定 id。
  //
  // 递进去的是 `effectiveDataDir`（WSL 下已翻成 Windows 路径），**不是**原始 `dataDir`：
  // 翻译在上面只做一次，翻不出来那一支已经 return 了。同一个答案推两遍就是两份实现，
  // 分歧时的表现是常驻 agent 与登记指针指向两个不同的目录，而两边单看都正常。
  const extensionId = config.extensionId?.trim() || STREAM_EXTENSION_ID
  const result = deps.register(found.path, extensionId, effectiveDataDir)
  if (!result.ok) {
    ctx.log.warn(
      `--register 失败，native messaging 未登记（Chrome 扩展那支拿不到桌面控制，` +
      `Stream Desktop 的本机进程仍会正常起）：${result.stderr || '(no stderr)'}`,
    )
  }
  const sourceNote = found.source === 'local-build' ? '（本地构建产物，platforms/ 平台包尚未发布/未装上）' : ''
  // 目标应用提示：WSL 下要控制的桌面在 Windows 一侧，把这件事直接打进日志——免得有人看到
  // 起了一个 .exe 却在 WSL 里以为哪里配错了。
  const targetNote = found.usesWindowsAgent ? '（WSL：目标应用在 Windows 桌面一侧）' : ''
  ctx.log.info(`host-agent → ${found.path}${sourceNote}${targetNote}`)
  // **桌面控制不支持的平台（今天 = 非 Windows）：register 照跑，常驻 agent 不起。**
  // 上面那次 `--register` 才是配对的全部所需——它写 native messaging manifest，**并且**写
  // `~/.stream/datadir` 指针（Rust 侧 `register.rs::write_datadir_pointer()`，靠我们递过去的
  // `STREAM_DATA_DIR`）。之后由 Chrome 自己按 manifest 拉起 agent 去问 relay token，那条命
  // 和这里养不养一个常驻进程无关。
  //
  // 为什么不顺手也起一个：常驻 agent 连上 `/api/host` 之后每个 op 都 `unsupported`
  // （`app/host-agent/src/main.rs` 里那个占位后端），正是「装得上、一动就报错」
  // 那个形状——还白占一个进程、白占一条 WS。
  //
  // **今天没有平台走得到这一支**：出货的 win32 / darwin 都有后端了（UIA / AX）。它留给
  // 下一个平台——先出二进制、后端还没写的那一档。别因为"看着是死代码"就删掉：删了之后
  // 那个平台上的表现是连 `--register` 都不跑，扩展永远 never-seen，而一处都不喊。
  if (!found.desktopControl) {
    ctx.log.info(
      '本平台只做**配对**：native messaging 已登记，Chrome 扩展能拿到 relay token，采集带得上登录态。' +
      '**桌面控制不可用**（a11y 树 / 坐标输入 / 窗口枚举在本平台还没有后端实现），所以不起常驻 agent。',
    )
    return
  }
  // startAgent() 同步起 agent 并立刻交回它的 stop 函数——不是一段「等 onDispose 时再执行的
  // setup」，所以直接把调用结果递给 onDispose，不用再包一层闭包（同一条不变量：disposer
  // 必须在任何 await 之前的同步路径上挂好，否则落在 await 期间的 dispose 够不到它）。
  ctx.onDispose(startAgent(agentDeps, { binPath: found.path, wsUrl: hostWsUrl(baseUrl), dataDir: effectiveDataDir }))
}
