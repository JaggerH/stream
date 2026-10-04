/**
 * 「启动时把声明了 backend 的内置包的容器备齐」的**接线层**——bootstrap 只调这一个函数。
 *
 * 为什么单独一个模块（而不是 bootstrap 里一段 inline 闭包）：这段逻辑的安全属性是
 * 「docker 怎么坏都不掀翻启动、开关关着时一个 docker 调用都不发」，而这个属性只有在它
 * **能被单独调用**时才测得到。standby 的 wire.ts 是同一个立场，照它写。
 *
 * 两条不变量：
 * 1. **默认关闭**（`enabled` 来自 `config.manage_containers`）。关着时行为与接这条线之前
 *    一字不差：compose 起的容器照旧，零 docker 写操作。理由不是洁癖——用户机器上正跑着
 *    compose 建的插件容器，这条线一打开就由宿主接管它们的生命周期，那是一个
 *    要用户自己点头的事。
 * 2. **对不上就重建**：`recreateOnImageMismatch` 恒 true。包升级换了 image tag，容器就
 *    删了按新声明重建——不通知、不问、不给按钮。前提写在 `docs/PACKAGE.md` §4.1：**带 backend
 *    的包不许把状态留在容器层，要跨重启保留的一切都必须声明成 `volumes`**（宿主随时可能
 *    删了重建这个容器，卷不受影响）。责任在包作者那边，不是靠一条点不动的通知吓用户——
 *    只报不做的旧口径把容器永远钉在旧镜像上，用户唯一的出路是自己 `docker rm`。
 *
 * 事件不在这里发：events 在 bootstrap 里建得比 plugin 装载晚，所以这里只**攒**通知
 * （`notices`），由 bootstrap 在事件层建好后统一 emit（与 packageActivationFailures 同款）。
 */
import type { PluginDescriptor } from './types.ts'
import type { PluginNetMode } from './plugin-target.ts'
import { resolveDockerEndpoint, makeDockerClient, type DockerClient, type DockerEndpoint } from './standby/docker-api.ts'
import { provisionBackend, type ProvisionResult } from './provisioner.ts'

/** 与 compose 生成器（`generateCompose` 的 `NETWORK`）同一个名字——两条路产出的容器必须同网。 */
const NETWORK = 'stream'

export interface ProvisionWiringDeps {
  /** 内置包（`packages/` 那层）。 */
  descriptors: PluginDescriptor[]
  /**
   * 用户数据目录里装的第三方包中**声明了 backend 的那些**。
   *
   * 它们的声明在**安装期**已经被 `src/packages/container-policy.ts` 钳制过（service 名由宿主
   * 指派、卷名加包前缀、mem 必填且有上界），落盘的就是钳制后的字节。这里**只消费，不再钳一次**
   * ——两处各自钳，两份判据就会分家，而分家的表现是"安装页说的和真跑起来的不是一回事"。
   *
   * 运行时那两道防线仍在，且只在这一侧生效：`requireMemLimit`（下面传下去）与
   * `createContainer` 里对宿主 bind 的拒绝。它们堵的是同一条路——盘上的 package.json 被手改。
   */
  thirdParty?: PluginDescriptor[]
  /** `config.manage_containers`。false（默认）= 这条线整个不生效。 */
  enabled: boolean
  mode: PluginNetMode
  isEnabled: (p: PluginDescriptor) => boolean
  /** 下面都是注入点，默认即生产实现。 */
  network?: string
  resolveEndpoint?: () => DockerEndpoint | null
  makeClient?: (ep: DockerEndpoint) => DockerClient
  provision?: typeof provisionBackend
  log?: (msg: string) => void
}

/** 一条待发的通知。字段与 EventInput 同形，bootstrap 拿到就能直接 emit。 */
export interface ProvisionNotice {
  /** compose service 名（= 通知说的是哪个容器） */
  service: string
  severity: 'info' | 'warn' | 'error'
  title: string
  body?: string
  /** 必填：没有它每次启动都堆一条新的 */
  dedupeKey: string
}

