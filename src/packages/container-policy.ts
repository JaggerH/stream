/**
 * 第三方包的容器声明边界——**这一格对第三方开放之前，先立的那道边界**。
 *
 * 内置包（`packages/<id>/`）是我们自己写的，走原样声明；第三方包（npm 装进来的）的 `backend`
 * 一律先过这里：不合规**抛错**（安装期就拒，不留到运行时），合规的**钳制成安全形态**再交给
 * provisioner / compose。调用方一律用返回值，不要再用原始声明。
 *
 * 两条口径（权威设计：docs/superpowers/specs/2026-08-05-package-unification-design.md）：
 *
 * 1. **service 名由宿主指派，恒等于包 id。** service 名是全局单一命名空间，三处共用——
 *    `/_p/<service>` 网关路由、standby 名册（重名在名册构造期抛，被 serve.ts 的
 *    `buildStandbyOrDegrade` 降级成一行日志 ⇒ 后果是**全体** standby 失效：所有插件容器
 *    不再回收/唤醒，比开不了机更难查）、compose service key。
 *    包 id 在安装期已经保证不撞，所以 id 唯一 ⇒ service 名唯一 ⇒ 三处天然无冲突。
 * 2. **命名卷加包前缀。** 两个第三方包各自写 `data:/x`，不加前缀就是**同一个 docker 卷**，
 *    A 能读写 B 的数据。
 *
 * 「什么算宿主路径 bind」的判据不在这里——复用 `src/plugins/standby/docker-api.ts` 的
 * `isHostBindMount`（运行时 createContainer 用的是同一个函数）。
 */
import { isHostBindMount, parseMemBytes } from '../plugins/standby/docker-api.ts'
import { healthPathProblem } from '../plugins/health-path.ts'
import type { PluginBackend } from '../plugins/types.ts'

/**
 * 第三方容器没声明 `standby` 时宿主兜的默认值：闲置这么多分钟就回收（stop，容器/卷原地留着，
 * 下次用到再唤醒）。
 *
 * 为什么是兜底而不是拒：常驻是**资源治理**问题，不是安全边界——一个第三方容器长期占着内存
 * 只是浪费，不会越权。拒掉的代价（包作者少写一格就装不上）高于自动补一个安全值。而 standby
 * 本身是成熟机制，唤醒对调用方透明。补出来的值会进钳制后的声明，因此也会出现在安装确认页上，
 * 用户看得到「闲置 30 分钟后回收」。
 */
export const DEFAULT_STANDBY_IDLE_MINUTES = 30

/** 第三方容器声明的上界。集中在这里，改一个数只改一处。
 *  **没有 `gpu` 与 `mem` 的上界**：装一个包本来就是信任作者（同 dsh 插件），要显卡、要 10G 内存都是
 *  包作者对自己镜像的诚实声明，钳它们挡不住任何人，只会把正经的 GPU 包挡在门外；`mem` 仍**必须
 *  声明**（不声明 = 不限制，那是漏写，不是选择）。这里剩下的都是命名空间 / 注入面 / 文件系统边界。 */
export const THIRD_PARTY_LIMITS = {
  maxEnvEntries: 32,
  maxEnvValueLength: 4096,
  maxVolumes: 4,
  /**
   * `standby.startTimeoutSeconds` 的上界。这个数**就是开机时长**：provision 是 bootstrap 里
   * await 的串行循环，一个永远不健康的容器会把整个后端启动卡满这么久，没有第二道超时兜底、
   * 也没有一行日志解释"为什么开机这么慢"。5 分钟已经够冷启一个几 GB 的镜像。
   */
  maxStartTimeoutSeconds: 300,
  /** `standby.idleMinutes` 的上界。24 小时以上等于声明常驻——那正是 standby 要治的东西。 */
  maxIdleMinutes: 24 * 60,
}

/**
 * 第三方包 id 的文法。id 不只是个标识符：它被指派成 service 名，于是同时是**容器名**
 * （`stream-<id>`）、**卷名前缀**、**URL 路径段**（`/_p/<id>/`）。
 *
 * 为什么必须收紧（终审 Minor 4）：撞名闸门是精确字符串比较，`Alist` 撞不上内置的 `alist`，
 * 于是它照样装得上、照样建一个容器、照样占一条 `/_p/Alist` 路由——两个长得几乎一样的东西
 * 同时存在，而用户看到的只有一个"怎么有时候通有时候不通"。
 */
const PKG_ID_GRAMMAR = /^[a-z0-9][a-z0-9_-]*$/

