/**
 * `stream mcp` —— 宿主（Claude Code / Codex）那一行指向 Stream 的**唯一形态**：
 * 一层 stdio 壳，把 `tools/list` / `tools/call` 原样转给后端的 `/api/mcp`。
 *
 * **它不装载任何东西。** 聚合者只有一个——后端进程。工具逻辑全在那一头的
 * `createMcpServer()` 里执行，这里连一个 StreamService 都不建（结构上就打不开本地库）。
 *
 * 探不到后端就替用户起一份（等 `/api/health` 变绿再转发）。起的是**同一份
 * `bin/stream.mjs`**，不是另一条启动路径——发行形态的运行契约只有一份（`cli.ts` 头注）。
 *
 * **两个宿主同时在无后端时跑 `stream mcp`**：各自 probe 落空、各自 spawn 一份；后起的那份在
 * `STREAM_PORT` 上撞 `EADDRINUSE` 秒退，但这时先起的那份多半已经把 `/api/health` 顶上去了——
 * 后起这边的探针轮询还在继续，探到就照样转发成功。退化是良性的：代价是白 spawn 一次、日志里
 * 多一条子进程的退出记录，不是转发失败。
 *
 * **冒烟这条命令拉起的是真后端**：真 `dataDir`、真 `packages`，standby 会照单收编用户已有的
 * 容器、进程退出时会把它们 stop 掉。冒烟前必须把 `STREAM_DATA_DIR` 换成隔离的临时目录，并显式
 * `STREAM_PLUGIN_NETWORK=none`——否则冒烟一次就把用户正在用的容器停了。
 */
import { spawnBackend, type SpawnedBackend } from '../mcp/spawn-backend.ts'
import { resolveSpawnCmd } from '../mcp/spawn-backend.ts'
import { probeBackend } from '../../shared/mcp/probe-backend.ts'
import { makeBackendForwardServer } from '../../shared/mcp/backend-forward.ts'
import { RESTART_EXIT_CODE } from '../restart/policy.ts'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Readable, Writable } from 'node:stream'

/** 探一次给 2s。探不到就当"不在场"去拉起——宁可多起一份，也不要在一个可能永远不来的后端上干等。 */
export const MCP_PROBE_TIMEOUT_MS = 2000

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8900'

/** 一个"能连能关"的 MCP server —— 这里只用到这两件，所以类型也只要这两件（转发档给的是
 *  SDK 的 `Server`，测试给的是个假的）。 */
export interface ForwardServer {
  connect(transport: StdioServerTransport): Promise<void>
  close(): Promise<void>
}

/**
 * 后端该用哪条命令起。
 *
 * 默认是**这一份 `bin/stream.mjs` 自己，不带子命令**（= 起后端那条老路）。不能用
 * `spawn-backend.ts` 的默认梯子：那条按 `../serve.ts` 相对自身解析，在打包产物里指向
 * `cli/serve.ts`——一个不存在的文件。
 *
 * `STREAM_BACKEND_CMD` 显式给了仍然听它（与那条梯子同一条规矩），其余情况**把路径原样放进
 * argv**，不拼成一个字符串再切词——Windows 上 node 的路径里就有空格。
 */
export function resolveSelfSpawnCmd(
  env: NodeJS.ProcessEnv,
  selfEntry: string,
  execPath: string,
): { cmd: string; args: string[] } {
  if (env.STREAM_BACKEND_CMD?.trim()) return resolveSpawnCmd(env, import.meta.url)
  return { cmd: execPath, args: [selfEntry] }
}

export interface McpCommandDeps {
  env?: NodeJS.ProcessEnv
  stdin?: Readable
  stdout?: Writable
  /** 默认写 stderr。**stdout 永远只有 JSON-RPC**——往那儿打一个字就把这条 MCP 连接弄坏了。 */
  log?(line: string): void
  exit?(code: number): void
  probe?(baseUrl: string, timeoutMs: number): Promise<boolean>
  buildForward?(backendUrl: string): Promise<ForwardServer>
  spawnBackend?(opts: Parameters<typeof spawnBackend>[0]): Promise<SpawnedBackend>
  /** 这一份可执行入口的路径（拉起后端时要再跑一次它）。默认 `process.argv[1]`。 */
  selfEntry?: string
  execPath?: string
  /** 收 SIGTERM/SIGINT 的那个对象，默认 `process`。测试注入一个假的以触发信号路径而不必真的
   *  给这个测试进程发信号。 */
  proc?: Pick<NodeJS.Process, 'on'>
}

