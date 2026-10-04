import { existsSync, mkdtempSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { classifyLauncher, reexecSelf, RESTART_EXIT_CODE, RESTART_SENTINEL, touchRestartSentinel } from './policy.ts'

describe('classifyLauncher', () => {
  it('systemd（INVOCATION_ID）或 STREAM_SUPERVISED=1 → supervised；否则 reexec', () => {
    expect(classifyLauncher({ INVOCATION_ID: 'abc' })).toBe('supervised')
    expect(classifyLauncher({ STREAM_SUPERVISED: '1' })).toBe('supervised')
    expect(classifyLauncher({})).toBe('reexec')
    expect(classifyLauncher({ STREAM_SUPERVISED: '0' })).toBe('reexec')
  })
  // INVOCATION_ID 会被 systemd 用户服务拉起的 scope / 终端继承：`systemd-run --user --scope` 里的 `pnpm dev`
  // 不显式说自己是 watch/reexec 就会被判成 supervised → 退 75 → tsx watch 不拉起 → 后端死到下一次改文件。
  it('显式 STREAM_RESTART_MODE 压过自动判；不认识的值当没设', () => {
    expect(classifyLauncher({ INVOCATION_ID: 'abc', STREAM_RESTART_MODE: 'reexec' })).toBe('reexec')
    expect(classifyLauncher({ INVOCATION_ID: 'abc', STREAM_RESTART_MODE: 'watch' })).toBe('watch')
    expect(classifyLauncher({ STREAM_RESTART_MODE: 'supervised' })).toBe('supervised')
    expect(classifyLauncher({ INVOCATION_ID: 'abc', STREAM_RESTART_MODE: 'garbage' })).toBe('supervised')
    expect(classifyLauncher({ STREAM_RESTART_MODE: '' })).toBe('reexec')
  })
  it('退出码是 75（EX_TEMPFAIL），监护者据此再拉起', () => expect(RESTART_EXIT_CODE).toBe(75))
})

describe('touchRestartSentinel', () => {
  it('没有就建、有就推 mtime；文件名不是 dotfile（tsx 的 watcher 固定忽略 `**/.*`）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stream-sentinel-'))
    const path = join(dir, 'restart-sentinel')
    touchRestartSentinel(path)
    expect(existsSync(path)).toBe(true)
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(path, old, old)
    touchRestartSentinel(path)
    expect(statSync(path).mtimeMs).toBeGreaterThan(old.getTime())
    expect(basename(RESTART_SENTINEL)).toBe('restart-sentinel')
  })
})

describe('reexecSelf', () => {
  it('用同一个可执行文件 + 同一串 execArgv + 同一串参数 detached 起一份，然后 unref', () => {
    const unref = vi.fn()
    const spawn = vi.fn(() => ({ unref }))
    reexecSelf({
      spawn: spawn as never, execPath: '/usr/bin/node',
      execArgv: ['--import', 'tsx'],   // dev 跑在 tsx 下：丢了它，裸 node 起 serve.ts 直接失败
      argv: ['/usr/bin/node', 'serve.ts', '--port', '8900'], env: { A: '1' },
    })
    expect(spawn).toHaveBeenCalledWith('/usr/bin/node', ['--import', 'tsx', 'serve.ts', '--port', '8900'], expect.objectContaining({ detached: true, stdio: 'inherit', env: { A: '1' } }))
    expect(unref).toHaveBeenCalled()
  })
})
