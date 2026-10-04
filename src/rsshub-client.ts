/**
 * RsshubClient — the Stream-side half of the RSSHub worker boundary.
 *
 * RSSHub used to be imported straight into this process (see the old rsshub-adapter). That put
 * 3000+ routes of foreign Node code, a global-fetch monkeypatch, and on-first-hit route
 * compilation (wrapSafe, ~200ms, on the main thread) inside us. This client moves all of it into
 * a worker thread with its OWN globals and OWN event loop, and talks to it over a MessagePort.
 *
 * The boundary mirrors RSSHub's entire public surface — exactly two operations:
 *   init(env)      re-run RSSHub's config with these env vars (this is how a cookie hot-reloads)
 *   request(path)  run one route, get its raw Data object back
 *
 * Everything else here is transport: correlation ids so concurrent requests don't cross wires,
 * and crash recovery (a dead worker respawns on the next call, with accumulated env replayed so
 * a cookie set before the crash isn't lost).
 */
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { appendRsshubWorkerLog } from './rsshub-worker-log'
import { installedRsshubEntry } from './rsshub-install.ts'

/**
 * RSSHub 有**三个来源**，按这个顺序解析（`resolveRsshubPkg`）：
 *
 *  1. **开发检出**（`RSSHUB_PKG`，默认旁边那个 git clone）——**TypeScript 源码**。这个仓库的人
 *     自己写 RSSHub 路由（`.claude/skills/rsshub-routes/`），改完要立刻能跑到，所以只要检出在场
 *     就它优先，预构建产物看不见本地的改动。
 *  2. **`<dataDir>/rsshub/`**——发行安装的那一档：第一次用到 RSSHub 源时由 Stream 自己
 *     `npm install` 到那儿（见 `rsshub-install.ts`，那里写着为什么不能当依赖装）。
 *  3. **npm 包 `rsshub`**——谁自己往我们旁边装了一份就用它（源码检出里 `pnpm add rsshub` 之类）。
 *
 * 第 2、3 档都是**预构建 ESM**（`dist-lib/pkg.mjs`），公开面与检出的 `lib/pkg.ts` 一致
 * （init / request / registerRoute / ofetch / parseDate…）。
 *
 * **只有第 1 档要 tsx**（.ts 源码 + tsconfig 的 `@/*` paths）；后两档是现成的 .mjs，worker 的
 * `execArgv` 里不该有 `--import tsx`（发行包里根本没有 tsx）。所以检出那一档还要 tsx 在场才算数——
 * 有检出没 tsx 就往下落，而不是拿一条注定 spawn 失败的路。
 */
export type RsshubPkgSource = 'checkout' | 'datadir' | 'package'
export interface RsshubResolution {
  /** worker 拿去 `import()` 的说明符：检出是 `lib/pkg.ts` 绝对路径，npm 包是解析出的 .mjs 绝对路径。 */
  path: string
  source: RsshubPkgSource
}

/** 开发检出里 `lib/pkg.ts` 的位置。未设置时跳过检出，继续解析发行安装或 npm 包。 */
export const RSSHUB_CHECKOUT_PKG = process.env.RSSHUB_PKG

/** 注入点全给出来，好让解析顺序能被无文件系统地测（有牙的判据：换掉哪一个会翻车）。 */
export interface RsshubResolveDeps {
  checkoutPath?: string
  exists?: (p: string) => boolean
  hasTsx?: () => boolean
  resolvePackage?: () => string | null
  /** 发行安装那一档的落点；给了它才有第 2 档（`<dataDir>/rsshub/`），也才装得动。 */
  dataDir?: string
  /** 注入点：默认读 `<dataDir>/rsshub/node_modules/rsshub` 的 package.json。 */
  resolveDataDir?: (dataDir: string) => string | null
}

function defaultHasTsx(): boolean {
  try {
    createRequire(import.meta.url).resolve('tsx')
    return true
  } catch {
    return false
  }
}

