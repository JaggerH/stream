import { stringify as stringifyYaml } from 'yaml'
import type { PluginDescriptor } from './types.ts'
import { GATEWAY_PORT, GATEWAY_PREFIX } from './gateway.ts'

/** The shared network every Stream-managed container joins (same-network DNS). */
const NETWORK = 'stream'

/** Tag for Stream's own image. **曾经是 serve-backend 与 serve-frontend 共用的那一份**——
 *  前端容器（跑 Vite 发老版 UI）已随老版 UI 一起下线，界面现在住在后端发的对话工作台里，
 *  所以这个 tag 只剩一个消费者，留着是为了 dev overlay 里那条 image 复用。 */
const STREAM_IMAGE = 'stream-backend'

export interface ComposeOptions {
  // **别在这里加"取登录态"用的基础服务。** 登录态由后端直接向用户的 Chrome 要，采集零容器；
  // 加一个这样的容器就把 docker 变成采集的硬依赖，而它一停的表现是全站游客态，没有一处会喊。
  /**
   * Stream's OWN backend+frontend containers (not plugins). When given, generateCompose emits
   * them as base services (backend built from the repo Dockerfile — native deps baked in, no
   * runtime patches) and generateDevOverride emits their source-mount + reload.
   * This is what folds the old hand-written docker-compose.local.yml into the generated pair,
   * so `docker compose up` is a single entry point.
   */
  stream?: StreamServices
}

export interface StreamServices {
  backendPort: number
  /** dev bind-mount for RSSHub source. tsconfig `paths` hardcode the dest, so the mount target
   *  is fixed; the source is env-overridable for portability. e.g.
   *  `${RSSHUB_SRC:-../RSSHub}:/rsshub:ro` */
  rsshubMount: string
  /** audio archive mount (host NAS → /nas-music), env-overridable source. */
  nasMount: string
}

/** Recursively sort object keys so emitted YAML is deterministic / diffable. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/** A GPU reservation (compose deploy.resources.reservations.devices). */
type GpuDeploy = {
  resources: { reservations: { devices: { driver: string; count: number; capabilities: string[] }[] } }
}

interface ComposeService {
  image?: string
  /** repo-relative build context (Stream's own backend image); mutually exclusive with image */
  build?: string
  working_dir?: string
  command?: string
  env_file?: string[]
  expose?: string[]
  networks: string[]
  environment?: Record<string, string>
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number }
  ports?: string[]
  volumes?: string[]
  deploy?: GpuDeploy
  mem_limit?: string
  memswap_limit?: string
  user?: string
  depends_on?: string[]
  restart?: string
}

function backendService(b: {
  image: string
  port: number
  health?: string
  env?: Record<string, string>
  gpu?: boolean
  volumes?: string[]
  mem?: string
  publish?: number
  user?: string
}): ComposeService {
  const svc: ComposeService = {
    image: b.image,
    // expose: for internal-only same-network DNS. ports: every backend also publishes a
    // loopback random port (127.0.0.1::<port>) for host-plugin-door data plane to reach it.
    expose: [String(b.port)],
    networks: [NETWORK],
  }
  // 「一扇门」host 档数据面:每个 backend 发布一个 loopback 随机宿主口(双冒号=内核随机分配,
  // Docker 持有、容器 stop 即释放)。绑 127.0.0.1 不对外暴露;compose 档没人用它,零影响。
  // 宿主后端唤醒容器后 inspect 出映射口直连(spec 2026-07-22-host-plugin-door)。
  const ports = [`127.0.0.1::${b.port}`]
  // Facilities with their own admin UI (e.g. AList) ALSO publish a fixed host port: the
  // gateway's /_p/<service>/* prefix breaks SPA asset paths, so operators use the real port.
  if (b.publish) ports.push(`${b.publish}:${b.port}`)
  svc.ports = ports
  if (b.env && Object.keys(b.env).length > 0) svc.environment = b.env
  if (b.health) {
    const probe = `http://localhost:${b.port}${b.health}`
    svc.healthcheck = {
      // 镜像里装了什么不由我们说了算——第三方镜像常常 wget/curl 一个都没有（抖音那个只有
      // python），而探针工具缺席时 docker 只报「容器 unhealthy」，不会说是探针自己跑不起来：
      // `up -d --wait` 就那么卡死，现场一个字的线索都没有。所以逐个退让到镜像真有的那件上。
      // CMD-SHELL 保证这串 || 链在各家 shell 下都成立。
      test: [
        'CMD-SHELL',
        `wget -qO- ${probe} || curl -fsS ${probe} || python3 -c "import urllib.request,sys;urllib.request.urlopen('${probe}')" || exit 1`,
      ],
      interval: '10s',
      timeout: '5s',
      retries: 5,
    }
  }
  if (b.volumes && b.volumes.length > 0) svc.volumes = b.volumes
  // 与 provisioner 的 specFor 同一格：两条建容器的路必须跑成同一个用户，否则同一个卷
  // 在 compose 起的容器里能写、在 standby 自建的容器里不能写。
  if (b.user) svc.user = b.user
  if (b.mem) {
    // memswap_limit = mem_limit ⇒ swap allowance is zero (no host swap-thrash on a runaway)
    svc.mem_limit = b.mem
    svc.memswap_limit = b.mem
  }
  if (b.gpu) {
    svc.deploy = {
      resources: { reservations: { devices: [{ driver: 'nvidia', count: 1, capabilities: ['gpu'] }] } },
    }
  }
  return svc
}

