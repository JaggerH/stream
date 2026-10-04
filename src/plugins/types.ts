/**
 * Plugin descriptor — the deploy-anywhere standard that turns a facility into a
 * Stream-managed plugin. A plugin = an adapter (mapping the facility's API → Stream
 * types) + optionally a Stream-MANAGED backend container (the facility's OWN
 * published image — Stream never repackages it) + a normalizer + declared credential
 * needs (cookie domains the host is allowed to hand this package).
 *
 * Descriptors live in the `stream` field of `packages/<id>/package.json` and are loaded
 * at boot (parsed by `src/packages/descriptor.ts`). The active set drives
 * compose generation (backend services) and documents which adapter/normalizer pair a
 * plugin registers under.
 */

/**
 * Dev-time override for a backend: run a base image with the facility's source
 * bind-mounted + a reload command, so code changes are live with NO rebuild. Emitted
 * only by `compose --dev` (into docker-compose.override.yml); the baked `image` is the
 * distribution default. Absent → the plugin has no dev-mount (use its baked image).
 */
export interface PluginBackendDev {
  /** base image to run the bind-mounted source in, e.g. 'python:3.11' */
  image: string
  /** host path bind-mounted into the container; compose interpolates ${HOME} etc. */
  mount: string
  /** container dir the mount lands at (default '/app') */
  workdir?: string
  /** the run command incl. reload, e.g. 'uvicorn app.main:app --host 0.0.0.0 --port 80 --reload' */
  command: string
}

export interface PluginBackend {
  /** the facility's OWN published image (Stream never repackages it) */
  image: string
  /** compose service name; adapters reach it at http://<service>:<port>; default = plugin id */
  service?: string
  /** internal container port */
  port: number
  /** health probe GET path, 2xx = ready (default '/') */
  health?: string
  /** non-secret container env. **Never secrets or cookies** — the generated compose is a file
   *  people `cat` and accidentally commit. A container that needs a login gets it from the host
   *  per request (the host is the only scheduler); it never holds a standing credential. */
  env?: Record<string, string>
  /** request GPU access (emits compose deploy.resources.reservations.devices: nvidia).
   *  This is the LOCAL stack — a CPU-only host should drop this flag. */
  gpu?: boolean
  /** service volumes, e.g. ['mineru-cache:/root/.cache'] to persist a model cache across
   *  restarts. A bare-name source (no '/') is declared as a top-level named volume. */
  volumes?: string[]
  /** hard memory cap, e.g. '8G' (compose mem_limit). Emitted with memswap_limit = mem so
   *  the container CANNOT swap — a runaway gets OOM-killed inside the container fast instead
   *  of swap-thrashing the host (mirrors the dev cage's MemorySwapMax=0). */
  mem?: string
  /** 容器内跑成谁（`uid` 或 `uid:gid`，直通 Engine API 的 `Config.User` / compose 的 `user`）。
   *  不给 = 沿用镜像自己的 USER。**为什么有这一格**：Engine API / compose 新建的命名卷是 root
   *  属主，而有的镜像以非 root 跑、入口只查数据目录能不能写、不 chown（OpenList 以 UID 1001
   *  跑就是这样），在全新的卷上容器秒退，日志只有一行权限错。只给内置包用；第三方声明
   *  一律拒（`container-policy.ts`）。 */
  user?: string
  /** ALSO publish this host port (`<publish>:<port>`) alongside the gateway route.
   *  For facilities with their own admin UI (e.g. AList) where the user configures
   *  storage directly — the gateway `/_p/<service>/*` path-prefix breaks SPA asset
   *  paths, so a real host port is the pragmatic escape hatch. Backends WITHOUT an
   *  operator UI should stay gateway-only (the default). */
  publish?: number
  /** dev-mount override (base image + bind-mount + reload); emitted by `compose --dev` only */
  dev?: PluginBackendDev
  /** 闲置回收 + 按需唤醒(standby-manager)。absent = 常驻(行为不变)。
   *  见 docs/superpowers/specs/2026-07-22-standby-plugin-backends-design.md */
  standby?: PluginBackendStandby
}

export interface PluginBackendStandby {
  /** 闲置多少分钟后 stop(内存归零;容器保留,镜像/volume 原地) */
  idleMinutes: number
  /** 唤醒后等 health 绿的上限秒数(默认 60;mineru 这类给 120) */
  startTimeoutSeconds?: number
}

import type { SourceManifest } from '../manifest/types.ts'

export interface PluginSourceGrouping {
  /** toggle grouping on/off for the plugin's source list */
  enabled: boolean
  /** scoped resolver call point, e.g. `manifest.facility`, `adapter.groupByNamespace` */
  resolver: 'manifest.facility' | `adapter.${string}` | `plugin.${string}`
  /** optional resolver parameters */
  params?: Record<string, unknown>
}

export interface PluginDescriptor {
  /** plugin id (also the adapter id it registers under) */
  id: string
  /** Human display name, e.g. RSSHub instead of rsshub. */
  name?: string
  /** Core plugin the product cannot run without (e.g. rsshub/builtin). Required plugins are
   *  always enabled and CANNOT be disabled from the UI (the toggle is locked on). Declared here
   *  — never a hardcoded id list in the frontend/backend — so "which plugins are essential" is a
   *  descriptor fact. Absent = optional (user-toggleable). */
  required?: boolean
  /** One-line subtitle sourced from the upstream project/README when possible. */
  tagline?: string
  /** Short capability/channel summary shown in Plugin catalog UI. */
  description?: string
  /** Original project or service website. */
  homepage?: string
  /** Upstream repository, generally where the README lives. */
  repository?: string
  /** Upstream docs URL when separate from the README. */
  docsUrl?: string
  /** Stream-managed backend container; absent = in-process adapter (xhs/rsshub) or external-url */
  backend?: PluginBackend
  /** source grouping declaration used by the plugin source list UI/API */
  sourceGrouping?: PluginSourceGrouping
  /** cookie domains this plugin may be given, e.g. ['example.com']. It is a **declaration**, not a
   *  fetch path: the host injects what a call needs (`init(env)` / `sidecar.start(creds)`), and
   *  `makeCookieFor` refuses any domain not listed here. */
  credentials?: string[]
  /** normalizer id */
  normalizer?: string
  /** @deprecated legacy alias for `normalizer` — accepted so pre-rename
   *  descriptors keep loading. New descriptors should use `normalizer`. */
  presenter?: string
  /** nested source manifests this plugin provides */
  sources?: SourceManifest[]
  /** 这个包带一个能力（`stream.capability`，值恒为 `dist/index.js`）。目录里透传它，是因为
   *  「组件」页要能说出这一行给了哪些工具——工具名本身由 `src/capabilities/host.ts` 现给。 */
  capability?: string
}