/**
 * **必须走 `import.meta.resolve`，不能用 `createRequire(...).resolve`。** `rsshub` 的 `exports`
 * 只声明了 `import` 条件（没有 `require`），CJS 解析器对它一律
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`——也就是说 require 那条路**永远**返回 null，于是「装了 RSSHub」
 * 会被静默判成「没装」，每条源都落进 decline。实测撞到过（2026-09-04）。
 */
function defaultResolvePackage(): string | null {
  try {
    return import.meta.resolve('rsshub')
  } catch {
    return null
  }
}

/** 「这台机器上的 RSSHub 是哪一份」——三个来源都不在返回 null。 */
export function resolveRsshubPkg(deps: RsshubResolveDeps = {}): RsshubResolution | null {
  const checkoutPath = deps.checkoutPath ?? RSSHUB_CHECKOUT_PKG
  const exists = deps.exists ?? existsSync
  const hasTsx = deps.hasTsx ?? defaultHasTsx
  const resolvePackage = deps.resolvePackage ?? defaultResolvePackage
  const resolveDataDir = deps.resolveDataDir ?? ((d: string) => installedRsshubEntry(d, exists))
  if (checkoutPath && exists(checkoutPath) && hasTsx()) return { path: checkoutPath, source: 'checkout' }
  if (deps.dataDir) {
    const installed = resolveDataDir(deps.dataDir)
    if (installed) return { path: installed, source: 'datadir' }
  }
  const pkg = resolvePackage()
  if (pkg) return { path: pkg, source: 'package' }
  return null
}

/**
 * 「这台机器能不能跑 RSSHub」——返回不能跑的理由，能跑则 null。
 *
 * **这条防线不能拆**：`new Worker(...)` 失败会把每一个 in-flight promise 一起 reject，其中就有
 * 没人 await 的那些（见 `setReady`），一条没人接的 rejection 直接把整个后端进程带走。所以调用方
 * 必须在 **spawn 之前**问这一句。
 *
 * 它返回理由是**常态而非异常**：发行安装第一次跑到 RSSHub 源时本机确实还没有 RSSHub，调用方拿到
 * 理由后该去装（`ensureRsshubInstalled`），装完再问一次。装完仍然有理由才是真出事了。
 */
export function rsshubUnavailableReason(deps: RsshubResolveDeps = {}): string | null {
  if (resolveRsshubPkg(deps)) return null
  const checkoutPath = deps.checkoutPath ?? RSSHUB_CHECKOUT_PKG
  const where = deps.dataDir ? `\`${deps.dataDir}/rsshub\` 里没装、` : ''
  const checkout = checkoutPath
    ? `开发检出不在（${checkoutPath}，或它在但没有 tsx）`
    : '未配置开发检出（设 RSSHUB_PKG 指向 lib/pkg.ts）'
  return `本机找不到可用的 RSSHub：${where}${checkout}，npm 包 \`rsshub\` 也解析不到`
}

/** worker 入口：发行形态是和 server.mjs 同目录的预构建 `.mjs`（`scripts/build-server.mjs` 产出、
 *  `scripts/build-cli.mjs` 出货）；源码形态没有它，用 `.ts` 那份（此时才需要 tsx）。 */
function defaultEntry(): URL {
  const bundled = new URL('./rsshub-worker.mjs', import.meta.url)
  return existsSync(fileURLToPath(bundled)) ? bundled : new URL('./rsshub-worker.ts', import.meta.url)
}

/** `--import tsx` **只为 worker 入口自己是 TypeScript 那一档**。发行包里入口是 .mjs、RSSHub 是
 *  预构建包，两处都不碰 tsx —— 而发行包里根本没有 tsx，加了就是 100% ERR_MODULE_NOT_FOUND。 */
export function execArgvForEntry(entry: URL | string): string[] {
  return String(entry).endsWith('.ts') ? ['--import', 'tsx'] : []
}

// Our own tsconfig — its `paths` map `@/*` → the RSSHub checkout, which is how RSSHub's internal
// `@/config` etc. resolve. tsx in the main process auto-finds this from cwd; a spawned worker does
// NOT, so we hand it the path explicitly via TSX_TSCONFIG_PATH or `@/` imports fail to resolve.
const DEFAULT_TSCONFIG = fileURLToPath(new URL('../tsconfig.json', import.meta.url))

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

