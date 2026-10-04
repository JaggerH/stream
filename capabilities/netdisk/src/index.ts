/**
 * `@streamapp/netdisk` 的能力体——**认盘**（验分享 / 转存 / 取直链 / 跳转网盘）；**配号**（把网盘
 * 文件对上节目单）留在 Stream 编排层，不在这里
 * （spec `docs/superpowers/specs/2026-09-02-netdisk-capability-plugin-design.md`）。
 *
 * 这个文件**不认识宿主**：只吃 `CapabilityContext`（`shared/capability/types.ts`），挂到 MCP 那张脸
 * 还是 DSH 那张脸由调用方决定（DSH 那张在 `./dsh.ts`）。每一种「起不来」都只记日志、不抛。
 *
 * 为什么网盘与浏览器必须同进程（spec §4.1）：认盘要用户浏览器的登录态，而握着那只手的
 * Stream Desktop（`@streamapp/desktop`）的中继是一个进程内对象。同进程 `ctx.require(BROWSER_COOKIE_SERVICE)` 借到它，
 * cookie 不出进程；换成子进程就得给 cookie 开一个跨进程口子，那是不可逆的安全面。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveTier, type NetdiskHostConfig } from './config.ts'
import { OpenListClient } from '../../../shared/netdisk/openlist-client.ts'
import { makeDockerClient, resolveDockerEndpoint, type DockerClient } from '../../../shared/docker/engine-api.ts'
import type { Capability, CapabilityContext } from '../../../shared/capability/types.ts'
import { BROWSER_COOKIE_SERVICE } from '../../desktop/src/cookies.ts'
import { createManagedOpenList, type ManagedConfig, type ManagedCreds, type ManagedOpenList } from './managed.ts'
import { netdiskToolOptions, type NetdiskSurfaceDeps, type OpenListLike } from './tools.ts'

export type { NetdiskHostConfig } from './config.ts'
export type { ManagedConfig, ManagedCreds } from './managed.ts'

/** 这个包自己的 data 目录默认落点（managed 档的 admin 密码 + 永久 token 住这里，0600）。跟 Stream 的
 *  data 目录、Stream Desktop 在 `<dataDir>/capabilities/desktop/` 下那份都不是同一个目录。 */
export function defaultDataDir(): string {
  return join(homedir(), '.stream-netdisk-plugin')
}

/** managed 档凭证（admin 密码 + 永久 token）的落点。 */
export interface ManagedStore {
  read(): ManagedCreds | undefined
  write(creds: ManagedCreds): void
}

/** 凭证文件：`<dataDir>/openlist.json`。读坏了当没有（重新接管，密码会换，卷里的数据不受影响）。 */
function fileStore(dataDir: string): ManagedStore {
  const path = join(dataDir, 'openlist.json')
  return {
    read() {
      try {
        const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<ManagedCreds>
        return typeof j.password === 'string' && typeof j.token === 'string' ? { password: j.password, token: j.token } : undefined
      } catch {
        return undefined
      }
    },
    write(creds) {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
      chmodSync(path, 0o600)
    },
  }
}

/** 空闲回收的巡检间隔。 */
const REAP_INTERVAL_MS = 60_000

/** Stream Desktop 挂出来的那份服务（`capabilities/desktop/src/cookies.ts` 的 `BrowserCookieService`）。
 *  **结构类型，故意不 import 那个包**——npm 上两个包互相独立，有 Stream Desktop 才有这个服务，
 *  没有时网盘包照样能装、照样能跑（要登录态的那几个动词回「没有 Stream Desktop」）。 */
export interface BrowserCookieServiceLike {
  cookieFor(domain: string): Promise<string | undefined>
  /** 整条记录——managed 档挂载要把 cookie 灌进 OpenList storage。 */
  cookiesFor(domain: string): Promise<Array<{ name: string; value: string; domain: string }>>
}

/** 服务名。**从 Stream Desktop 那一份 import**，不再手抄一个同值的串：两边分家等于永远等不到那个
 *  服务，而且没有一处会喊——转存只会一直回「没有 Stream Desktop」。这是一个 `const` 串，打包时
 *  tsdown 内联，不会在 npm 上留下对 `@streamapp/desktop` 的运行时依赖。 */
export { BROWSER_COOKIE_SERVICE }

/** 注入点，只为测试。 */
export interface ApplyDeps {
  /** 出站 fetch（验活打网盘、转存打夸克、打 OpenList）。 */
  fetchFn: typeof fetch
  /** managed 档的 docker 客户端；null = 端点解析不了。**调用时才建**（装载期不碰 socket）。 */
  docker(): DockerClient | null
  /** managed 档凭证的落点；省略 = `<dataDir>/openlist.json`。 */
  managedStore?: ManagedStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 空闲回收的定时器（测试注入假的；缺省 = 真 setInterval）。 */
  setInterval?: (fn: () => void, ms: number) => () => void
}

export const defaultDeps: ApplyDeps = {
  fetchFn: (input, init) => fetch(input, init),
  docker: () => {
    const ep = resolveDockerEndpoint(process.env, process.platform)
    return ep ? makeDockerClient(ep) : null
  },
}

