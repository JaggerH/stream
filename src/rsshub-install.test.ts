import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RSSHUB_PIN,
  RSSHUB_OVERRIDES,
  defaultNpmCmd,
  ensureRsshubInstalled,
  installedRsshubEntry,
  rsshubHome,
  rsshubHostManifest,
  __resetRsshubInstallState,
} from './rsshub-install.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsshub-install-'))
  __resetRsshubInstallState()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** 假的 npm：不起任何进程，只按脚本记录参数、然后（可选）把 rsshub 那棵树摆好。 */
function fakeNpm(opts: { code?: number; plant?: boolean; stderr?: string } = {}) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = []
  const spawnFn = ((cmd: string, args: string[], options: { cwd?: string }) => {
    calls.push({ cmd, args, cwd: options?.cwd })
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => {
      if (opts.plant) plantRsshub(dir)
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr))
      child.emit('close', opts.code ?? 0)
    })
    return child
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  return { calls, spawnFn }
}

/** 摆一棵「装好了」的树：package.json 的 exports 指向一个真存在的 .mjs。 */
function plantRsshub(dataDir: string): string {
  const pkgDir = join(rsshubHome(dataDir), 'node_modules', 'rsshub')
  mkdirSync(join(pkgDir, 'dist-lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'dist-lib', 'pkg.mjs'), 'export const init = () => {}\n')
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'rsshub', exports: { '.': { import: './dist-lib/pkg.mjs' } } })
  )
  return join(pkgDir, 'dist-lib', 'pkg.mjs')
}

describe('installedRsshubEntry', () => {
  it('没装 → null', () => {
    expect(installedRsshubEntry(dir)).toBeNull()
  })

  it('装了 → exports 里那个 import 入口的绝对路径', () => {
    const planted = plantRsshub(dir)
    expect(installedRsshubEntry(dir)).toBe(planted)
  })

  it('package.json 在、入口文件不在 → null（半棵树不算装好）', () => {
    const pkgDir = join(rsshubHome(dir), 'node_modules', 'rsshub')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ exports: { '.': { import: './dist-lib/pkg.mjs' } } }))
    expect(installedRsshubEntry(dir)).toBeNull()
  })
})

describe('ensureRsshubInstalled', () => {
  it('生成的宿主 package.json 必须自带 overrides —— 这是不需要 git 的唯一原因', async () => {
    const { spawnFn, calls } = fakeNpm({ plant: true })
    await ensureRsshubInstalled({ dataDir: dir, spawnFn })
    const manifest = JSON.parse(readFileSync(join(rsshubHome(dir), 'package.json'), 'utf8'))
    expect(manifest.dependencies.rsshub).toBe(RSSHUB_PIN)
    // overrides 少一条，装的时候就会去 spawn git，干净的 Windows 上当场失败。
    expect(manifest.overrides).toEqual(RSSHUB_OVERRIDES)
    expect(Object.keys(RSSHUB_OVERRIDES)).toEqual(['browser-request', 'difflib'])
    expect(calls[0].args).toEqual(['install', '--no-audit', '--no-fund'])
    expect(calls[0].cwd).toBe(rsshubHome(dir))
  })

  it('装完返回入口路径', async () => {
    const { spawnFn } = fakeNpm({ plant: true })
    const entry = await ensureRsshubInstalled({ dataDir: dir, spawnFn })
    expect(entry).toBe(installedRsshubEntry(dir))
  })

  it('已经装好 → 一次 npm 都不敲', async () => {
    plantRsshub(dir)
    const { spawnFn, calls } = fakeNpm()
    await ensureRsshubInstalled({ dataDir: dir, spawnFn })
    expect(calls).toHaveLength(0)
  })

  it('并发两条源只装一次（40 秒 × 2、还会互踩同一棵树）', async () => {
    const { spawnFn, calls } = fakeNpm({ plant: true })
    await Promise.all([
      ensureRsshubInstalled({ dataDir: dir, spawnFn }),
      ensureRsshubInstalled({ dataDir: dir, spawnFn }),
    ])
    expect(calls).toHaveLength(1)
  })

  it('npm 失败 → 抛出带 npm 输出的错，不是静默降级', async () => {
    const { spawnFn } = fakeNpm({ code: 1, stderr: 'npm error code ENOTFOUND' })
    await expect(ensureRsshubInstalled({ dataDir: dir, spawnFn })).rejects.toThrow(/ENOTFOUND/)
  })

  it('npm 装完了但树里没有可用入口 → 也要抛，别假装成功', async () => {
    const { spawnFn } = fakeNpm({ plant: false })
    await expect(ensureRsshubInstalled({ dataDir: dir, spawnFn })).rejects.toThrow(/找不到可用的入口/)
  })

  it('起不了 npm（PATH 上没有）→ 一句说得清的错', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spawnFn = (() => {
      throw new Error('spawn npm ENOENT')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
    await expect(ensureRsshubInstalled({ dataDir: dir, spawnFn })).rejects.toThrow(/PATH 上得有 npm/)
  })

  it('失败之后那把并发锁要放开，重试才装得动', async () => {
    const bad = fakeNpm({ code: 1 })
    await expect(ensureRsshubInstalled({ dataDir: dir, spawnFn: bad.spawnFn })).rejects.toThrow()
    const good = fakeNpm({ plant: true })
    await expect(ensureRsshubInstalled({ dataDir: dir, spawnFn: good.spawnFn })).resolves.toBeTruthy()
    expect(good.calls).toHaveLength(1)
  })
})

describe('钉子', () => {
  // 和 cli/package.json 那条「豁免必须精确钉死」同一个理由：滚动 master 版本号上的 `^` 语义
  // 讲不清，两台机器可能装到不同的 RSSHub，而差异只在活体上现形。
  it('RSSHUB_PIN 是精确版本，不是范围', () => {
    expect(/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(RSSHUB_PIN)).toBe(true)
  })

  it('Windows 上得是 npm.cmd（.cmd 不经 shell 起不来）', () => {
    expect(defaultNpmCmd('win32')).toBe('npm.cmd')
    expect(defaultNpmCmd('linux')).toBe('npm')
  })

  it('生成的宿主工程是 private —— 它永远不该被发出去', () => {
    expect(JSON.parse(rsshubHostManifest()).private).toBe(true)
  })

  it('rsshub 不在发行包的 dependencies 里（在的话 git 缺席的机器装不上）', () => {
    const root = new URL('..', import.meta.url).pathname
    const cli = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8'))
    expect(cli.dependencies?.rsshub, 'rsshub 回到了 cli 的 dependencies——没 git 的机器会装不上').toBeUndefined()
    expect(existsSync(join(root, 'src/rsshub-install.ts'))).toBe(true)
  })
})
