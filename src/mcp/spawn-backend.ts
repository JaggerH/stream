import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { probeBackend } from '../../shared/mcp/probe-backend.ts'

export interface SpawnedBackend {
  kill(): void
  url: string
  /** 子进程退出后 resolve 出退出码/信号——`stream mcp` 壳靠它判断是不是 RESTART_EXIT_CODE
   *  需要再拉起一份。注入的假 child（单测）没有事件接口时，这个 promise 永不 resolve。 */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** spawn 命令梯子(spec「stdio MCP 形态」,对齐 desktop-packaging 现状):STREAM_BACKEND_CMD 显式 >
 *  同 runtime 起 serve 入口(process.execPath + execArgv + 相对本文件的 ../serve.ts——dev/tsx 与
 *  打包布局同构)。`pnpm serve` 已退役,不得出现在这里。 */
export function resolveSpawnCmd(env: NodeJS.ProcessEnv, entryUrl: string): { cmd: string; args: string[] } {
  const explicit = env.STREAM_BACKEND_CMD?.trim()
  if (explicit) {
    const [cmd, ...args] = explicit.split(/\s+/)
    return { cmd, args }
  }
  const serveEntry = path.resolve(path.dirname(fileURLToPath(entryUrl)), '../serve.ts')
  return { cmd: process.execPath, args: [...process.execArgv, serveEntry] }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 默认后端地址:Compose 栈的 gateway 发布端口。stdio 自己 spawn 时没有 gateway,
 *  serve.ts 会被要求直接绑这个端口(见 backendPortOf)。 */
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8900'

/** 从"我们待会儿要探活的那个 URL"反推"子进程该绑的端口"。
 *
 *  为什么必须有这一步(C1,曾经的真 bug):spawn 出来的是 src/serve.ts,它绑的是
 *  `Number(process.env.STREAM_PORT ?? 4555)`;而探针打的是 STREAM_BACKEND_URL(默认 8900,
 *  那是 **gateway** 的发布端口,不是裸 serve.ts 会绑的端口)。子进程 env 早先是原样 `{...env}`
 *  透传,STREAM_PORT 从来没被推导过 —— 于是默认配置下"起在 4555、探 8900",必然探不绿,
 *  白等满 60s 超时再把孩子杀掉。默认路径下的 spawn 100% 失败,而且每次要烧掉一分钟。
 *  修法:端口只有一个真相源——我们探的那个 URL,子进程按它绑。 */
export function backendPortOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.port) return u.port
    return u.protocol === 'https:' ? '443' : '80'
  } catch {
    // URL 解析不了(用户把 STREAM_BACKEND_URL 写坏了):不硬塞 STREAM_PORT,让子进程按它自己的
    // 默认起;反正探针对着一个非法地址也不会绿,超时分支会给出指向这个 URL 的报错。
    return null
  }
}

