/**
 * managed 档（spec §5.2 / §8 阶段 5）+ 归属让位（阶段 6）：没给 `openlistUrl` 时，插件**自己**拉一个
 * OpenList 容器、接管 admin、换永久 token、按 preset 挂载网盘、空闲回收。
 *
 * 全部走 Docker Engine API（`shared/docker/engine-api.ts`，与 Stream 的 standby 同一份），不依赖
 * docker CLI / compose——装到别人机器上的插件手里只有一个 socket。
 *
 * **归属让位**（阶段 6）只在一种情况下需要：同机还装着 Stream。判据是证据不是猜：本机存在
 * `com.docker.compose.service=alist` 的容器（compose 建的 `stream-alist-1` 或 standby 建的 `stream-alist`
 * 都打这个标签）= Stream 在管 OpenList，本插件不建第二份、不碰它——正确的形态是让 Stream 走
 * external 档把 url + token 递过来。每次 `ensure()` 都重问一次（同浏览器插件每个动词前重问归属）：
 * 装载时归我们，不等于一直归我们。
 *
 * 自己的容器用**另一个** service 标签（`netdisk-openlist`）和另一个卷：Stream 的 standby 会 adopt 任何
 * `alist` 标签的容器（活体撞到过），撞了标签就是两个大脑抢一个容器。
 *
 * 每一步失败都收成 `{ ok:false, reason }`——这一层的调用方是工具体，工具体绝不抛。
 */
import { COMPOSE_SERVICE_LABEL, type ContainerSpec, type DockerClient } from '../../../shared/docker/engine-api.ts'
import { findPreset } from '../../../shared/netdisk/mount-presets.ts'
import { reconcileMounts, type BrowserCookie } from '../../../shared/netdisk/mounts.ts'
import { alistLogin, fetchPermanentToken } from '../../../shared/netdisk/openlist-admin.ts'
import { OpenListClient } from '../../../shared/netdisk/openlist-client.ts'
import { isJwtLike } from '../../../shared/netdisk/token-shape.ts'

/** 我们自己那个容器的 service 标签（也是容器名 `stream-<service>` 与卷名 `<service>-data` 的词干）。 */
export const MANAGED_SERVICE = 'netdisk-openlist'
/** Stream 那份 OpenList 的 service 标签——见到它就让位。 */
export const STREAM_OPENLIST_SERVICE = 'alist'
export const MANAGED_NETWORK = 'stream-netdisk'
export const OPENLIST_IMAGE = 'openlistteam/openlist:latest'
export const OPENLIST_PORT = 5244

export interface ManagedConfig {
  image?: string
  /** 空闲多久停容器（默认 240，同 `packages/alist` 的 standby 声明）。0 = 不回收。 */
  idleMinutes?: number
  /** 要挂的网盘 preset id（`shared/netdisk/mount-presets.ts`），默认 `['quark']`。 */
  mounts?: string[]
  /** 起容器后等 `/ping` 的预算（默认 60s）。 */
  pingTimeoutMs?: number
  /**
   * **只给冒烟用**（`scripts/smoke-managed.mjs --ignore-owner`）：同机有 Stream 也不让位、照建自己的容器。
   * 生产配置别开——两份 OpenList 各挂同一个网盘账号，cookie 失效时两个自愈器会互相踩。
   */
  ignoreOwner?: boolean
}

/** 落盘的凭证：admin 密码 + **永久** token。 */
export interface ManagedCreds {
  password: string
  token: string
}

export interface ManagedDeps {
  /** null = 连端点都解析不出来（DOCKER_HOST 不认识）。 */
  docker: DockerClient | null
  fetchFn: typeof fetch
  store: { read(): ManagedCreds | undefined; write(creds: ManagedCreds): void }
  genPassword(): string
  sleep(ms: number): Promise<void>
  now(): number
  log(line: string): void
  /** 浏览器插件的 `cookiesFor`（挂载要灌 cookie）；缺席 = 没有浏览器插件，挂不了。 */
  cookiesFor?: (domain: string) => Promise<BrowserCookie[]>
  /** 浏览器插件的服务此刻在不在——它可能晚到，所以是问句不是快照；缺省按 `cookiesFor` 在不在判。 */
  hasCookieService?: () => boolean
}

export type EnsureResult =
  | { ok: true; client: OpenListClient; baseUrl: string }
  | { ok: false; reason: string; deferred?: boolean }

export interface ManagedOpenList {
  /** 备好一个能用的 OpenList（判归属 → 容器 → 接管 → 挂载）。绝不抛。 */
  ensure(): Promise<EnsureResult>
  /** 空闲超过 idleMinutes 就停容器；停了回 true。 */
  reapIfIdle(): Promise<boolean>
  /** 一行现状（装载期记日志用）：docker 通不通、归谁、容器在不在。 */
  probe(): Promise<string>
}