/** image 引用是不是浮动的：没 tag、或 tag 是 `latest`。`@sha256:…` digest 算钉死。
 *  tag 只看最后一个路径段之后的 `:`——`registry.local:5000/thing` 的 `:5000` 是端口不是 tag。 */
export function floatingImageTag(image: string): boolean {
  if (image.includes('@')) return false
  const lastSegment = image.slice(image.lastIndexOf('/') + 1)
  const colon = lastSegment.indexOf(':')
  if (colon < 0) return true
  return lastSegment.slice(colon + 1) === 'latest'
}

/** `STREAM_` 前缀是宿主往容器里注入用的命名空间，包不许占。 */
const RESERVED_ENV_PREFIX = 'STREAM_'

/** 宿主指派给第三方包的 service 名 = 它的包 id。包不许自己选。 */
export function assignedServiceName(pkgId: string): string {
  return pkgId
}

/** 第三方的命名卷加包前缀：两个包各自写 `data:/x` 不该变成共享存储。 */
export function prefixedVolume(pkgId: string, mount: string): string {
  const [src, ...rest] = mount.split(':')
  return [`${pkgId}_${src ?? ''}`, ...rest].join(':')
}

function reject(pkgId: string, what: string, why: string, how: string): never {
  throw new Error(`第三方包 '${pkgId}' 的 backend 声明被拒：${what}——${why}。${how}`)
}

/**
 * 第三方 `backend` 声明合不合规。不合规**抛错**，消息要可执行（哪一条、为什么、该怎么写）。
 * 合规时返回**钳制后**的声明（service 名已指派、卷名已加前缀）——调用方一律用返回值，
 * 不要再用原始声明。
 *
 * 不按作者分档：`gpu` 与大 `mem` 对官方包和第三方包一律放行（理由见 THIRD_PARTY_LIMITS 头注）；
 * 拒的只有 `service` / `dev` / `user` / `publish` 这类宿主命名空间与文件系统边界，跟作者是谁无关，
 * 外加一条更新机制的前提：`image` 必须钉版本 tag 或 digest（见 `floatingImageTag`）。
 */