export interface ProvisionWiringOutcome {
  results: ProvisionResult[]
  notices: ProvisionNotice[]
}

const serviceOf = (p: PluginDescriptor): string => p.backend?.service ?? p.id

/** 一个待备齐的容器 + 它来自哪一层。`thirdParty` 只决定运行时那道 mem 闸门与通知措辞。 */
interface Target { p: PluginDescriptor; thirdParty: boolean }

/**
 * 把每个声明了 backend 的**已启用**内置包的容器备齐。**绝不 throw**——单个容器起不来、
 * 甚至整台机器没有 docker，都只该是"这次没有容器"，不该是"Stream 起不来"。
 */
export async function provisionDeclaredBackends(deps: ProvisionWiringDeps): Promise<ProvisionWiringOutcome> {
  const log = deps.log ?? ((m: string) => console.log(m))
  const notices: ProvisionNotice[] = []
  const none: ProvisionWiringOutcome = { results: [], notices }

  // 闸门 1：开关。**关着时连端点都不解析**——这一行就是"默认不改变任何现状"的全部实现。
  if (!deps.enabled) return none

  // 内置在前、第三方在后：串行跑，内置那批是用户真正依赖的能力，不该排在第三方后面等。
  const targets: Target[] = [
    ...deps.descriptors.filter((p) => p.backend && deps.isEnabled(p)).map((p) => ({ p, thirdParty: false })),
    ...(deps.thirdParty ?? []).filter((p) => p.backend && deps.isEnabled(p)).map((p) => ({ p, thirdParty: true })),
  ]
  if (targets.length === 0) return none

  // 闸门 2：后端够不着容器的档（none）下建容器毫无意义，健康探活还会去打解析不了的容器 DNS
  // 一路等到超时。这不是降级，是"这台机器上就没有容器这条路"。
  if (deps.mode === 'none') {
    log('[provision] STREAM_PLUGIN_NETWORK 未设（后端够不着插件容器）—— 跳过容器接管')
    return none
  }

  // 闸门 3：docker 本身。解析不出端点 / ping 不通 = 没装 docker、daemon 没跑、socket 够不着。
  // standby 的 wire.ts 是同一个立场：一行日志，降级，绝不掀翻。但这里比 standby 更要**响亮**：
  // 用户是**显式**打开了 manage_containers 才走到这，什么都没发生必须有人告诉他。
  const ep = (deps.resolveEndpoint ?? (() => resolveDockerEndpoint(process.env, process.platform)))()
  const docker = ep ? (deps.makeClient ?? makeDockerClient)(ep) : null
  if (!docker || !(await docker.ping().catch(() => false))) {
    log('[provision] docker API 够不着 —— 已打开 manage_containers 但这次一个容器都没接管')
    notices.push({
      service: '*',
      severity: 'error',
      title: '插件容器没能接管：连不上 Docker',
      body: '你打开了 manage_containers，但后端连不上 Docker（没装 / daemon 没跑 / socket 够不着）。带后端容器的插件这次都不可用；Stream 其余部分照常。',
      dedupeKey: 'provision:docker-unreachable',
    })
    return none
  }

  const provision = deps.provision ?? provisionBackend
  const network = deps.network ?? NETWORK
  const results: ProvisionResult[] = []

  // 串行：并行拉镜像会几个 GB 一起下，而且失败现场混在一起读不出谁是谁。
  for (const { p, thirdParty } of targets) {
    const service = serviceOf(p)
    // `backend.publish`（AList 那种自带管理 UI 的固定宿主口）这条路还没做。静默 = 用户打开
    // AList 设置页发现打不开，却查不到为什么。
    if (p.backend?.publish) {
      notices.push({
        service,
        severity: 'warn',
        title: `${service} 的管理 UI 端口不会被发布`,
        body: `这个插件声明了固定宿主端口 ${p.backend.publish}（它自带的管理界面用），但后端接管容器这条路暂不支持发布宿主端口。要用它的管理界面，仍然走 docker compose 起这个容器。`,
        dedupeKey: `provision:publish-unsupported:${service}`,
      })
    }
    let r: ProvisionResult
    try {
      r = await provision(docker, p, {
        network,
        // host 档（后端在宿主上）必须发布 loopback 口：不发的话健康探活会去打容器 DNS，
        // 而宿主上的后端永远解析不了那个名字——容器明明起来了却判成"没起来"。
        publishLoopback: deps.mode === 'host',
        healthTimeoutMs: (p.backend?.standby?.startTimeoutSeconds ?? 60) * 1000,
        // 镜像与声明对不上就删了重建（见模块头注不变量 2）。容器层不许住状态，卷不受影响。
        recreateOnImageMismatch: true,
        // 只有第三方带这道运行时闸门（见 ProvisionOptions.requireMemLimit）。内置一字不变。
        requireMemLimit: thirdParty,
      })
    } catch (e) {
      // provisionBackend 的契约是"绝不 throw"。这里仍然接住：契约哪天破了，代价不该是
      // 整个 Stream 起不来。
      r = { service, action: 'skipped', error: e instanceof Error ? e : new Error(String(e)) }
    }
    results.push(r)
    notices.push(...noticeFor(p, r, thirdParty))
    log(logLineFor(r))
  }
  return { results, notices }
}

