/**
 * RSSHub 按需安装 —— 「用到那条源的时候，才把 RSSHub 装到 `<dataDir>/rsshub/`」。
 *
 * **为什么不是 `cli/package.json` 的一条依赖**（曾经是，2026-09-04 撤掉）：
 * `rsshub` → `@jocmp/mercury-parser@3.1.0` → 两个 `github:` 依赖
 * （`postlight/browser-request`、`postlight/difflib.js`）。npm 装 `github:` 说明符必须 spawn git，
 * 而**干净的 Windows 上没有 git**——实测（win-test）整条 `npm i @streamapp/stream` 直接
 * `npm error syscall spawn git` 失败，用户连一个能跑的 Stream 都拿不到。
 *
 * 这两个包在 registry 上都有正版（`browser-request@0.3.2`、`difflib@0.2.4`），`overrides` 换过去
 * 就不再需要 git（实测：抹掉 git 的 PATH 里 `added 652 packages in 43s`，mercury-parser 照常
 * 解析）。**但 `overrides` 只在根 package.json 生效**——把它写进 `cli/package.json` 是白写，
 * 我们自己是别人的依赖时那一段被完全忽略（也实测过：照样 `spawn git ENOENT`）。
 *
 * 所以唯一能用上 overrides 的形态，就是**我们自己当那次 install 的根**：在 `<dataDir>/rsshub/`
 * 里生成一份只有 rsshub 一条依赖的 package.json，在那儿跑 npm。顺带把基础安装从
 * 652 包 / 424MB / 43s 降回 89 包 / 180MB / 11s。
 *
 * 代价如实说：第一次跑到 RSSHub 源要等这一次安装（约 40 秒、要联网、要 npm 在 PATH 上）。
 * 失败必须是一句说得清的错，不是静默 decline —— 见 `rsshub-adapter.ts` 的 `ensureAvailable`。
 *
 * **这条路在开发机和 CI 上零覆盖**：源码形态永远走旁边那个 git 检出，这里一行都不会跑。所以
 * 配套义务是**发版前在一台干净机器上真装一次、真让它跑一条 RSSHub 源**——这一类坑只有那时候
 * 才现（RSSHub 当依赖那次落地当天就撞到两个：worker 入口没进 SHIP 清单、`createRequire().resolve`
 * 对纯 ESM exports 恒返回 null）。见 docs/DEVELOPMENT.md 的发布形态一节。
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

/** 钉死的版本：rsshub 是滚动 master 版本号（1.0.0-master.<sha>），`^` 在预发布版本上语义讲不清。
 *  要升就手工换这一行、跑一次活体。 */
export const RSSHUB_PIN = '1.0.0-master.c1c23ab'

/** 把 mercury-parser 那两个 `github:` 依赖换成 registry 上的正版——这就是不再需要 git 的全部原因。 */
export const RSSHUB_OVERRIDES: Record<string, string> = {
  'browser-request': '0.3.2',
  difflib: '0.2.4',
}

/** RSSHub 自己那棵树住哪儿。 */
export function rsshubHome(dataDir: string): string {
  return join(dataDir, 'rsshub')
}

/**
 * 「这个 dataDir 里已经装好的 RSSHub 入口在哪」——没装好返回 null。
 *
 * **不走 `createRequire(...).resolve`**：`rsshub` 的 `exports` 只声明了 `import` 条件，CJS 解析器
 * 对它一律 `ERR_PACKAGE_PATH_NOT_EXPORTED`（`rsshub-client.ts` 那边为同一件事栽过）。这里直接读
 * 它的 package.json 取 `exports['.'].import`，不经任何解析器。
 */
export function installedRsshubEntry(dataDir: string, exists: (p: string) => boolean = existsSync): string | null {
  const pkgDir = join(rsshubHome(dataDir), 'node_modules', 'rsshub')
  const manifestPath = join(pkgDir, 'package.json')
  if (!exists(manifestPath)) return null
  let rel: string | undefined
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: { '.'?: string | { import?: string } }
      main?: string
    }
    const dot = manifest.exports?.['.']
    rel = typeof dot === 'string' ? dot : dot?.import
    rel ??= manifest.main
  } catch {
    return null
  }
  if (!rel) return null
  const entry = resolvePath(pkgDir, rel)
  return exists(entry) ? entry : null
}

