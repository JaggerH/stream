/**
 * `stream` 命令的入口（被 `scripts/build-cli.mjs` 打成 `cli/bin/stream.mjs`）。
 *
 * 不给子命令时它只做三件事：认参数、把 cwd 挪到资源目录、import 后端。**没有第四件**——
 * 发行形态的启动契约在 `cli.ts` 头注里，这里不许再长出别的逻辑。
 *
 * 子命令（`mcp` / `add` / `remove` / `recipe …`）在那三件事**之前**就分叉出去：它们
 * **不 chdir 到资源目录、不 import server.mjs**。`mcp` 是一层 stdio 壳（后端在别处，可能是
 * 它自己 spawn 的那一份），`add` / `remove` 只碰 `<dataDir>/recipes/`，`recipe run` 是打后端
 * HTTP 的薄客户端。走进 chdir 那条路的代价不是慢一点，是**在这个进程里把整个后端起起来**。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import { parseCliArgs, envForServer, defaultDataDir, HELP } from './cli.ts'

declare const __STREAM_CLI_VERSION__: string | undefined

const opts = parseCliArgs(process.argv.slice(2))

if (opts.unknown.length) {
  console.error(`stream: 不认识的参数 ${opts.unknown.join(' ')}\n`)
  console.error(HELP)
  process.exit(2)
}
if (opts.help) {
  console.log(HELP)
  process.exit(0)
}
if (opts.version) {
  console.log(typeof __STREAM_CLI_VERSION__ === 'string' ? __STREAM_CLI_VERSION__ : 'dev')
  process.exit(0)
}
if (opts.error) {
  console.error(`stream: ${opts.error}\n`)
  process.exit(2)
}

if (opts.command) {
  if (opts.command.kind === 'mcp') {
    // **stdout 从这一刻起只有 JSON-RPC**：日志一律走 stderr（runMcpCommand 自己守着这条）。
    const { runMcpCommand } = await import('./mcp-command.ts')
    // `--port` / `--data` 不能被静默吞掉：探针和「探不到就替你起一份」都要照这两个值走，不然
    // 用户传了 `--port 9001` 却看着命令探/起在 8900 上，百思不得其解。显式 flag 优先于环境里
    // 已经有的 STREAM_BACKEND_URL / STREAM_DATA_DIR。
    const env = { ...process.env }
    if (opts.port) env.STREAM_BACKEND_URL = `http://127.0.0.1:${opts.port}`
    if (opts.dataDir) env.STREAM_DATA_DIR = opts.dataDir
    await runMcpCommand({ env })
  } else if (opts.command.kind === 'recipe-run') {
    const { runRecipeRunCommand } = await import('./recipe-run.ts')
    const { DEFAULT_BACKEND_URL } = await import('./mcp-command.ts')
    // `--port` 优先于环境里的 STREAM_BACKEND_URL，理由同上面 mcp 那格。
    const backendUrl = opts.port ? `http://127.0.0.1:${opts.port}` : (process.env.STREAM_BACKEND_URL ?? DEFAULT_BACKEND_URL)
    process.exitCode = await runRecipeRunCommand(opts.command, { backendUrl, apiToken: process.env.STREAM_API_TOKEN })
  } else if (opts.command.kind === 'recipe-contribute') {
    const { runRecipeContributeCommand } = await import('./recipe-contribute.ts')
    process.exitCode = await runRecipeContributeCommand(opts.command, {
      dataDir: opts.dataDir,
      selfEntry: process.argv[1],
      streamVersion: typeof __STREAM_CLI_VERSION__ === 'string' ? __STREAM_CLI_VERSION__ : 'dev',
    })
  } else {
    const { runAddCommand, runRemoveCommand, runUpdateCommand, runRestartCommand } = await import('./add-command.ts')
    // `--port` 优先于环境里的 STREAM_BACKEND_URL，理由同上面 mcp 那格：探的是哪个后端就装到哪个后端。
    const env = { ...process.env }
    if (opts.port) env.STREAM_BACKEND_URL = `http://127.0.0.1:${opts.port}`
    const shared = { env, dataDir: opts.dataDir, selfEntry: process.argv[1] }
    process.exitCode = opts.command.kind === 'restart'
      ? await runRestartCommand(opts.command, shared)
      : opts.command.kind === 'add'
        ? await runAddCommand(opts.command, { ...shared, restartFlag: opts.command.restart })
        : opts.command.kind === 'update'
          ? await runUpdateCommand(opts.command, { ...shared, restartFlag: opts.command.restart })
          : await runRemoveCommand(opts.command, { ...shared, restartFlag: opts.command.restart })
  }
} else {
  const here = dirname(fileURLToPath(import.meta.url))
  const resources = join(here, '..', 'resources')
  const server = join(resources, 'server.mjs')
  if (!existsSync(server)) {
    // 空壳包的样子：装上了、命令在、一跑就找不到后端。`prepack` 那道闸拦的就是这个，
    // 但万一漏过去了，这里要说人话而不是抛一个 ERR_MODULE_NOT_FOUND。
    console.error(`stream: 这份安装里没有后端（${server} 不在）——包可能是空壳，重装一次：npm i -g @streamapp/stream`)
    process.exit(1)
  }

  const dataDir = opts.dataDir ?? defaultDataDir()
  mkdirSync(dataDir, { recursive: true })
  Object.assign(process.env, envForServer(opts))

  // **cwd 必须是资源目录**：后端按相对路径找内置包和那份 job 清单。这一步漏了，症状是
  // "一个源都没有"而不是报错。
  process.chdir(resources)

  console.log(`[stream] 数据目录 ${dataDir}`)
  console.log(`[stream] 起来之后打开 http://127.0.0.1:${process.env.STREAM_PORT ?? 8900}`)

  await import(pathToFileURL(server).href)
}