export async function runMcpCommand(deps: McpCommandDeps = {}): Promise<void> {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((line: string) => void process.stderr.write(`${line}\n`))
  // 退出走两级，缺一不可（照 hub 那份写法，理由一字不差）：
  // 1. 置 `exitCode` + 关掉 server（连带摘掉 stdio transport 对 stdin 的监听）让进程**自然**退。
  //    不用 `process.exit()` 收尾——它不等 stderr 的写落地，管道那一端会把最后那行整个截掉，
  //    而那行正是"我是自己走完收摊的，不是被打死的"的唯一证据。
  // 2. 1s 之后强退兜底。某个没关的句柄会把事件循环吊住，表现是宿主那边"关掉了还占着"。
  //    定时器自己 unref，所以它从不推迟第 1 级的自然退出。
  const exit = deps.exit ?? ((code: number) => {
    process.exitCode = code
    setTimeout(() => process.exit(code), 1000).unref()
  })
  const probe = deps.probe ?? probeBackend
  const forward = deps.buildForward ?? ((url: string) => makeBackendForwardServer(url))
  const spawn = deps.spawnBackend ?? spawnBackend
  const stdin = deps.stdin ?? process.stdin
  const stdout = deps.stdout ?? process.stdout

  const backendUrl = env.STREAM_BACKEND_URL ?? DEFAULT_BACKEND_URL

  // **探测只做一次。** 后端中途起来 / 停掉都不切换——切换意味着工具面在会话中间变，而宿主的
  // 工具快照跟不上；表现是模型照着一份过期清单调一个已经不在的工具。要切就重开会话。
  const present = await probe(backendUrl, MCP_PROBE_TIMEOUT_MS)

  /** 我们自己拉起来的那份。别人起的后端不在这里——**收摊时只杀我们自己的**。 */
  let spawned: SpawnedBackend | undefined
  if (present) {
    log(`[stream mcp] forwarding to ${backendUrl}`)
  } else {
    log(`[stream mcp] ${backendUrl} 上没人应答，替你起一份后端…`)
    // 与第一次调用完全相同的参数——respawn 那一份重用它,别让两条路径漂移。
    const spawnOpts: Parameters<typeof spawn>[0] = {
      env,
      resolveCmd: (e) => resolveSelfSpawnCmd(
        e,
        deps.selfEntry ?? process.argv[1],
        deps.execPath ?? process.execPath,
      ),
    }
    try {
      spawned = await spawn(spawnOpts)
    } catch (err) {
      // 拉不起来就说清楚是哪一步坏的然后退出。**不许接着往下走**：转发档会连到一个没人听的
      // 地址，宿主那边看到的是一个连得上、`tools/list` 却永远超时的 MCP server。
      log(`[stream mcp] 后端拉起失败：${(err as Error).message}`)
      log(`[stream mcp] 先自己跑一次 \`stream\` 看它报什么，或用 STREAM_BACKEND_URL 指向已经在跑的那一份。`)
      exit(1)
      return
    }
    log(`[stream mcp] 后端已起（这一份不跑采集调度；要采集就另外跑 \`stream\`），转发到 ${spawned.url}`)

    // 后端自己重启（`POST /api/restart`）时以 RESTART_EXIT_CODE 退出，这层壳负责再拉起——
    // 转发目标是 URL 不是进程，所以 forward server 不用动。别的退出码不拉起：崩溃循环不是我们的事。
    // 老夹具（未提供 `exited`）里这个 promise 是 undefined，`?.then` 让它安全地什么都不做。
    const respawnLoop = (s: SpawnedBackend): void => {
      void s.exited?.then(async (info) => {
        if (info.code !== RESTART_EXIT_CODE) return
        log(`[stream mcp] 后端按请求重启（exit ${info.code}），再拉起一份`)
        try {
          const next = await spawn(spawnOpts)
          spawned = next
          respawnLoop(next)
        } catch (err) {
          // RESTART_EXIT_CODE 只来自受控的 `POST /api/restart`，不是崩溃循环，所以这里**不重试、
          // 不设上限/退避**——重试逻辑属于"对付不受信的崩溃"，用在这条受控触发上反而是画蛇添足。
          // 但必须接住：这是 respawn 那一支独立的 promise 链，不接会变成 unhandled rejection，
          // 拖垮整个 `stream mcp` 壳（连同已经在正常工作的转发档）。转发目标(URL)没变——
          // 下一次工具调用会再探一次，探不到用户自己会看到"没人应答"再决定下一步。
          log(`[stream mcp] 重启后再拉起失败：${(err as Error).message}——转发目标不变，下一次调用会再探/再拉`)
        }
      })
    }
    respawnLoop(spawned)
  }

  // 连不上（后端刚被我们拉起来又秒退、地址写错…）不许再往下走：转发档会连到一个没人听的地址，
  // 宿主那边看到的是一个连得上、`tools/list` 却永远超时的 MCP server。我们自己 spawn 的那份
  // 也不能就这么留着——没人会再来杀它。
  let server: ForwardServer
  try {
    server = await forward(backendUrl)
  } catch (err) {
    log(`[stream mcp] 连接后端失败：${(err as Error).message}`)
    spawned?.kill()
    exit(1)
    return
  }

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await server.close()
    } catch {
      // 已经关过了 / 对端先走了，都不影响退出。
    }
    // 我们起的那份是即用即回收的：会话结束就收掉，别在用户机器上留一个没人认领的常驻后端。
    spawned?.kill()
    log('[stream mcp] disposed')
    exit(0)
  }

  // stdin 的 'end' 是宿主松手的信号（客户端 close 会先 end 我们的 stdin）。
  // `StdioServerTransport` 已经把 stdin 置于流动态，所以这个事件一定到得了。
  stdin.once('end', () => void shutdown())

  // 宿主也可能直接发信号收摊（不是先 end stdin）。漏接这两个的代价是：我们自己 spawn 的那份
  // 后端成了孤儿，进程退出后仍然占着 8900。
  const proc = deps.proc ?? process
  proc.on('SIGTERM', () => void shutdown())
  proc.on('SIGINT', () => void shutdown())

  await server.connect(new StdioServerTransport(stdin, stdout))
}