function logLineFor(r: ProvisionResult): string {
  const tail = r.error ? ` —— 失败于 ${r.action}：${r.error.message}` : ''
  return `[provision] ${r.service}: ${r.error ? 'error' : r.action}${r.containerId ? ` (${r.containerId.slice(0, 12)})` : ''}${tail}`
}

/** 什么值得打扰用户：出错、镜像对不上、以及"我替你建了个容器"。本来就在跑（`ran`）不发——
 *  每次启动都发一条"一切正常"等于把通知中心变成噪音场。 */
function noticeFor(p: PluginDescriptor, r: ProvisionResult, thirdParty: boolean): ProvisionNotice[] {
  const name = p.name ?? p.id
  // 缺内存上限是**被我们拒掉的**，不是"容器起不来"——现场不在 docker logs 里（根本没建），
  // 说错了地方等于把人支去查一个不存在的容器。
  if (r.error && thirdParty && !p.backend?.mem) {
    return [{
      service: r.service,
      severity: 'error',
      title: `没给 ${name} 建容器：它没声明内存上限`,
      body: '这个插件的 backend 缺 mem（内存上限），没有上限的容器可以吃满整台机器的内存，所以这次没有创建它。安装时这一格是强制的——会出现这种情况，说明装完之后它的 package.json 被改过。重新安装这个包，或在它的 package.json 里补上 mem（例如 "1G"）。',
      dedupeKey: `provision:missing-mem:${r.service}`,
    }]
  }
  if (r.error) {
    return [{
      service: r.service,
      severity: 'error',
      title: `插件容器没起来：${name}`,
      body: `这个插件的后端容器这次没能就绪（走到 ${r.action} 这一步失败），它提供的能力暂不可用。容器**没有被删掉**，\`docker logs stream-${r.service}\` 能看到它为什么起不来。原因：${r.error.message}`,
      dedupeKey: `provision:error:${r.service}`,
    }]
  }
  if (r.action === 'created' || r.action === 'started' || r.action === 'recreated') {
    // 'recreated' 是**通报**不是请示：镜像对不上已经重建完了，卷里的东西不受影响
    // （容器层不许住状态，见 docs/PACKAGE.md §4.1）。它只在包升级换 tag 时出现，不是噪音。
    const title = r.action === 'created'
      ? `已为 ${name} 创建后端容器`
      : r.action === 'started'
        ? `已启动 ${name} 的后端容器`
        : `已按新镜像重建 ${name} 的后端容器`
    return [{
      service: r.service,
      severity: 'info',
      title,
      body: r.action === 'recreated'
        ? '这个插件升级换了容器镜像，旧容器已删掉、按新声明重建。声明了 volume 的数据（配置、模型缓存等）不受影响。'
        : undefined,
      dedupeKey: `provision:${r.action}:${r.service}`,
    }]
  }
  return []
}