/**
 * 能力体。顺序：判档 → 备好 OpenList（external 档）→ 挂四个动词。
 * 任何一步失败都只记日志、不抛（跑在宿主自己的进程里，逃出去的异常带走整个宿主）。
 */
export async function mount(ctx: CapabilityContext, config: NetdiskHostConfig = {}, deps: ApplyDeps = defaultDeps): Promise<void> {
  const logger = ctx.log

  // disposer 必须在任何 await 之前、同步可达的路径上挂好：宿主可能在我们还在 await 的时候就把这个
  // 能力撤了，懒到那时候才挂等于彻底错过这次清理。（工具的摘除归 ctx.registerTools 自己管。）
  let stopReaper: (() => void) | undefined
  let disposed = false
  ctx.onDispose(() => {
    disposed = true
    stopReaper?.()
  })

  try {
    const tier = resolveTier(config)
    // 登录态：**调用时现取**，不在这里存快照——浏览器包可能在我们之后才挂上、也可能中途被收掉。
    // 装配期取一次就等于宣称"这个答案此后不变"，而它恰恰会变（AGENTS.md「装配期取的值 = 冻住的答案」）。
    const cookieService = (): BrowserCookieServiceLike | undefined => ctx.require<BrowserCookieServiceLike>(BROWSER_COOKIE_SERVICE)

    let openlist: (() => OpenListLike | undefined) = () => undefined
    let managed: ManagedOpenList | undefined
    if (tier.kind === 'external') {
      const client = new OpenListClient({ baseUrl: tier.url, token: tier.token, fetchFn: deps.fetchFn })
      openlist = () => client
      logger.info(`external 档：OpenList 在 ${tier.url}（只读 / 转存 / 播放，不碰 storage admin）。`)
    } else if (tier.kind === 'invalid') {
      logger.warn(`OpenList 配置无效，取直链不可用（验活 / 转存 / 跳转网盘照常）：${tier.reason}`)
    } else {
      // managed 档：容器与接管全部**懒**——第一次真用到取直链时才拉镜像 / 起容器。装载期只探一眼记日志。
      const dataDir = config.dataDir?.trim() || ctx.dataDir.trim() || defaultDataDir()
      managed = createManagedOpenList(config.managed ?? {}, {
        docker: deps.docker(),
        fetchFn: deps.fetchFn,
        store: deps.managedStore ?? fileStore(dataDir),
        genPassword: () => randomBytes(18).toString('base64url'),
        sleep: deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
        now: deps.now ?? (() => Date.now()),
        log: (line) => logger.info(`[managed] ${line}`),
        cookiesFor: (domain) => cookieService()?.cookiesFor(domain) ?? Promise.resolve([]),
        hasCookieService: () => cookieService() !== undefined,
      })
      const m = managed
      // 每次调用都经 ensure()：归属会变、容器会被回收，装配期取的答案是冻住的（AGENTS.md「装配期取的值」）。
      const viaEnsure = async <T>(fn: (client: OpenListLike) => Promise<T>): Promise<T> => {
        const r = await m.ensure()
        if (!r.ok) throw new Error(r.reason)
        return fn(r.client)
      }
      openlist = () => ({ rawUrl: (p) => viaEnsure((c) => c.rawUrl(p)), fileId: (p) => viaEnsure((c) => c.fileId(p)) })
      const tick = deps.setInterval ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t) })
      stopReaper = tick(() => void m.reapIfIdle(), REAP_INTERVAL_MS)
      logger.info(`managed 档（没给 openlistUrl）：${await m.probe()}。容器在第一次取直链时才拉起。`)
    }

    const surface: NetdiskSurfaceDeps = {
      cookieFor: (domain) => cookieService()?.cookieFor(domain) ?? Promise.resolve(undefined),
      hasCookieService: () => cookieService() !== undefined,
      openlist,
      fetchFn: deps.fetchFn,
    }

    if (disposed) return
    ctx.registerTools(netdiskToolOptions(surface))
    // 说"已交给"不说"已挂上"：真挂没挂上归 `ctx.registerTools`（DSH 那张脸里它还要等 `tools` 服务
    // 到位、还要 import 到 defineTool，两处都可能跳过并各自 warn）。这里报成"已挂上"就是替宿主
    // 打了一份它没做过的包票——排查时会把人从"工具没出现"直接引到错误的一侧。
    logger.info('四个 netdisk 动词已交给宿主注册：netdisk_verify_share / netdisk_save_share / netdisk_play_link / netdisk_folder_url。')
  } catch (err) {
    logger.warn(`装载失败，已跳过（不阻塞宿主装载）：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 能力面：包对外只交出这一样，由 Stream 后端的能力宿主（`src/capabilities/host.ts`）挂上。
 *  `deps` 只是测试注入点，不属于契约，所以这里显式收窄成两参（多一个参数的函数不能直接当两参用）。 */
export const capability: Capability<NetdiskHostConfig> = { name: 'netdisk', mount: (ctx, config) => mount(ctx, config) }
