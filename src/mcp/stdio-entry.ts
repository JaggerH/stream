// stdio MCP entry — spawned on-demand by an MCP client (Claude Desktop's `mcpServers`, etc.),
// no listening port, no standing backend required. See docs/superpowers/specs/
// 2026-07-20-mcp-transport-decouple-design.md.
//
// Import order mirrors serve.ts's guard (serve.ts:6-12): owned-outbound MUST load before
// anything that transitively pulls in bootstrap.ts (which unconditionally constructs
// RssHubAdapter — the trigger for RSSHub's request-rewriter global-fetch monkeypatch).
import '../load-env.ts'
import '../http/owned-outbound.ts'

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startStdio, createMcpServer } from './server.ts'
import type { StreamServiceLike } from './tools.ts'
import type { McpExtras } from './tool-catalog.ts'
import { bootstrap, loadConfig, type Boot } from '../bootstrap.ts'
import { quiesceKernel } from '../kernel/context.ts'
import { probeBackend } from '../../shared/mcp/probe-backend.ts'
import { buildDiskService } from './disk-service.ts'
import { makeBackendForwardServer } from '../../shared/mcp/backend-forward.ts'
import { makeSpawnRouter } from './spawn-router.ts'

export interface ChooseServiceOpts {
  backendUrl?: string
  probe?: (url: string) => Promise<boolean>
  buildForward?: (url: string) => Promise<Server>
  buildDisk?: () => Promise<{ service: StreamServiceLike; extras: McpExtras; boot: Boot }>
}

export type ChooseServiceResult =
  | { kind: 'forward'; server: Server }
  | { kind: 'disk'; service: StreamServiceLike; extras: McpExtras; boot: Boot }

const defaultBuildDisk = async (): Promise<{ service: StreamServiceLike; extras: McpExtras; boot: Boot }> => {
  const config = loadConfig()
  // Reuse bootstrap() as-is (finding #3) — it only CONSTRUCTS stores/registry/scheduler, it
  // never starts the harvest loop by itself. We must never call the scheduler's start() below —
  // that is what would actually make this process a second writer.
  const boot = await bootstrap(config) // log defaults to console.error — stdout stays the JSON-RPC channel
  const { service, extras } = buildDiskService({
    // 采集面住内核的 `ctx.scheduling`（Scheduler + StreamService 在同一个域，真环在那儿闭合）。
    service: boot.kernel.scheduling.service,
    scheduler: boot.kernel.scheduling.scheduler,
    discoveredChannels: boot.kernel.stores.discoveredChannels,
    // MCP 工具面的 extras 住 agent 域——disk 档和 HTTP 档吃的是同一份（同一个进程装配出来的
    // 那一个对象），所以两面暴露的能力集永远一致。
    mcpExtras: boot.kernel.agent.mcpExtras,
    // 写闸门要关的是**活体那个实例**：`disableWrites()` 就地翻标志，靠的是所有持有方
    // （ProviderExecutor / ResolveEngine / bootstrap 的搜索闭包）抓的都是同一个对象。
    providerStats: boot.kernel.provider.providerStats,
  })
  return { service, extras, boot }
}

/** D3: probe for a live backend, pick backend-forward or disk-service. Pure selection logic,
 *  factored out of main() so it's testable without real stdin/stdout or a real bootstrap(). */
export async function chooseService(opts: ChooseServiceOpts = {}): Promise<ChooseServiceResult> {
  const backendUrl = opts.backendUrl ?? process.env.STREAM_BACKEND_URL ?? 'http://127.0.0.1:8900'
  const probe = opts.probe ?? probeBackend
  const present = await probe(backendUrl)
  if (present) {
    const server = await (opts.buildForward ?? makeBackendForwardServer)(backendUrl)
    return { kind: 'forward', server }
  }
  const { service, extras, boot } = await (opts.buildDisk ?? defaultBuildDisk)()
  return { kind: 'disk', service, extras, boot }
}

export interface WireShutdownOpts {
  /** Injectable for tests — defaults to the real `process`. */
  proc?: NodeJS.EventEmitter
  /** Injectable for tests — defaults to the real `process.stdin`. */
  stdin?: NodeJS.EventEmitter
  /** Injectable for tests — defaults to `process.exit`. */
  exit?: (code: number) => void
}

/** Unify shutdown across both chooseService branches (review findings on Task 4.1):
 *  1. Both branches must close on stdin EOF *and* SIGINT *and* SIGTERM — the disk branch alone
 *     used to wire signals, so an MCP client killing the forward-branch subprocess via SIGTERM
 *     (the common case — clients don't reliably just close stdin) skipped cleanup entirely and
 *     left the forward branch's backend HTTP client (onclose→client.close() in backend-forward.ts)
 *     dangling.
 *  2. A reentrancy guard: if stdin-EOF and a signal fire close together, only the first caller
 *     runs `cleanup`; the second is a no-op instead of racing a second `process.exit` that could
 *     truncate the first cleanup mid-flight (e.g. an in-flight cloak browser close, leaving an
 *     orphaned browser with a stale SingletonLock).
 *  Returns the guarded shutdown function so callers/tests can trigger it directly too. */