/** A volume mount's source is a top-level named volume when it's a bare name (no path
 *  separator, no relative/abs/interpolated prefix) — declare those so compose creates them. */
function namedVolumesOf(mounts: string[]): string[] {
  const names: string[] = []
  for (const m of mounts) {
    const src = m.split(':')[0]
    if (src && !src.includes('/') && !src.startsWith('.') && !src.startsWith('$')) names.push(src)
  }
  return names
}

/**
 * Pure function: generate a docker-compose YAML from the ACTIVE plugin set + base
 * services. `docker compose up -d` over this output reconciles idempotently. Output
 * is deterministic (keys sorted) so it's diffable across runs.
 *
 *  - a shared `stream` network
 *  - one service per plugin that declares a `backend` (named backend.service ?? id),
 *    image + internal port + optional healthcheck + non-secret env, on the network
 *
 * Secrets/cookies are NEVER written here. The host is the only scheduler: it resolves the cookie
 * a call needs and hands it down through the adapter — a container never holds a standing
 * credential. (This file gets `cat`-ed and, once, was even git-tracked.)
 */
export function generateCompose(plugins: PluginDescriptor[], opts: ComposeOptions = {}): string {
  const services: Record<string, ComposeService> = {}
  const backendNames: string[] = []

  const volumeNames = new Set<string>()
  for (const p of plugins) {
    if (!p.backend) continue
    const name = p.backend.service ?? p.id
    services[name] = backendService(p.backend)
    // **这里不发凭证。** 生成物会被人 `cat`、会被误提交，而容器根本不需要自己去要 cookie——
    // 宿主是唯一调度方，凭证由 adapter 随请求递下去（见 src/http/app.ts 里那段撤销说明）。
    for (const v of namedVolumesOf(p.backend.volumes ?? [])) volumeNames.add(v)
    backendNames.push(name)
  }

  // Stream's own backend+frontend. ONE image (built from the repo Dockerfile: native deps baked
  // in — no runtime apt, no runtime pnpm install, and no browser at all), run as two services
  // with different commands. Both were hand-written
  // in docker-compose.local.yml; folding them here makes `docker compose up` a single entry
  // point. The shared `image: stream-backend` tag means compose builds the context ONCE and the
  // frontend reuses it. Source-mount + reload live in the dev override; the baked form here
  // COPY's the source and runs the deps straight out of the image (see Dockerfile).
  if (opts.stream) {
    services['serve-backend'] = {
      build: '.',
      image: STREAM_IMAGE,
      env_file: ['.env'],
      environment: {
        STREAM_CONFIG: '/app/config.yaml',
        // 端口显式：后端的默认口已经是那扇门本身（8900，见 src/serve.ts 的 PORT 注释）。
        // 自托管旁支里门是 Caddy、后端躲在网内，所以这条路必须显式把它按回 backendPort——
        // 少了这一行，Caddy 反代 :4555 而后端绑在 :8900，整站 502。
        STREAM_PORT: String(opts.stream.backendPort),
        // in-network mode: serve-backend sits on the `stream` network alongside every plugin
        // container, so it resolves plugin DNS (e.g. pansou:8888) directly instead of via a
        // gateway hop — this is what makes the backend the /_p owner (see resolvePluginTarget).
        STREAM_PLUGIN_NETWORK: 'compose',
        // ext-cdp transport: replay drives the user's own Chrome via the /api/ext relay
        REPLAY_TRANSPORT: 'extension',
      },
      volumes: [
        './config.yaml:/app/config.yaml',
        'stream-data:/app/data',
        opts.stream.nasMount,
        // standby 声明在场 → 后端要 Docker Engine API 才能 stop/start 容器(spec「两种部署形态」)
        ...(plugins.some((p) => p.backend?.standby) ? ['/var/run/docker.sock:/var/run/docker.sock'] : []),
      ],
      expose: [String(opts.stream.backendPort)],
      networks: [NETWORK],
    }
    volumeNames.add('stream-data')
  }

  // The gateway — **自托管旁支专属**（`opts.stream` 在场才有意义）。它是 serve-backend 前面的
  // 一层薄边：把 /api、/ws、/、/_p 一起转进去，让整套容器栈只发布一个宿主口。
  //
  // 主路（后端原生跑在宿主上）**没有这个东西**：后端自己就是那扇门，直接绑 8900，
  // /_p 本来就归它（src/http/plugin-gateway.ts），插件走 host 档的 loopback 门。
  // 所以这里的条件是 opts.stream 而不是"有没有插件后端"——没有 serve-backend 的时候，
  // 一个 Caddy 站在那儿无处可转。
  if (opts.stream && backendNames.length > 0) {
    services.gateway = {
      image: 'caddy:2-alpine',
      ports: [`127.0.0.1:${GATEWAY_PORT}:80`],
      volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro', './Caddyfile.local:/etc/caddy/Caddyfile.local:ro'],
      networks: [NETWORK],
      depends_on: backendNames.slice().sort(),
    }
  }

  const doc: Record<string, unknown> = {
    networks: { [NETWORK]: { driver: 'bridge' } },
    services,
  }
  // declare any named volumes the backends mount (compose creates/persists them)
  if (volumeNames.size > 0) {
    doc.volumes = Object.fromEntries([...volumeNames].map((n) => [n, null]))
  }

  return stringifyYaml(sortKeys(doc))
}