const containerNames = (list: Array<{ Names: string[] }>): string => list.map((c) => c.Names.map((n) => n.replace(/^\//, '')).join(',')).join(' / ')

export function createManagedOpenList(config: ManagedConfig, deps: ManagedDeps): ManagedOpenList {
  const image = config.image ?? OPENLIST_IMAGE
  const idleMs = (config.idleMinutes ?? 240) * 60_000
  const mounts = config.mounts ?? ['quark']
  const pingTimeoutMs = config.pingTimeoutMs ?? 60_000

  let containerId: string | undefined
  let running = false
  let lastUsed = deps.now()
  /** 容器（重）起过一次就要重跑一遍挂载核对。 */
  let needMounts = true
  let current: { baseUrl: string; token: string; client: OpenListClient } | undefined
  let inFlight: Promise<EnsureResult> | undefined

  const fail = (reason: string, deferred = false): EnsureResult => ({ ok: false, reason, ...(deferred ? { deferred: true } : {}) })

  /** 判归属：本机有 Stream 的 OpenList 容器就让位。 */
  const streamOwns = async (docker: DockerClient): Promise<string | undefined> => {
    if (config.ignoreOwner) return undefined
    const theirs = await docker.listByService(STREAM_OPENLIST_SERVICE)
    return theirs.length ? containerNames(theirs) : undefined
  }

  const waitPing = async (baseUrl: string): Promise<boolean> => {
    const start = deps.now()
    for (;;) {
      try {
        const r = await deps.fetchFn(`${baseUrl}/ping`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) return true
      } catch {
        /* 还没起来 */
      }
      if (deps.now() - start >= pingTimeoutMs) return false
      await deps.sleep(1000)
    }
  }

  /** 接管：存的 token 是永久的就直接用；否则（没有 / 是 JWT）重设 admin 密码 → login → 换永久 token → 落盘。 */
  const provision = async (docker: DockerClient, id: string, baseUrl: string): Promise<{ token: string } | { error: string }> => {
    const stored = deps.store.read()
    if (stored?.token && !isJwtLike(stored.token)) return { token: stored.token }
    const password = stored?.password ?? deps.genPassword()
    const set = await docker.exec(id, ['./openlist', 'admin', 'set', password])
    if (set.exitCode !== 0) return { error: `容器内 openlist admin set 退出码 ${set.exitCode}：${set.output.slice(0, 300)}` }
    const jwt = await alistLogin(baseUrl, password, deps.fetchFn)
    const token = await fetchPermanentToken(baseUrl, jwt, deps.fetchFn)
    deps.store.write({ password, token })
    deps.log('已接管 OpenList admin（密码 + 永久 token 落在插件自己的 data 目录）')
    return { token }
  }

  /** 挂载核对：期望态是 config.mounts 那几个 preset，cookie 从浏览器插件现取。失败只记日志。 */
  const reconcile = async (client: OpenListClient): Promise<void> => {
    const desired = mounts.filter((id) => findPreset(id)).map((presetId) => ({ presetId }))
    const unknown = mounts.filter((id) => !findPreset(id))
    if (unknown.length) deps.log(`不认识的挂载 preset：${unknown.join(', ')}（认识的见 shared/netdisk/mount-presets.ts），跳过`)
    if (!desired.length) return
    const cookieSource = async (): Promise<Record<string, BrowserCookie[]>> => {
      const out: Record<string, BrowserCookie[]> = {}
      if (!deps.cookiesFor) return out
      for (const { presetId } of desired) {
        const preset = findPreset(presetId)!
        out[preset.cookieDomain] = await deps.cookiesFor(preset.cookieDomain)
      }
      return out
    }
    try {
      const r = await reconcileMounts(desired, client, cookieSource)
      if (r.created.length) deps.log(`挂载已建：${r.created.join(', ')}`)
      if (r.healed.length) deps.log(`挂载已自愈（换 cookie 后重启用）：${r.healed.join(', ')}`)
      if (r.missingCookie.length) {
        deps.log(
          `挂载缺登录态：${r.missingCookie.join(', ')}——${(deps.hasCookieService ?? (() => !!deps.cookiesFor))() ? '浏览器里还没登录这个网盘，或它不在扩展的同步域里' : '这台宿主没有 Stream Desktop（或它还没握上 Chrome），拿不到 cookie；接上后下次容器起来时会自动挂'}`,
        )
      }
    } catch (err) {
      deps.log(`挂载核对失败（下次容器起来再试）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const ensureOnce = async (): Promise<EnsureResult> => {
    const docker = deps.docker
    if (!docker) return fail('没有可用的 docker 端点（DOCKER_HOST 解析不了，且本平台默认 socket 不在）——managed 档要一个本机 docker')
    if (!(await docker.ping())) return fail('docker daemon 够不着（socket 在但没人应答）——managed 档要一个跑着的本机 docker')

    const owner = await streamOwns(docker)
    if (owner) {
      return fail(
        `本机的 OpenList 归 Stream 管着（容器 ${owner} 带着 ${COMPOSE_SERVICE_LABEL}=${STREAM_OPENLIST_SERVICE}），本插件让位、不建第二份。` +
          '要在这台机器上用认盘，让 Stream 走 external 档把 openlistUrl + openlistToken 递进这一行。',
        true,
      )
    }

    let own = (await docker.listByService(MANAGED_SERVICE))[0]
    if (!own) {
      await docker.ensureNetwork(MANAGED_NETWORK)
      deps.log(`拉镜像 ${image}（第一次可能要几分钟）`)
      await docker.pullImage(image)
      const spec: ContainerSpec = {
        image,
        service: MANAGED_SERVICE,
        port: OPENLIST_PORT,
        env: { MCP_ENABLE: 'true' },
        volumes: [`${MANAGED_SERVICE}-data:/opt/openlist/data`],
        publishLoopback: true,
        network: MANAGED_NETWORK,
        // Engine API 新建的命名卷是 root 属主；镜像以 UID 1001 跑，入口只查 ./data 权限、不 chown，
        // 于是容器秒退（活体撞到，2026-09-02）。以 root 起是唯一不需要第二个容器去 chown 的解法。
        user: '0:0',
      }
      const id = await docker.createContainer(spec)
      own = { Id: id, State: 'created', Names: [`/stream-${MANAGED_SERVICE}`] }
      deps.log(`已建容器 stream-${MANAGED_SERVICE}（${id.slice(0, 12)}）`)
    }
    containerId = own.Id
    if (own.State !== 'running') {
      await docker.start(own.Id)
      needMounts = true
    }
    running = true

    // 两种「起了但不对」都把容器日志尾巴带进理由：秒退的原因只在那里，不带就只能去 docker logs 猜。
    const tail = async (): Promise<string> => {
      try {
        const lines = await docker.logs(own!.Id, 20)
        return lines?.length ? `\n容器日志尾巴：\n${lines.join('\n')}` : ''
      } catch {
        return ''
      }
    }
    const port = await docker.inspectHostPort(own.Id, OPENLIST_PORT)
    if (port === null) return fail(`容器起了但没发布 loopback 口（inspect 里 Ports 为空，多半是秒退了）${await tail()}`)
    const baseUrl = `http://127.0.0.1:${port}`
    if (!(await waitPing(baseUrl))) return fail(`OpenList 起了 ${pingTimeoutMs / 1000}s 还没应答 /ping（${baseUrl}）${await tail()}`)

    const creds = await provision(docker, own.Id, baseUrl)
    if ('error' in creds) return fail(creds.error)

    if (!current || current.baseUrl !== baseUrl || current.token !== creds.token) {
      current = { baseUrl, token: creds.token, client: new OpenListClient({ baseUrl, token: creds.token, fetchFn: deps.fetchFn }) }
    }
    if (needMounts) {
      needMounts = false
      await reconcile(current.client)
    }
    return { ok: true, client: current.client, baseUrl }
  }

  return {
    async ensure() {
      lastUsed = deps.now()
      if (inFlight) return inFlight
      inFlight = ensureOnce()
        .catch((err) => fail(`备 OpenList 失败：${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          inFlight = undefined
        })
      return inFlight
    },
    async reapIfIdle() {
      const docker = deps.docker
      if (!docker || !containerId || !running || idleMs <= 0) return false
      if (deps.now() - lastUsed < idleMs) return false
      try {
        await docker.stop(containerId)
        running = false
        deps.log(`OpenList 空闲超过 ${config.idleMinutes ?? 240} 分钟，已停容器（下次用到再起）`)
        return true
      } catch (err) {
        deps.log(`停空闲容器失败：${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },
    async probe() {
      const docker = deps.docker
      if (!docker) return 'docker 端点解析不了'
      if (!(await docker.ping())) return 'docker daemon 够不着'
      const owner = await streamOwns(docker)
      if (owner) return `本机 OpenList 归 Stream 管（${owner}），本插件让位`
      const own = (await docker.listByService(MANAGED_SERVICE))[0]
      return own ? `自己的容器 stream-${MANAGED_SERVICE} 在（${own.State}）` : `还没有自己的容器，第一次用到时拉 ${image}`
    },
  }
}