export function wireShutdown(cleanup: () => Promise<void>, opts: WireShutdownOpts = {}): () => Promise<void> {
  const proc = opts.proc ?? process
  const stdin = opts.stdin ?? process.stdin
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await cleanup()
    } catch (e) {
      console.error('[stream-mcp-stdio] shutdown error:', (e as Error).message)
    } finally {
      exit(0)
    }
  }
  stdin.once('end', () => void shutdown())
  proc.on('SIGINT', () => void shutdown())
  proc.on('SIGTERM', () => void shutdown())
  return shutdown
}

/** 判 disk 分支走不走 spawn 路由。STREAM_STDIO_NO_SPAWN=1 是回到 D6 老行为(动作工具永不 spawn)的
 *  逃生口;抽成具名函数只是为了这条开关本身可测,语义与原来的内联判断逐字等价。 */
export function spawnRouterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STREAM_STDIO_NO_SPAWN !== '1'
}

async function main() {
  const choice = await chooseService()
  const transport = new StdioServerTransport()

  if (choice.kind === 'forward') {
    await choice.server.connect(transport)
    // Build-time-verify (plan Task 4.1): checked against the installed SDK
    // (server/stdio.js) — StdioServerTransport only wires stdin 'data'/'error' listeners, never
    // 'end'/'close', so `onclose` does NOT fire on its own when the client side closes stdin.
    // Close explicitly on EOF/SIGINT/SIGTERM so the client.close() hook wired in
    // backend-forward.ts still runs and the backend HTTP connection doesn't linger.
    wireShutdown(async () => {
      await choice.server.close()
    })
    return
  }

  const boot = choice.boot

  // NO_SPAWN is the escape hatch back to D6's original behavior (action tools never spawn a
  // backend) — this branch must stay byte-for-byte identical to pre-Task-9 stdio-entry so the
  // existing regression tests keep gating it untouched.
  if (!spawnRouterEnabled()) {
    const mcpServer = await startStdio(choice.service, choice.extras)
    const shutdown = wireShutdown(async () => {
      await mcpServer.server.close()
      // 落盘句柄、adapter 子进程（`scheduler.shutdownAdapters()`）、采集定时器全都登记在内核上，
      // 一次销毁全撤——不再逐个手写 close。
      await quiesceKernel(boot.kernel).catch(() => {})
    })
    // Belt-and-braces: if the server closes for a reason other than our own shutdown() (e.g. the
    // client disconnects the transport), still run the guarded cleanup — the reentrancy guard
    // makes this safe to call alongside the stdin/SIGINT/SIGTERM triggers above.
    mcpServer.server.onclose = () => void shutdown()
    return
  }

  // Task 9: revises D6 — stay on disk for reads; the moment an action tool's result carries
  // NeedsBackendError's needs_backend marker, spawn a real backend and flip every call from then
  // on (including the triggering one, replayed) to it. `diskMcpServer.server` is the low-level
  // Server McpServer wraps (McpServer.connect just delegates to it — server.ts's own shutdown
  // wiring already relies on that via `mcpServer.server`), so it's the right shape for
  // makeSpawnRouter's `disk` input without needing a second tool-catalog build.
  const diskMcpServer = createMcpServer(choice.service, choice.extras)
  const { server: routedServer, killSpawned, close: closeRouter } = await makeSpawnRouter({ disk: diskMcpServer.server })
  await routedServer.connect(transport)
  const shutdown = wireShutdown(async () => {
    await routedServer.close()
    // 只杀本进程自己 spawn 出来的后端;若全程停留在 disk 分支(从没触发 spawn),spawn-router.ts
    // 里 spawned 仍是 null,killSpawned() 是 no-op——与「找到已有实例就不动它」的 forward 分支同规。
    // killSpawned() 先跑:它同时立起路由内部的关停旗标,让一次**在途**的 spawn 落地后自己把子进程杀掉,
    // 而不是挂到一个再也没人读的句柄上。
    killSpawned()
    // 路由的内部清理必须显式调:它自己不再挂 onclose(下面这行 routedServer.onclose 会盖掉它)。
    // 这个 await 还兼着一件要命的事:closeRouter() 内部会**等一次在途 spawn 落定**(有上限)。
    // 少了它,killSpawned() 立起的旗标只是排了一个还没跑的自杀续段,而 wireShutdown 紧接着
    // exit(0) —— 续段永远等不到,子进程被 reparent 活下来占着端口。
    await closeRouter()
    // 同上：落盘句柄与 adapter 子进程由内核的 effect 统一撤销。
    await quiesceKernel(boot.kernel).catch(() => {})
  })
  routedServer.onclose = () => void shutdown()
}

if (!process.env.VITEST) {
  main().catch((e) => {
    console.error('[stream-mcp-stdio] fatal:', e)
    process.exit(1)
  })
}
