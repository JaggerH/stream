// capabilities/desktop/src/host-agent/default-deps.test.ts
//
// C1/I1/I2 之所以能活到最终评审，是因为 `defaultDeps()` 那条**真实**接线路径从没被测过——
// 别的测试全部注入假 spawn，永远走不到真实的 stdio/'error'/stderr 那几行。这里直接测
// `defaultDeps()` 产出的东西，用真实的 `node:child_process`（不起 host-agent 二进制本身，
// 用一个临时的可执行脚本模拟「起不来」「往 stderr 写诊断」这两种形状）。
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDeps, buildSpawnOptions } from './index.ts'
import { detectWsl } from '../wsl.ts'
import { fakeCapabilityContext } from '../../../../shared/capability/test-ctx.ts'

function ctxHarness() {
  const ctx = fakeCapabilityContext()
  return { ctx, get warns() { return ctx.logs.warn } }
}

describe('buildSpawnOptions（C1：父死检测靠的是这根还留在我们手里的管道）', () => {
  it('stdin 是管道——STREAM_HOST_PARENT_WATCH 靠它读 EOF 判断父进程死没死', () => {
    const opts = buildSpawnOptions({ FOO: 'bar' })
    expect(opts.stdio[0]).toBe('pipe')
  })

  it('stdout 不需要，继续 ignore；stderr 是管道——I2 要转发它', () => {
    const opts = buildSpawnOptions({})
    expect(opts.stdio[1]).toBe('ignore')
    expect(opts.stdio[2]).toBe('pipe')
  })

  it('env 是 process.env 与传入 env 的合并，传入的优先', () => {
    const opts = buildSpawnOptions({ STREAM_HOST_URL: 'ws://x' })
    expect(opts.env.STREAM_HOST_URL).toBe('ws://x')
    expect(opts.env.PATH).toBe(process.env.PATH)
  })
})

describe('defaultDeps().agent.spawn（真实 child_process 接线）', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'capability-host-agent-test-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('I1：二进制根本不存在——spawn 发的是 error 不是 exit，不许抛出去，且照样触发 onExit（走同一条退避）', async () => {
    const { ctx, warns } = ctxHarness()
    const deps = defaultDeps(ctx)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('onExit 没有在 error 之后被调用')), 5000)
      let proc: ReturnType<typeof deps.agent.spawn>
      expect(() => {
        proc = deps.agent.spawn(join(tmpDir, 'definitely-does-not-exist'), {})
      }).not.toThrow()
      proc!.onExit(() => { clearTimeout(timeout); resolve() })
    })
    expect(warns.some((w) => w.includes('spawn 失败'))).toBe(true)
  })

  it('I2：agent 往 stderr 写的诊断被转发进 ctx.logger.warn，且带上插件前缀', async () => {
    const script = join(tmpDir, 'emit-stderr.sh')
    writeFileSync(script, '#!/bin/sh\necho "[host-agent] 拿不到 relay token" 1>&2\nexit 1\n')
    chmodSync(script, 0o755)
    const { ctx, warns } = ctxHarness()
    const deps = defaultDeps(ctx)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('没等到进程退出')), 5000)
      const proc = deps.agent.spawn(script, {})
      proc.onExit(() => { clearTimeout(timeout); resolve() })
    })
    expect(warns.some((w) => w.includes('拿不到 relay token'))).toBe(true)
  })
})

