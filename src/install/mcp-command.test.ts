import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { runMcpCommand, resolveSelfSpawnCmd, MCP_PROBE_TIMEOUT_MS } from './mcp-command.ts'

/** 一个够用的假 MCP Server：只要能 `connect` / `close`，`runMcpCommand` 就走得完。 */
function fakeServer() {
  const server = {
    connected: false,
    closed: false,
    async connect() { this.connected = true },
    async close() { this.closed = true },
  }
  return server
}

function harness(over: Record<string, unknown> = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const lines: string[] = []
  const exits: number[] = []
  const server = fakeServer()
  const deps = {
    stdin,
    stdout,
    log: (l: string) => void lines.push(l),
    exit: (c: number) => void exits.push(c),
    buildForward: vi.fn(async () => server as never),
    env: {} as NodeJS.ProcessEnv,
    ...over,
  }
  return { stdin, stdout, lines, exits, server, deps }
}

describe('stream mcp', () => {
  it('后端在场 → 只转发，一次都不 spawn', async () => {
    const spawnBackend = vi.fn()
    const h = harness({ probe: vi.fn(async () => true), spawnBackend })
    await runMcpCommand(h.deps as never)
    expect(spawnBackend).not.toHaveBeenCalled()
    expect(h.deps.buildForward).toHaveBeenCalledWith('http://127.0.0.1:8900')
    expect(h.server.connected).toBe(true)
  })

  it('STREAM_BACKEND_URL 指到哪就探哪、转发到哪', async () => {
    const h = harness({
      probe: vi.fn(async () => true),
      env: { STREAM_BACKEND_URL: 'http://127.0.0.1:9001' } as NodeJS.ProcessEnv,
    })
    await runMcpCommand(h.deps as never)
    expect(h.deps.buildForward).toHaveBeenCalledWith('http://127.0.0.1:9001')
  })

  /** 不在场 → 拉起一份，**拉起之后才转发**（转发档连的是那份刚起来的后端）。 */
  it('后端不在场 → spawn 一份再转发', async () => {
    const kill = vi.fn()
    const spawnBackend = vi.fn(async () => ({ url: 'http://127.0.0.1:8900', kill }))
    const h = harness({ probe: vi.fn(async () => false), spawnBackend })
    await runMcpCommand(h.deps as never)
    expect(spawnBackend).toHaveBeenCalledTimes(1)
    expect(h.deps.buildForward).toHaveBeenCalledWith('http://127.0.0.1:8900')
    expect(h.lines.some((l) => l.startsWith('[stream mcp]'))).toBe(true)
  })

  /**
   * **探测只做一次。** 中途切换意味着工具面在会话中间变，而宿主的工具快照跟不上——表现是
   * 模型照着一份过期清单调一个已经不在的工具。
   */
  it('探测只做一次', async () => {
    const probe = vi.fn(async () => true)
    const h = harness({ probe })
    await runMcpCommand(h.deps as never)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:8900', MCP_PROBE_TIMEOUT_MS)
  })

  it('拉不起来 → 说人话并以非 0 退出，不吊死在那儿', async () => {
    const h = harness({
      probe: vi.fn(async () => false),
      spawnBackend: vi.fn(async () => { throw new Error('backend spawn timeout') }),
    })
    await runMcpCommand(h.deps as never)
    expect(h.exits).toEqual([1])
    expect(h.lines.join('\n')).toMatch(/spawn timeout|起不来|拉起/)
  })

  /** stdin 的 'end' 是宿主松手的信号：收摊 → 关 server → 退出码 0。 */
  it('stdin 关掉 → 关 server、退出 0', async () => {
    const h = harness({ probe: vi.fn(async () => true) })
    await runMcpCommand(h.deps as never)
    // `resume()` 模拟 StdioServerTransport 把 stdin 置于流动态——不流动的话 'end' 永远不来。
    h.stdin.resume()
    h.stdin.end()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(h.server.closed).toBe(true)
    expect(h.exits).toEqual([0])
  })

  /** 我们拉起来的那份后端是**我们的**：会话结束就收掉，别留一个没人认领的常驻进程。 */
  it('自己 spawn 的后端在收摊时被杀掉', async () => {
    const kill = vi.fn()
    const h = harness({
      probe: vi.fn(async () => false),
      spawnBackend: vi.fn(async () => ({ url: 'http://127.0.0.1:8900', kill })),
    })
    await runMcpCommand(h.deps as never)
    // `resume()` 模拟 StdioServerTransport 把 stdin 置于流动态——不流动的话 'end' 永远不来。
    h.stdin.resume()
    h.stdin.end()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(kill).toHaveBeenCalled()
  })

  /** 宿主也可能直接发信号收摊，不先 end stdin。漏接的代价是我们自己 spawn 的那份后端成孤儿，
   *  进程退出后仍占着端口。 */
  it('收到 SIGTERM → 走收摊路径、杀掉自己 spawn 的后端', async () => {
    const kill = vi.fn()
    const handlers: Record<string, Array<() => void>> = {}
    const proc = { on: (ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb) } }
    const h = harness({
      probe: vi.fn(async () => false),
      spawnBackend: vi.fn(async () => ({ url: 'http://127.0.0.1:8900', kill })),
      proc,
    })
    await runMcpCommand(h.deps as never)
    handlers.SIGTERM.forEach((cb) => cb())
    await new Promise((r) => setImmediate(r))
    expect(h.server.closed).toBe(true)
    expect(kill).toHaveBeenCalled()
    expect(h.exits).toEqual([0])
  })

  it('收到 SIGINT → 同样走收摊路径', async () => {
    const handlers: Record<string, Array<() => void>> = {}
    const proc = { on: (ev: string, cb: () => void) => { (handlers[ev] ??= []).push(cb) } }
    const h = harness({ probe: vi.fn(async () => true), proc })
    await runMcpCommand(h.deps as never)
    handlers.SIGINT.forEach((cb) => cb())
    await new Promise((r) => setImmediate(r))
    expect(h.server.closed).toBe(true)
    expect(h.exits).toEqual([0])
  })

  /** 转发建不起来（后端刚被我们拉起来又秒退、地址写错…）不许悬着——宿主看到的是"连得上、
   *  `tools/list` 却永远超时"，比一个干脆的失败更难查。 */
  it('转发建不起来 → 杀掉自己 spawn 的后端、非 0 退出，不留 unhandled rejection', async () => {
    const kill = vi.fn()
    const h = harness({
      probe: vi.fn(async () => false),
      spawnBackend: vi.fn(async () => ({ url: 'http://127.0.0.1:8900', kill })),
      buildForward: vi.fn(async () => { throw new Error('connect ECONNREFUSED') }),
    })
    await runMcpCommand(h.deps as never)
    expect(kill).toHaveBeenCalled()
    expect(h.exits).toEqual([1])
    expect(h.lines.join('\n')).toMatch(/ECONNREFUSED/)
  })

  /** 包更新闭环:后端因 `POST /api/restart` 以 RESTART_EXIT_CODE(75)退出——这层壳负责再拉起
   *  一份;转发目标是 URL 不是进程,forward server 不用动。别的退出码不拉起:崩溃循环不是我们的事。 */
  it('后端以 75 退出 → 再 spawn 一份；其他退出码不拉起', async () => {
    let exitResolve!: (v: { code: number | null; signal: null }) => void
    const spawns: number[] = []
    const spawnBackend = vi.fn(async () => {
      spawns.push(1)
      return { url: 'http://127.0.0.1:8900', kill: vi.fn(), exited: new Promise<{ code: number | null; signal: null }>((r) => { exitResolve = r }) }
    })
    const h = harness({ probe: vi.fn(async () => false), spawnBackend })
    await runMcpCommand(h.deps as never)
    exitResolve({ code: 75, signal: null })
    await new Promise((r) => setImmediate(r))
    expect(spawns.length).toBe(2)
  })

  /** respawn 那一支是独立的 promise 链(`s.exited.then(...)`),第二次 spawn 失败绝不能变成
   *  unhandled rejection 拖垮整个壳(连同已经在正常工作的转发档)。不重试、不设上限——
   *  RESTART_EXIT_CODE 只来自受控的 `POST /api/restart`,失败了就认了,转发目标(URL)不变,
   *  等下一次工具调用自然再探。 */
  it('重启后再拉起失败 → 不是 unhandled rejection,只记日志,旧 handle 保留', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
      let exitResolve!: (v: { code: number | null; signal: null }) => void
      const oldKill = vi.fn()
      const spawnBackend = vi.fn()
        .mockImplementationOnce(async () => ({
          url: 'http://127.0.0.1:8900',
          kill: oldKill,
          exited: new Promise<{ code: number | null; signal: null }>((r) => { exitResolve = r }),
        }))
        .mockImplementationOnce(async () => { throw new Error('backend spawn timeout') })
      const h = harness({ probe: vi.fn(async () => false), spawnBackend })
      await runMcpCommand(h.deps as never)
      exitResolve({ code: 75, signal: null })
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(spawnBackend).toHaveBeenCalledTimes(2)
      expect(h.lines.join('\n')).toMatch(/重启后再拉起失败/)
      // 收摊路径杀的还是旧 handle(第二次 spawn 没成功,`spawned` 没被替换)。
      h.stdin.resume()
      h.stdin.end()
      await new Promise((r) => setImmediate(r))
      expect(oldKill).toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  /** 后端本来就在场时，它不是我们起的——**绝不能杀**。 */
  it('别人起的后端不许被收摊路径杀掉', async () => {
    const spawnBackend = vi.fn()
    const h = harness({ probe: vi.fn(async () => true), spawnBackend })
    await runMcpCommand(h.deps as never)
    // `resume()` 模拟 StdioServerTransport 把 stdin 置于流动态——不流动的话 'end' 永远不来。
    h.stdin.resume()
    h.stdin.end()
    await new Promise((r) => setImmediate(r))
    expect(spawnBackend).not.toHaveBeenCalled()
  })
})

/**
 * 拉起来的必须是**这一份 `bin/stream.mjs` 自己**（不带子命令）。
 * 老的 `resolveSpawnCmd` 按 `../serve.ts` 相对自身解析——那在打包产物里指向 `cli/serve.ts`，
 * 根本不存在，spawn 会以一个和端口无关的错失败。
 */
describe('拉起后端用哪条命令', () => {
  it('默认 = 当前 node + 自己这个入口，路径原样传（不拼成字符串——Windows 路径里有空格）', () => {
    const r = resolveSelfSpawnCmd({}, '/usr/lib/node_modules/@streamapp/stream/bin/stream.mjs', '/usr/bin/node')
    expect(r).toEqual({ cmd: '/usr/bin/node', args: ['/usr/lib/node_modules/@streamapp/stream/bin/stream.mjs'] })
  })

  it('STREAM_BACKEND_CMD 显式给了就听它（与 spawn-backend 的梯子同一条规矩）', () => {
    const r = resolveSelfSpawnCmd({ STREAM_BACKEND_CMD: 'pnpm dev' }, '/x/bin/stream.mjs', '/usr/bin/node')
    expect(r).toEqual({ cmd: 'pnpm', args: ['dev'] })
  })
})