interface WorkerReply {
  id: number
  ok: boolean
  data?: unknown
  error?: string
}

export interface RsshubClientOptions {
  /** Worker entry module. Defaults to the real rsshub-worker harness; tests point it at a fake. */
  entry?: URL | string
  /** RSSHub 的模块说明符，经 workerData 交给 worker。给了它就不再解析。 */
  pkgPath?: string
  /** 这份 RSSHub 是哪一档——worker 只在 `checkout` 那一档挂 tsx 的 paths 解析和 JSX 垫片。 */
  pkgSource?: RsshubPkgSource
  /** 解析注入点，**每次 spawn 现问一遍**（见下面 `ensureWorker` 里为什么不能在构造时定死）。 */
  resolveDeps?: RsshubResolveDeps
  /** Node args for the worker — 默认按入口是不是 .ts 决定加不加 `--import tsx`。 */
  execArgv?: string[]
  /** tsconfig whose `paths` the worker's tsx uses to resolve `@/` → the RSSHub checkout. */
  tsconfigPath?: string
}

export class RsshubClient {
  private worker: Worker | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  /** Every env var we've been told about, so a respawned worker can be brought back to config. */
  private readonly appliedEnv: Record<string, string> = {}
  /** Resolves once the CURRENT worker has (re)loaded appliedEnv; requests await it before sending. */
  private ready: Promise<unknown> = Promise.resolve()
  private readonly entry: URL | string
  private readonly fixedPkgPath?: string
  private readonly fixedPkgSource?: RsshubPkgSource
  private readonly resolveDeps: RsshubResolveDeps
  private readonly execArgv: string[]
  private readonly tsconfigPath: string

  constructor(opts: RsshubClientOptions = {}) {
    this.entry = opts.entry ?? defaultEntry()
    this.fixedPkgPath = opts.pkgPath
    this.fixedPkgSource = opts.pkgSource
    this.resolveDeps = opts.resolveDeps ?? {}
    this.execArgv = opts.execArgv ?? execArgvForEntry(this.entry)
    this.tsconfigPath = opts.tsconfigPath ?? DEFAULT_TSCONFIG
  }

  /**
   * 「这次要加载哪一份 RSSHub」——**每次 spawn 现问，不在构造时定死**。
   *
   * 这不是洁癖：发行形态下 RSSHub 是**用到那条源时才装**的（`rsshub-install.ts`），而这个 client
   * 是模块级单例、在任何源跑起来之前就建好了。构造时问到的答案必然是「没有」，把它存下来就等于
   * 宣称「这台机器永远没有 RSSHub」——装完了也还是没有，且不报错，只是每条源都跑不了。
   * （AGENTS.md「装配期取的值 = 冻住的答案」，这条正是它说的那一类。）
   */
  private resolveNow(): { pkgPath: string; pkgSource: RsshubPkgSource } {
    if (this.fixedPkgPath) {
      return {
        pkgPath: this.fixedPkgPath,
        pkgSource: this.fixedPkgSource ?? (this.fixedPkgPath.endsWith('.ts') ? 'checkout' : 'package'),
      }
    }
    const resolved = resolveRsshubPkg(this.resolveDeps)
    if (!resolved) throw new Error(rsshubUnavailableReason(this.resolveDeps) ?? '本机找不到可用的 RSSHub')
    return { pkgPath: resolved.path, pkgSource: this.fixedPkgSource ?? resolved.source }
  }

  /** Re-run RSSHub's config with `env` merged in — a cookie change hot-reloads through here. */
  async init(env: Record<string, string>): Promise<void> {
    Object.assign(this.appliedEnv, env)
    this.ensureWorker()
    await this.setReady(this.post({ type: 'init', env: { ...this.appliedEnv } }))
  }

  /** Run one route and return its raw Data object. */
  async request(path: string): Promise<unknown> {
    this.ensureWorker()
    await this.ready
    return this.post({ type: 'request', path })
  }