/**
 * Pure function: generate the Caddyfile that the gateway runs. The gateway is a thin edge —
 * it no longer routes `/_p/<plugin>` directly to each plugin container. The backend
 * (serve-backend, see generateCompose) now OWNS `/_p`: it sits on the same `stream` network
 * as every plugin and resolves plugin DNS itself (STREAM_PLUGIN_NETWORK=compose), so Caddy
 * doesn't need a per-plugin route to reach them.
 *
 *
 * Ends with `import Caddyfile.local` — a sibling file this generator never writes and
 * never overwrites, for whatever routes the deployment adds outside the plugin set
 * (e.g. the frontend/backend dev containers). Copy `Caddyfile.local.example` to seed it;
 * Caddy errors if the import target is missing, so that file must exist.
 */
export function generateCaddyfile(_plugins: PluginDescriptor[], _opts: ComposeOptions = {}): string {
  const routes: string[] = []
  routes.push('\timport Caddyfile.local')
  return `:80 {\n${routes.join('\n')}\n}\n`
}

interface DevOverrideService {
  /** absent = inherit the base service's build/image (Stream backend rides its baked image) */
  image?: string
  working_dir?: string
  volumes: string[]
  command: string
}

/**
 * Pure function: generate the docker-compose OVERRIDE (compose auto-merges a sibling
 * `docker-compose.override.yml`) that swaps every plugin declaring `backend.dev` to a
 * base image with its source bind-mounted + a reload command — live code, no rebuild.
 * Plugins without `backend.dev` are absent here, so they keep their baked image from the
 * base compose. Deterministic (keys sorted). Empty `services` when nothing declares dev.
 */
export function generateDevOverride(plugins: PluginDescriptor[], opts: ComposeOptions = {}): string {
  const services: Record<string, DevOverrideService> = {}

  for (const p of plugins) {
    const dev = p.backend?.dev
    if (!dev) continue
    const name = p.backend?.service ?? p.id
    const workdir = dev.workdir ?? '/app'
    services[name] = {
      image: dev.image,
      working_dir: workdir,
      volumes: [`${dev.mount}:${workdir}`],
      command: dev.command,
    }
  }

  // Stream backend+frontend dev: overlay a source bind-mount + reload command on the baked
  // image (native deps already in it). The ANONYMOUS node_modules
  // volumes (`/app/node_modules`, `/app/app/node_modules` — no source) shield the image's
  // Linux-native install from being shadowed by the host `.:/app` mount, so the baked deps are
  // used as-is with NO runtime install. RSSHub source mounts to its tsconfig-hardcoded path.
  // Volumes REPLACE the base list under compose merge, so each lists everything it needs.
  if (opts.stream) {
    services['serve-backend'] = {
      // NOTE: compose merges volumes by TARGET, not whole-list-replace — so the base service's
      // `stream-data:/app/data` (a named volume, right for prod) SURVIVES here unless we mount the
      // same target. In dev the DB must live on the host (`./data`, visible + the real data), so
      // re-bind /app/data to `./data` to win over the base's named volume. (`.:/app` already maps
      // it, but the base named-volume mount at that exact target would otherwise shadow it.)
      volumes: ['.:/app', '/app/node_modules', './data:/app/data', opts.stream.rsshubMount, opts.stream.nasMount],
      command: 'pnpm exec tsx watch src/serve.ts',
    }
  }

  return stringifyYaml(sortKeys({ services }))
}
