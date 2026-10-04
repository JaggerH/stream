import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { chooseService, wireShutdown, spawnRouterEnabled } from './stdio-entry.ts'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

describe('chooseService', () => {
  it('backend present → forward branch, disk branch never built', async () => {
    const probe = vi.fn(async () => true)
    const buildForward = vi.fn(async () => ({}) as Server)
    const buildDisk = vi.fn(async () => ({ service: {} as never, extras: { isCommunitySource: () => false }, boot: {} as never }))
    const result = await chooseService({ backendUrl: 'http://x', probe, buildForward, buildDisk })
    expect(result.kind).toBe('forward')
    expect(probe).toHaveBeenCalledWith('http://x')
    expect(buildForward).toHaveBeenCalledWith('http://x')
    expect(buildDisk).not.toHaveBeenCalled()
  })

  it('backend absent → disk branch, forward branch never built', async () => {
    const probe = vi.fn(async () => false)
    const buildForward = vi.fn(async () => ({}) as Server)
    const buildDisk = vi.fn(async () => ({ service: {} as never, extras: { isCommunitySource: () => false }, boot: {} as never }))
    const result = await chooseService({ backendUrl: 'http://x', probe, buildForward, buildDisk })
    expect(result.kind).toBe('disk')
    expect(buildDisk).toHaveBeenCalled()
    expect(buildForward).not.toHaveBeenCalled()
  })
})

// STREAM_STDIO_NO_SPAWN=1 是回到 D6 老行为的逃生口:disk 分支既不装 spawn 路由、也永不 spawn。
// 这条开关此前完全没有测试压着 —— 一次手滑写成 `!== '0'` 或漏掉判断,就会让明确要求「别起后端」的
// 用户悄悄多出一个后端进程,而所有既有测试照绿。
describe('spawnRouterEnabled (STREAM_STDIO_NO_SPAWN)', () => {
  it('only the exact string "1" disables the spawn router', () => {
    expect(spawnRouterEnabled({ STREAM_STDIO_NO_SPAWN: '1' })).toBe(false)
    expect(spawnRouterEnabled({})).toBe(true)
    expect(spawnRouterEnabled({ STREAM_STDIO_NO_SPAWN: '0' })).toBe(true)
    expect(spawnRouterEnabled({ STREAM_STDIO_NO_SPAWN: '' })).toBe(true)
    expect(spawnRouterEnabled({ STREAM_STDIO_NO_SPAWN: 'true' })).toBe(true)
  })
})

// Review findings on Task 4.1 (commit 2d83b1dd):
//   1. Asymmetric signal handling — the forward branch only listened for stdin 'end', not
//      SIGINT/SIGTERM, so an MCP client killing the subprocess via signal (the common case)
//      skipped cleanup entirely.
//   2. No shutdown reentrancy guard — a stdin-EOF and a signal racing could both reach
//      `process.exit` and truncate each other's in-flight cleanup (orphaned cloak browser /
//      stale SingletonLock).
// wireShutdown() is the fix: both chooseService branches now route their cleanup through it, so
// these tests exercise it directly rather than main() (which owns real stdin/process wiring).
describe('wireShutdown', () => {
  it('installs handlers for stdin end, SIGINT, and SIGTERM — not stdin alone', async () => {
    const proc = new EventEmitter()
    const stdin = new EventEmitter()
    const cleanup = vi.fn(async () => {})
    wireShutdown(cleanup, { proc, stdin, exit: vi.fn() })

    // Regression guard for finding #1: the forward branch used to wire only 'end'. Both signal
    // channels must be installed alongside it.
    expect(stdin.listenerCount('end')).toBe(1)
    expect(proc.listenerCount('SIGINT')).toBe(1)
    expect(proc.listenerCount('SIGTERM')).toBe(1)
  })

  it('SIGTERM alone triggers cleanup (forward branch used to have no signal handler at all)', async () => {
    const proc = new EventEmitter()
    const stdin = new EventEmitter()
    const cleanup = vi.fn(async () => {})
    const exit = vi.fn()
    wireShutdown(cleanup, { proc, stdin, exit })

    proc.emit('SIGTERM')
    await Promise.resolve()
    await Promise.resolve()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('reentrancy guard: stdin end and SIGTERM racing together only run cleanup once', async () => {
    const proc = new EventEmitter()
    const stdin = new EventEmitter()
    let resolveCleanup!: () => void
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve
        }),
    )
    const exit = vi.fn()
    wireShutdown(cleanup, { proc, stdin, exit })

    // Fire both triggers back-to-back before the first cleanup has resolved — the race the
    // finding describes (stdin EOF and a signal arriving close together).
    stdin.emit('end')
    proc.emit('SIGTERM')
    proc.emit('SIGINT')
    await Promise.resolve()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()

    resolveCleanup()
    await Promise.resolve()
    await Promise.resolve()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('calling the returned shutdown function twice only runs cleanup once', async () => {
    const proc = new EventEmitter()
    const stdin = new EventEmitter()
    const cleanup = vi.fn(async () => {})
    const exit = vi.fn()
    const shutdown = wireShutdown(cleanup, { proc, stdin, exit })

    await shutdown()
    await shutdown()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1) // the second call is a pure no-op — guard returns before touching cleanup or exit
  })
})