  /** Terminate the worker and reject any in-flight calls. For tests / shutdown. */
  async dispose(): Promise<void> {
    const w = this.worker
    this.worker = null
    this.rejectAll(new Error('rsshub worker disposed'))
    if (w) await w.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const { pkgPath, pkgSource } = this.resolveNow()
    const w = new Worker(this.entry, {
      execArgv: this.execArgv,
      workerData: { pkgPath, pkgSource },
      // Piped (not shared with the parent's real stdout/stderr fd) — a worker's console output
      // otherwise forwards straight through the container's stdout pipe, so a disconnected log
      // consumer (e.g. `docker compose logs -f` killed mid-tail) EPIPEs it. That once fed a
      // runaway uncaughtException-logging loop that grew logs/*.log to 40GB (2026-07-23). Piping
      // isolates the worker's output as an in-process stream we own and can bound (see below).
      stdout: true,
      stderr: true,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: this.tsconfigPath,
        // Stream is RSSHub's only caller and owns scheduling + its own CacheLayer. RSSHub ships two
        // cache layers on by default (CACHE_TYPE=memory): a 5min route cache and a 1h content cache
        // whose stale CDN urls come back dead. '' is RSSHub's documented off switch. Overridable if
        // the ambient env sets CACHE_TYPE explicitly. (IS_PACKAGE is forced true by pkg.init.)
        CACHE_TYPE: process.env.CACHE_TYPE ?? '',
        // RSSHub's own winston File transports for logs/error.log + logs/combined.log have no
        // maxsize/maxFiles. NO_LOGFILES is RSSHub's documented off switch (lib/config.ts) — Stream
        // captures worker stdout/stderr itself instead, bounded via rsshub-worker-log.ts.
        NO_LOGFILES: 'true',
      },
    })
    w.stdout.on('data', (chunk: Buffer) => appendRsshubWorkerLog(`[stdout] ${chunk.toString()}`))
    w.stderr.on('data', (chunk: Buffer) => appendRsshubWorkerLog(`[stderr] ${chunk.toString()}`))
    w.on('message', (msg: WorkerReply) => {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.data)
      else p.reject(new Error(msg.error ?? 'rsshub worker error'))
    })
    w.on('error', (err) => this.crash(err))
    w.on('exit', (code) => {
      if (code !== 0) this.crash(new Error(`rsshub worker exited (code ${code})`))
    })
    // Don't keep the process alive just for the worker — Stream's server owns the event loop.
    w.unref()
    this.worker = w
    // Bring a freshly spawned (or respawned) worker to the config we've accumulated, before any
    // request rides it. On first spawn appliedEnv is {} — that still triggers RSSHub's one-time
    // init(), matching the old adapter's behaviour.
    this.setReady(this.post({ type: 'init', env: { ...this.appliedEnv } }))
    return w
  }

  /**
   * 存下这一份 `ready`，并**当场给它挂一个空 catch**——`ready` 是会被覆盖的：
   *   - `ensureWorker()` 每次 (re)spawn 都写一次，而它是从 `post()` 内部调的，那一份**没有任何人 await**；
   *   - `init()` 紧接着又覆盖一次，把上面那份彻底孤儿化。
   * 平时这些孤儿都会 resolve，看不出问题。但 worker 起不来时（发行包里没有 `tsx`），
   * `crash()` 会 reject **所有** pending——包括这些孤儿，于是一条没人接的 rejection 直接
   * `triggerUncaughtException` 把整个后端进程带走。一个采集源取不到数是常态，不该是 fatal。
   *
   * 空 catch 只标记「已处理」，不吞掉错误：`await this.ready` 的调用方拿到的仍是原来那个 rejection。
   */
  private setReady(p: Promise<unknown>): Promise<unknown> {
    p.catch(() => {})
    this.ready = p
    return p
  }

  private crash(err: Error): void {
    this.worker = null // next call respawns
    this.rejectAll(err)
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private post<T = unknown>(msg: { type: string; path?: string; env?: Record<string, string> }): Promise<T> {
    const id = ++this.seq
    const w = this.ensureWorker()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      w.postMessage({ ...msg, id })
    })
  }
}