export interface EnsureRsshubOptions {
  dataDir: string
  log?: (msg: string) => void
  /** 注入点：测试**必须**用它，绝不能让用例真敲 npm（AGENTS.md：qrun 的锁护不住比测试活得久的东西）。 */
  spawnFn?: typeof nodeSpawn
  /** npm 可执行名。Windows 上是 `npm.cmd`。 */
  npmCmd?: string
}

/** 平台对应的 npm 可执行名。 */
export function defaultNpmCmd(platform: string = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** `<dataDir>/rsshub/package.json` 的内容——**我们是这次 install 的根**，overrides 因此才生效。 */
export function rsshubHostManifest(): string {
  return `${JSON.stringify(
    {
      name: 'stream-rsshub-host',
      version: '1.0.0',
      private: true,
      description: 'Stream 按需装 RSSHub 的宿主工程；overrides 只在根 package.json 生效，所以它必须存在。',
      dependencies: { rsshub: RSSHUB_PIN },
      overrides: RSSHUB_OVERRIDES,
    },
    null,
    2
  )}\n`
}

/** 同一个进程里并发的两条源不该各装一次（40 秒 × 2、还会互相踩同一棵 node_modules）。 */
let inflight: Promise<string> | null = null

/**
 * 确保这台机器上有 RSSHub，返回它的入口路径。已经装好就直接返回，不碰网络。
 *
 * 装不上时抛错——**故意的**：调用方要把这句话原样交给用户，比"这条源没数据"有用得多。
 */
export async function ensureRsshubInstalled(opts: EnsureRsshubOptions): Promise<string> {
  const existing = installedRsshubEntry(opts.dataDir)
  if (existing) return existing
  inflight ??= installRsshub(opts).finally(() => {
    inflight = null
  })
  return inflight
}

/** 只给测试用：清掉在途的那把锁。 */
export function __resetRsshubInstallState(): void {
  inflight = null
}

async function installRsshub(opts: EnsureRsshubOptions): Promise<string> {
  const { dataDir } = opts
  const log = opts.log ?? (() => {})
  const spawnFn = opts.spawnFn ?? nodeSpawn
  const npmCmd = opts.npmCmd ?? defaultNpmCmd()
  const home = rsshubHome(dataDir)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'package.json'), rsshubHostManifest())

  log(`[rsshub] 本机还没有 RSSHub，正在装到 ${home}（约 650 个包 / 400MB，首次要几十秒）…`)
  const started = Date.now()
  await runNpmInstall({ spawnFn, npmCmd, cwd: home, log })
  const entry = installedRsshubEntry(dataDir)
  if (!entry) {
    throw new Error(
      `[rsshub] npm 装完了，但 ${join(home, 'node_modules', 'rsshub')} 里找不到可用的入口——` +
        `这棵树可能装坏了，删掉 ${home} 再试一次。`
    )
  }
  log(`[rsshub] RSSHub 装好了（${Math.round((Date.now() - started) / 1000)}s）：${entry}`)
  return entry
}

function runNpmInstall(args: {
  spawnFn: typeof nodeSpawn
  npmCmd: string
  cwd: string
  log: (msg: string) => void
}): Promise<void> {
  return new Promise((resolveDone, reject) => {
    const options: SpawnOptions = {
      cwd: args.cwd,
      // Windows 上 `npm.cmd` 是批处理文件，不经 shell 起不来。
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    let child
    try {
      child = args.spawnFn(args.npmCmd, ['install', '--no-audit', '--no-fund'], options)
    } catch (e) {
      reject(new Error(`[rsshub] 起不了 npm（${(e as Error).message}）——这台机器的 PATH 上得有 npm。`))
      return
    }
    const tail: string[] = []
    const keep = (chunk: Buffer) => {
      tail.push(chunk.toString())
      if (tail.length > 40) tail.shift()
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (e: Error) => {
      reject(new Error(`[rsshub] 起不了 npm（${e.message}）——这台机器的 PATH 上得有 npm。`))
    })
    child.on('close', (code: number | null) => {
      if (code === 0) return resolveDone()
      reject(new Error(`[rsshub] npm install 失败（退出码 ${code}）：\n${tail.join('').trim().slice(-2000)}`))
    })
  })
}