export async function spawnBackend(opts: {
  env?: NodeJS.ProcessEnv
  entryUrl?: string
  probe?: (url: string) => Promise<boolean>
  timeoutMs?: number
  pollMs?: number
  spawnImpl?: typeof spawn
  /** 「后端该用哪条命令起」的替换接缝。默认 `resolveSpawnCmd`（同 runtime 起 `../serve.ts`）。
   *
   *  发行形态里那条默认是**错的**：打包产物 `cli/bin/stream.mjs` 旁边没有 `serve.ts`，
   *  `../serve.ts` 指向一个不存在的文件，spawn 只会以一个和端口毫无关系的错失败。所以
   *  `stream mcp` 传自己的解析器（起的是同一份 `bin/stream.mjs`，见
   *  `src/install/mcp-command.ts` 的 `resolveSelfSpawnCmd`）。**注入而不是拼 env 字符串**：
   *  `STREAM_BACKEND_CMD` 按空白切词，而 Windows 上 node 的路径里就有空格。 */
  resolveCmd?: (env: NodeJS.ProcessEnv) => { cmd: string; args: string[] }
  /** Task 9 收尾:子进程刚创建、健康探针**还没开始轮询**之前同步回调一次,把杀掉它的能力早早
   *  交给调用方——spawnBackend 本体要等探针变绿(最长 60s)才 resolve,这段窗口里调用方(路由的
   *  关停路径)手上原本没有任何句柄可杀,只能靠一个有上限的"等它落定"兜底,那个上限一过、又没等到
   *  就只能放弃,子进程被 reparent 而不是随父退出。onChild 传出的 kill 和 spawnBackend 自己内部
   *  (成功分支/超时分支)用的是同一个 killOnce——谁先调用生效,后调用的都是安全的 no-op,不会把
   *  同一个子进程杀两次。 */
  onChild?: (child: { kill(): void }) => void
} = {}): Promise<SpawnedBackend> {
  const env = opts.env ?? process.env
  const url = env.STREAM_BACKEND_URL ?? DEFAULT_BACKEND_URL
  const probe = opts.probe ?? probeBackend
  const { cmd, args } = opts.resolveCmd
    ? opts.resolveCmd(env)
    : resolveSpawnCmd(env, opts.entryUrl ?? import.meta.url)
  // 起的端口和探的端口必须是同一个:STREAM_PORT 从探针 URL 推出来(见 backendPortOf)。
  // 显式 STREAM_BACKEND_CMD 也照传——那条命令若最终也是我们的 serve.ts,同样受益;不是的话
  // 多一个它不认识的环境变量无害。
  const port = backendPortOf(url)
  const childEnv: NodeJS.ProcessEnv = { ...env }
  if (port) childEnv.STREAM_PORT = port
  // stdio 后端在宿主上:默认开「一扇门」(host 档)。Docker 不可用时 wireStandby
  // 降级闸自动落回 inert,等价 none——默认 host 无害。显式设置者优先。
  childEnv.STREAM_PLUGIN_NETWORK = env.STREAM_PLUGIN_NETWORK ?? 'host'
  // 查询档:stdio MCP 拉起的是即用即回收后端,只服务查询,不该启动采集调度(否则查询型用户连上
  // 问一句就顺带触发全量采集,违背两档拍板)。默认关采集;serve.ts 的 maybeStartScheduler 据此
  // 跳过 scheduler.start()。显式设置者优先(仍可强开采集)。不动端口——只加 env,不碰 C1 约定。
  childEnv.STREAM_NO_SCHEDULER = env.STREAM_NO_SCHEDULER ?? '1'
  // 告诉后端「有人管你」:POST /api/restart 时它以 RESTART_EXIT_CODE(75)退出,由这层壳
  // (下面的 exited promise + `stream mcp` 里的 respawnLoop)负责再拉起一份,而不是直接
  // 重新 exec 自己进程——那样会丢失壳持有的 STDIO 通道。
  childEnv.STREAM_SUPERVISED = '1'
  // 显式档压过自动判（policy.ts）：调用方的 shell 里若恰好带着 STREAM_RESTART_MODE=watch|reexec
  // （开发机 dev.sh 那档会 export），继承下去后端就会去碰哨兵 / 自己 reexec，而不是退 75 让这层壳拉起。
  // 这里钉死成 supervised，不给继承的机会。
  childEnv.STREAM_RESTART_MODE = 'supervised'
  // stdout 必须 ignore:父进程 stdout 是 stdio MCP 的 JSON-RPC 通道,一个字节都不能混入。
  const child: Pick<ChildProcess, 'kill' | 'unref'> = (opts.spawnImpl ?? spawn)(cmd, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: childEnv,
  })
  // 子进程当场就死了（入口不存在、端口被占、原生模块装坏…）时**别再等满超时**。
  // 不接这个的代价是：`stream mcp` 拉起一份秒退的后端，然后对着一个永远不会绿的探针**静默
  // 轮询 60 秒**，用户看到的是一条卡住的命令，而真正的原因早就打在 stderr 上了。
  // `once` 存在性判一下：注入的假 child（单测里那些）没有事件接口，不能因此炸掉。
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let resolveExited: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined
  // 假 child(单测)没有事件接口时,这个 promise 永不 resolve——调用方(respawnLoop)只在
  // 真有子进程时才会等它,不会因此挂死。
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExited = resolve
  })
  const maybeEmitter = child as Partial<ChildProcess>
  if (typeof maybeEmitter.once === 'function') {
    maybeEmitter.once('exit', (code, signal) => {
      exitInfo = { code, signal }
      resolveExited?.({ code, signal })
    })
  }
  let killed = false
  const killOnce = () => {
    if (killed) return
    killed = true
    child.kill('SIGTERM')
  }
  // 必须在轮询循环开始**之前**同步调用:调用方(路由)要靠它在探针还没变绿的整段窗口里都能拿到
  // 句柄,晚一步(比如挪到第一次 probe 之后)就又留出一段"拿不到句柄"的空窗。
  opts.onChild?.({ kill: killOnce })
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
  while (Date.now() < deadline) {
    // probe 是显式可注入的 seam(Task 9 及以后的调用方都可能传自定义实现),类型上并不禁止它 reject。
    // 一次 reject(如启动过程中的瞬时连接错误)在后端仍在起的时候是正常现象,不该直接终止等待——
    // 否则会绕过下面的 killOnce() 和返回的 kill 句柄,把子进程孤儿化。统一按"还没绿,继续轮询"
    // 处理,真正卡死不健康的情况仍会在 deadline 到点时被下面的兜底 kill+throw 收掉。
    let healthy = false
    try {
      healthy = await probe(url)
    } catch {
      healthy = false
    }
    if (healthy) return { url, kill: killOnce, exited }
    // 探针和退出通知有竞态（子进程可能在这一轮探完之后才死），所以判在探完之后：一旦它退了，
    // 再探多少次都不会绿。
    if (exitInfo) {
      throw new Error(
        `backend exited before it answered ${url}/api/health ` +
        `(${cmd} → code=${exitInfo.code} signal=${exitInfo.signal}；它自己的报错在 stderr 上）`,
      )
    }
    await sleep(opts.pollMs ?? 500)
  }
  killOnce()
  throw new Error(`backend spawn timeout: ${cmd} did not answer ${url}/api/health`)
}