describe('defaultDeps().register（真实 spawnSync 接线，C2）', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'capability-host-agent-test-register-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('把 extensionId 真的拼进 `--extension-id <id>`，不是拼丢在半路', () => {
    const argvFile = join(tmpDir, 'argv.json')
    const script = join(tmpDir, 'record-argv.sh')
    // 假 host-agent：把自己收到的 argv 落盘，success 退出——用真实 spawnSync 走一遍，
    // 钉住 defaultDeps().register() 真的把 extensionId 拼成了 CLI flag，不只是类型对得上。
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nexit 0\n`)
    chmodSync(script, 0o755)
    const { ctx } = ctxHarness()
    const deps = defaultDeps(ctx)
    const result = deps.register(script, 'a'.repeat(32), '/data')
    expect(result.ok).toBe(true)
    const argv = readFileSync(argvFile, 'utf8').trim().split('\n')
    // argv 必须**逐字**只有这三个：一个 `--exe` 都不许再补。补进去的是 WSL 侧的 Linux 路径，
    // 会被原样写进 manifest 的 `path`，Chrome 从此报 `native messaging host not found`，
    // 而扩展那边只表现为「ws off」——没有任何一处会指向路径（见 register 头注的实测）。
    expect(argv).toEqual(['--register', '--extension-id', 'a'.repeat(32)])
  })

  it('非 0 退出码：ok=false，stderr 原样带回去（不是被吞掉）', () => {
    const script = join(tmpDir, 'fail.sh')
    writeFileSync(script, '#!/bin/sh\necho "必须给 --extension-id" 1>&2\nexit 2\n')
    chmodSync(script, 0o755)
    const { ctx } = ctxHarness()
    const deps = defaultDeps(ctx)
    const result = deps.register(script, 'a'.repeat(32), '/data')
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('必须给 --extension-id')
  })

  // Minor-2：spawn 层失败（这里用一个根本不存在的可执行文件模拟 ENOENT）落在 r.error，
  // r.stderr 这时是空的——过去会把这种情况打成「(no stderr)」，是上一轮刚修掉的那类吞错。
  it('spawn 层失败（可执行文件不存在）：ok=false，错误信息并进 stderr 里，不是「(no stderr)」', () => {
    const { ctx } = ctxHarness()
    const deps = defaultDeps(ctx)
    const result = deps.register(join(tmpDir, 'definitely-does-not-exist'), 'a'.repeat(32), '/data')
    expect(result.ok).toBe(false)
    expect(result.stderr).not.toBe('')
    expect(result.stderr.toLowerCase()).toMatch(/enoent|spawn 失败/)
  })

  // 这一条守的是**子进程真的收到了那个环境变量**，不是"我们算出了一份 env"。
  // Rust 侧 `register.rs::write_datadir_pointer()` 按自己进程的环境解析 data 目录再写
  // `~/.stream/datadir` 指针；`STREAM_DATA_DIR` 没递到的表现全都不出声——它掉回自己的默认
  // 落点，铸一份 Stream 从没碰过的 token，中继据此拒绝每一次握手，看起来就是「扩展没装」。
  // 所以判据只能是让假 agent 把自己看到的环境落盘，再读回来。
  it('把 STREAM_DATA_DIR 真的递进子进程的环境（不递 = 指针指到别处，且没有一处会喊）', () => {
    const envFile = join(tmpDir, 'env.txt')
    const script = join(tmpDir, 'record-env.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$STREAM_DATA_DIR" "$WSLENV" > "${envFile}"\nexit 0\n`)
    chmodSync(script, 0o755)
    const { ctx } = ctxHarness()
    const deps = defaultDeps(ctx)
    const result = deps.register(script, 'a'.repeat(32), '/resolved/data')
    expect(result.ok).toBe(true)
    const [dataDir, wslenv] = readFileSync(envFile, 'utf8').split('\n')
    expect(dataDir).toBe('/resolved/data')
    // `WSLENV` 跟着本机是不是 WSL 走（`defaultDeps()` 里那次 `detectWsl()`）。判据因此写成
    // 「WSL 下必须列出 STREAM_DATA_DIR，非 WSL 下必须没有」，而不是钉死一个值——钉死的那种
    // 在另一台机器上会红，且红得没有道理。
    if (detectWsl()) expect(wslenv).toBe('STREAM_DATA_DIR')
    else expect(wslenv).toBe('')
  })
})