export function clampThirdPartyBackend(pkgId: string, backend: PluginBackend): PluginBackend {
  if (!PKG_ID_GRAMMAR.test(pkgId)) {
    reject(
      pkgId,
      `包 id '${pkgId}' 不合文法`,
      'id 被指派成 service 名，于是同时是容器名 stream-<id>、卷名前缀和 URL 路径段 /_p/<id>/；' +
        '而撞名闸门是精确比较，大小写不同的两个 id 谁也挡不住谁',
      "id 只能是小写字母、数字、- 和 _，且首字符是字母或数字（如 'acme-scraper'）。",
    )
  }

  if (backend.service !== undefined) {
    reject(
      pkgId,
      `不接受 backend.service（写了 '${backend.service}'）`,
      'service 名是全局命名空间（网关路由 /_p/<service>、standby 名册、compose service key 三处共用），由宿主指派',
      `删掉这一行；宿主会把它指派成包 id '${assignedServiceName(pkgId)}'，容器对外就在 /_p/${assignedServiceName(pkgId)}/。`,
    )
  }

  if (backend.publish !== undefined) {
    reject(
      pkgId,
      `不接受 backend.publish（写了 ${backend.publish}）`,
      '那会在宿主上多开一个对外端口，第三方容器不该有额外的宿主管理口',
      `删掉这一行；后端经网关 /_p/${assignedServiceName(pkgId)}/ 访问即可。`,
    )
  }

  if (backend.dev !== undefined) {
    reject(
      pkgId,
      '不接受 backend.dev',
      'dev 覆盖会把宿主源码目录 bind-mount 进容器，等于把宿主文件系统交出去',
      '删掉这一格；第三方包只能跑自己发布的镜像。',
    )
  }

  if (backend.user !== undefined) {
    reject(
      pkgId,
      `不接受 backend.user（写了 '${backend.user}'）`,
      '容器内跑成谁应由镜像自己的 USER 决定；这一格能把一个按非 root 设计的镜像抬成 root，' +
        '而宿主对第三方镜像里跑的是什么一无所知',
      '删掉这一行；镜像需要写数据卷就让入口自己 chown，或改镜像的 USER。',
    )
  }

  // `gpu: true` 照单收下：带 GPU 预留的容器在没装 nvidia container toolkit 的机器上起不来，
  // 那是包 README 该写明的前提，不是安装门该替用户拒的事（确认页上 `summarizeBackend` 会把 gpu 亮出来）。

  // image 必须钉死（版本 tag 或 digest）。这不是信任问题，是更新机制的前提：宿主接管只比
  // `Config.Image` 那个字符串（provisioner.ts），`stream update` 换清单 = 换 tag → 判成不一致 → 重建。
  // 钉 `:latest` 的清单更新后字符串没变，容器永远跑着装机那天拉到的那一层，而 health / standby /
  // /api/packages 全绿——没有一处会喊。
  if (floatingImageTag(backend.image)) {
    reject(
      pkgId,
      `backend.image '${backend.image}' 没有钉版本`,
      '没 tag 或 :latest 是浮动的——stream update 靠换 tag 触发容器重建，浮动 tag 永远重建不了，用户会一直跑旧镜像',
      "钉一个版本 tag（如 ghcr.io/you/thing:1.2.0）或 digest（@sha256:…），并让镜像版本随包版本一起发。",
    )
  }

  if (backend.mem === undefined) {
    reject(
      pkgId,
      '缺 backend.mem',
      '不声明内存上限 = 不限制 = 这个容器可以吃满宿主内存',
      "显式写一个上限，如 mem: '1G'（多大都行，但必须写）。",
    )
  }
  // 解析得出来就行，多大不设上限（理由见 THIRD_PARTY_LIMITS 头注）；解析不了仍拒——静默当成不限制才是坑。
  parseMemBytes(backend.mem)

  // health 是**宿主后端**拿去拼 URL、每秒发一次 GET 的那个串。判据在 health-path.ts
  // （provisioner / standby 名册 / 状态页三处共用同一个归一化函数），这里只做安装期的拒绝。
  if (backend.health !== undefined) {
    const problem = healthPathProblem(backend.health)
    if (problem) {
      reject(
        pkgId,
        `backend.health ${problem}`,
        '探活 URL 由宿主后端拼出来（host 档是 http://127.0.0.1:<随机口> + 这个串），' +
          "一个 '@evil.com/' 或 '//evil.com/' 会把 host 换成别人的地址——那就是让 Stream 替你发出站请求",
        "写成本机绝对路径，如 health: '/healthz'。",
      )
    }
  }

  const standby = backend.standby
  if (standby) {
    // 这个数就是开机时长（见 THIRD_PARTY_LIMITS.maxStartTimeoutSeconds）。
    if (standby.startTimeoutSeconds !== undefined && standby.startTimeoutSeconds > THIRD_PARTY_LIMITS.maxStartTimeoutSeconds) {
      reject(
        pkgId,
        `backend.standby.startTimeoutSeconds ${standby.startTimeoutSeconds} 超过上限`,
        `容器备齐是启动时 await 的串行循环，这个数就是"一个永远不健康的容器能把开机卡多久"，最多 ${THIRD_PARTY_LIMITS.maxStartTimeoutSeconds}s`,
        `改到 ${THIRD_PARTY_LIMITS.maxStartTimeoutSeconds} 以内；镜像冷启真的更久，就把慢的那部分挪到容器起来之后做。`,
      )
    }
    if (standby.idleMinutes > THIRD_PARTY_LIMITS.maxIdleMinutes) {
      reject(
        pkgId,
        `backend.standby.idleMinutes ${standby.idleMinutes} 超过上限`,
        `超过 ${THIRD_PARTY_LIMITS.maxIdleMinutes} 分钟（${THIRD_PARTY_LIMITS.maxIdleMinutes / 60}h）不回收等于声明常驻，而常驻正是 standby 要治的东西`,
        `改到 ${THIRD_PARTY_LIMITS.maxIdleMinutes} 以内（不写这一格宿主兜 ${DEFAULT_STANDBY_IDLE_MINUTES} 分钟）。`,
      )
    }
  }

  const env = backend.env
  if (env) {
    const keys = Object.keys(env)
    if (keys.length > THIRD_PARTY_LIMITS.maxEnvEntries) {
      reject(
        pkgId,
        `backend.env 有 ${keys.length} 条，超过上限 ${THIRD_PARTY_LIMITS.maxEnvEntries}`,
        'env 是原样进容器的，条数不设限等于给了一个无界的注入面',
        `精简到 ${THIRD_PARTY_LIMITS.maxEnvEntries} 条以内。`,
      )
    }
    for (const k of keys) {
      if (k.startsWith(RESERVED_ENV_PREFIX)) {
        reject(
          pkgId,
          `backend.env 用了保留名 '${k}'`,
          `${RESERVED_ENV_PREFIX}* 是宿主往容器里注入用的命名空间，包塞同名值会顶掉宿主注入的那个`,
          '换一个自己的名字。要用登录态就申报 stream.credentials，由宿主随请求递给你——容器不自己去要。',
        )
      }
      const v = env[k] ?? ''
      if (v.length > THIRD_PARTY_LIMITS.maxEnvValueLength) {
        reject(
          pkgId,
          `backend.env['${k}'] 长 ${v.length}，超过上限 ${THIRD_PARTY_LIMITS.maxEnvValueLength}`,
          'env 值是原样进容器的，超长值多半是把配置文件/密钥整个塞了进来',
          '改成挂一个命名卷或让容器自己去取。',
        )
      }
    }
  }

  let volumes: string[] | undefined
  if (backend.volumes) {
    if (backend.volumes.length > THIRD_PARTY_LIMITS.maxVolumes) {
      reject(
        pkgId,
        `backend.volumes 有 ${backend.volumes.length} 个，超过上限 ${THIRD_PARTY_LIMITS.maxVolumes}`,
        '每个卷都是一份宿主上长期占地的存储',
        `合并到 ${THIRD_PARTY_LIMITS.maxVolumes} 个以内。`,
      )
    }
    volumes = backend.volumes.map((mount) => {
      if (isHostBindMount(mount)) {
        reject(
          pkgId,
          `backend.volumes 里的 '${mount}' 是宿主路径 bind`,
          '那会把宿主文件系统交给容器',
          '只接受命名卷 name:/path（卷名由宿主加包前缀，各包互不相通）。',
        )
      }
      const target = mount.slice((mount.split(':')[0] ?? '').length + 1)
      if (!target.startsWith('/')) {
        reject(
          pkgId,
          `backend.volumes 里的 '${mount}' 不是 name:/path 形状`,
          '挂载点必须是容器内的绝对路径',
          "写成 name:/path，如 'cache:/var/cache'。",
        )
      }
      const out = prefixedVolume(pkgId, mount)
      // 加了前缀反而变成 bind，说明包 id 本身不是合法卷名（含 '/'、以 '.' 开头之类）。
      // 不许它静默造出一个 bind——同一条判据在这里再走一遍。
      if (isHostBindMount(out)) {
        reject(
          pkgId,
          `包 id '${pkgId}' 不能用作卷名前缀（加前缀后得到 '${out}'，那是宿主路径 bind）`,
          '卷名只能是裸名字（不含路径分隔符、不以 . 或 $ 开头）',
          '换一个只含字母数字和 - _ 的包 id。',
        )
      }
      return out
    })
  }

  const out: PluginBackend = {
    ...backend,
    service: assignedServiceName(pkgId),
    // 没声明就兜一个（见 DEFAULT_STANDBY_IDLE_MINUTES）。补在**钳制后的声明**里而不是运行时
    // 现补：落盘的、preview 展示的、provisioner 读到的必须是同一份字节。
    standby: backend.standby ?? { idleMinutes: DEFAULT_STANDBY_IDLE_MINUTES },
  }
  if (volumes) out.volumes = volumes
  return out
}

