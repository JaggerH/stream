import { writeFileSync } from 'node:fs'
import { loadConfig } from '../bootstrap.ts'
import { loadPlugins } from './loader.ts'
import { generateCaddyfile, generateCompose, generateDevOverride, type ComposeOptions } from './compose.ts'

/**
 * 主路的 base services：**空的**——生成物里只有插件容器，一个基础设施容器都没有。
 *
 * Stream 自己的 backend/frontend 不在这里（后端出容器后跑在宿主上原生进程里，网关也随之
 * 消失——后端自己就是门），那套三件套只剩自托管旁支，见 `SELFHOST_SERVICES`。
 *
 * **别往这里加"取登录态"用的基础设施容器。** 登录态由后端直接向用户的 Chrome 要
 * （`op:'cookiePull'`），采集零容器；加一个这样的容器就等于把 docker 变成采集的硬依赖，
 * 而它一停的表现是全站游客态，且没有任何一处会喊。
 */
export const BASE_SERVICES: ComposeOptions = {}

/**
 * 自托管旁支（NAS/VPS：没有"用户的浏览器"那一侧，登录源本来就不属于这个形态）的整套栈：
 * 主路的插件容器 + Stream 自己的 backend/frontend + 那层薄 Caddy 边。
 *
 * RSSHub source mounts to its tsconfig-hardcoded path (dest fixed; source env-overridable).
 * nas source is env-overridable too.
 */
export const SELFHOST_SERVICES: ComposeOptions = {
  ...BASE_SERVICES,
  stream: {
    backendPort: 4555,
    rsshubMount: '${RSSHUB_SRC:-../RSSHub}:/rsshub:ro',
    // 宿主侧缺省落在 compose 目录（自托管这一档的 Stream 根目录，config.yaml 也在这里）；要挂 NAS 就设
    // NAS_MUSIC。缺省指家目录的话，docker 会在宿主上凭空建一个空目录（2026-09-27 用户拍板：默认位置
    // 一律在 Stream 根目录下）。
    nasMount: '${NAS_MUSIC:-./music}:/nas-music',
  },
}

/** 主路 = 只有插件容器层（Stream 自己跑在宿主上）；`selfhost` 才把三件套 + 网关折回来。 */
function servicesFor(selfhost: boolean): ComposeOptions {
  return selfhost ? SELFHOST_SERVICES : BASE_SERVICES
}

/**
 * Build the docker-compose YAML for the active plugin set + base services. The active
 * set comes from the configured packages directory（并轨后插件包与 recipe 包同住一层，
 * `loadPlugins` 按槽位挑出填了插件槽的那些）。
 *
 * **生成物里没有任何凭证。** 这里曾经给申报了 `credentials` 的服务铸一个
 * `STREAM_CREDENTIAL_TOKEN` 写进 YAML——那条路已经撤销（宿主是唯一调度方，容器不向宿主要
 * cookie；见 `src/http/app.ts` 里的撤销说明）。连带撤掉的还有 `--selfhost` 那档的
 * "token 会分家"告警：那个警告存在的唯一原因就是这套分发机制本身。
 */
export function buildCompose(configPath?: string, opts: { selfhost?: boolean } = {}): string {
  const config = loadConfig(configPath)
  const plugins = loadPlugins(config.packages_dir)
  return generateCompose(plugins, servicesFor(!!opts.selfhost))
}

/** Build the dev override (docker-compose.override.yml) for plugins declaring backend.dev. */
export function buildDevOverride(configPath?: string, opts: { selfhost?: boolean } = {}): string {
  const config = loadConfig(configPath)
  const plugins = loadPlugins(config.packages_dir)
  return generateDevOverride(plugins, servicesFor(!!opts.selfhost))
}

/**
 * `stream plugins compose`             — 主路：插件容器层（Stream 自己原生跑在宿主上）
 * `stream plugins compose --dev`       — 主路的 dev override（声明了 backend.dev 的插件换成挂载+reload）
 * `stream plugins compose --selfhost`  — 自托管旁支：上面那些 + serve-backend + 网关，
 *                                        并写出 ./Caddyfile（只有这一档需要 Caddy）
 *
 * Usage:
 *   pnpm plugins compose       > docker-compose.yml            # 主路：只有插件容器
 *   pnpm plugins compose --dev > docker-compose.override.yml   # optional, dev only
 *   docker compose up -d       # merges both automatically
 *   pnpm plugins compose --selfhost > docker-compose.selfhost.yml   # NAS/VPS 整套
 *
 * 自托管那一档的路由表（Caddyfile）由**同一批描述符**生成、写到 ./Caddyfile（网关挂载它），
 * 两者不会漂。Caddyfile 是 side-write——compose YAML 仍然走 stdout 重定向。
 *
 * TODO(next): execute `docker compose up -d` against the generated file(s) and
 * health-gate on each backend's healthcheck before marking the stack ready
 * (out of scope for the foundation — the generators are the building block).
 */
function main(): void {
  const [, , cmd, ...flags] = process.argv
  if (cmd !== 'compose') {
    console.error('usage: stream plugins compose [--dev] [--selfhost]')
    process.exit(2)
  }
  const selfhost = flags.includes('--selfhost')
  const services = servicesFor(selfhost)
  const config = loadConfig()
  const plugins = loadPlugins(config.packages_dir)
  if (flags.includes('--dev')) {
    process.stdout.write(generateDevOverride(plugins, services))
    return
  }
  // Caddyfile 只属于自托管那一档——主路没有网关容器，写一份没人读的路由表只会骗人。
  if (selfhost) {
    writeFileSync('./Caddyfile', generateCaddyfile(plugins, services))
    console.error('[plugins] wrote ./Caddyfile (selfhost gateway routes)')
  }
  process.stdout.write(generateCompose(plugins, services))
}

if (import.meta.url === `file://${process.argv[1]}`) main()