/**
 * 给人看的容器摘要——安装确认页据此展示"这个包会跑一个什么容器"。
 *
 * **env 只给键名，值不外泄**：值可能是包作者塞进去的 token/密码，确认页是要给人截图分享的。
 *
 * 只接受 `clampThirdPartyBackend` 的**返回值**：service / mem / standby 三格是钳制补齐的，
 * 拿原始声明进来会得到一份与落盘不一致的摘要（正是 P4 那次 Critical 的形状），所以宁可抛。
 *
 * `gpu` 只在声明了 `gpu: true` 时出现（如 mineru / voiceprint）：用户确认的是「这个容器要占我的显卡，
 * 且没装 nvidia toolkit 就起不来」，这一格必须在确认页上；没声明就缺席而不是 false。
 */
export interface BackendSummary {
  image: string
  service: string
  port: number
  mem: string
  volumes: string[]
  envKeys: string[]
  standby: { idleMinutes: number; startTimeoutSeconds?: number }
  gpu?: true
}

export function summarizeBackend(clamped: PluginBackend): BackendSummary {
  if (!clamped.service || !clamped.mem || !clamped.standby) {
    throw new Error(
      'summarizeBackend 只接受 clampThirdPartyBackend 的返回值（service / mem / standby 由钳制补齐）',
    )
  }
  return {
    image: clamped.image,
    service: clamped.service,
    port: clamped.port,
    mem: clamped.mem,
    volumes: clamped.volumes ?? [],
    envKeys: Object.keys(clamped.env ?? {}),
    standby: clamped.standby,
    ...(clamped.gpu === true ? { gpu: true as const } : {}),
  }
}
