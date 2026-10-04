/**
 * Provisioner —— 「确保这个包的 backend 有一个健康容器在跑」。
 *
 * 今天容器靠开发者手跑 `pnpm plugins compose > docker-compose.yml && docker compose up -d`；
 * 发行版用户没有仓库、也没有 compose CLI。这个模块让**后端自己**按包描述符把容器建起来，
 * 而且建出来的容器带着 standby 认得的 label（`createContainer` 负责打标），所以两条路
 * （compose 生成 / 运行时接管）产出的容器对 standby 来说长得一模一样。
 *
 * ## 谁管「转不转」—— 这里只管「有没有」
 *
 * 同一批容器有两个机制在碰，分工必须划清，否则它们会互相拆台：
 *
 * - **本模块管「有没有」**：这台机器上到底有没有这个容器？没有就拉镜像、建一个、接上网、
 *   把凭证塞进去。建完它的活就干完了。开机跑一次。
 * - **standby 管「转不转」**（`./standby/`）：这个容器**现在**该不该转？有请求就唤醒，
 *   闲够 `idleMinutes` 就熄火。一直在跑。
 *
 * 所以**一个已存在的容器停着，本模块不许去起它**——那个「停着」不是故障，是 standby 刚做出的
 * 正确决定。起了就是两个主人抢同一件事：后端每重启一次就把全部睡着的容器叫醒一遍（开发期
 * 每存一次文件就重启），standby 省内存那件事整个作废。这条路的返回值是 `'asleep'`，零写操作。
 *
 * 例外只有一个：**包没声明 `backend.standby`** = 没人负责唤醒它（`withAwake` 认不出它），
 * 那它就得一直转着，这时才由本模块把它起来（`'started'`）。判据就是 `backend.standby` 在不在，
 * 与 `PluginBackend.standby` 的既定语义（absent = 常驻）同一把尺。
 *
 * 三条不变量：
 * 1. **绝不 throw** —— 它在 bootstrap 里被调用，抛一下就是整个 Stream 起不来；
 *    「某个插件容器没起来」永远不该有这个后果。失败一律进 `error` 字段。
 * 2. **幂等** —— 已有健康容器就一次 list + 一次 inspect，零写操作。每次启动都跑，不幂等
 *    就是每次启动都折腾一遍容器。
 * 3. **健康等待超时不回滚删容器** —— 容器还在，`docker logs` 才有得看。删掉等于把唯一的
 *    现场也毁了。
 */
import type { DockerClient, ContainerSpec } from './standby/docker-api.ts'
import { normalizeHealthPath } from './health-path.ts'
import type { PluginDescriptor } from './types.ts'

export interface ProvisionResult {
  service: string
  /** 'ran' = 本来就在跑；'asleep' = 在，但停着，且归 standby 管 —— 什么都没动（见头注）；
   *  'started' = 停着，起了（只有**不归 standby 管**的常驻容器会走到这）；'created' = 新建并起了；
   *  'recreated' = 镜像与声明不一致，删了重建（只在 `recreateOnImageMismatch` 打开时可能出现）；
   *  'image-mismatch' = 镜像与声明不一致但**什么都没动**（默认口径，见下）；
   *  'skipped' = 没什么可做（docker 不可用 / 这个包没有 backend）。
   *  带 `error` 时 action 表示「走到哪一步失败的」。 */
  action: 'ran' | 'asleep' | 'started' | 'created' | 'recreated' | 'image-mismatch' | 'skipped'
  containerId?: string
  error?: Error
}

export interface ProvisionOptions {
  /** 容器加入的网络（与 compose 生成器的 `stream` 同一个） */
  network: string
  /** host 档：额外发布一个 127.0.0.1 随机宿主口，探活也走它 */
  publishLoopback: boolean
  /** 起来之后等健康的上限，默认 60s */
  healthTimeoutMs?: number
  /** GET url，2xx = true。注入以便单测；默认 fetch + 3s 超时。 */
  probeHealth?: (url: string) => Promise<boolean>
  /** 轮询间隔 ms（默认 1000；测试给 0） */
  pollMs?: number
  now?: () => number
  /**
   * 容器在、但它当前跑的镜像与声明对不上时，是否**删了重建**。
   *
   * **本函数的默认是 false**（只报 `'image-mismatch'`、零写操作），因为"要不要动用户的容器"
   * 是调用方的立场，不该由这一层替它拍。**接线层传的是 true**（`provision-wire.ts` 不变量 2）：
   * 带 backend 的包不许把状态留在容器层——要跨重启保留的一切都必须声明成 `volumes`
   * （见 `docs/PACKAGE.md` §4.1），所以删了重建没有可丢的东西，而卷不受影响
   * （remove 走的是 `DELETE /containers/<id>?force=true`，没有 `v=true`）。
   */
  recreateOnImageMismatch?: boolean
  /**
   * **第三方包专用**：建容器之前再断言一次声明里有 `mem`（内存上限）。缺了就拒绝创建，
   * 零 docker 写操作，理由进 `error` 由调用方说出去。
   *
   * 为什么运行时还要再判一次（钳制的真相源是 `src/packages/container-policy.ts`，安装期
   * 已经强制过这一格）：盘上的 `package.json` 是可以手改的——装完之后删掉 `mem` 那一行就
   * 绕过了安装期闸门，拿到一个**不限内存**的容器，能吃满宿主内存。这是纵深防御的那一层，
   * 和 `createContainer` 里对宿主 bind 的拒绝同一个立场。
   *
   * 内置包不带这个开关：它们的声明是我们自己写的，且历史上就有没写 `mem` 的（alist）。
   */
  requireMemLimit?: boolean
}

const defaultProbe = async (url: string): Promise<boolean> => {
  try { return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok } catch { return false }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 把一个包的 backend 声明变成容器规格。纯函数。
 *  `service` 缺省取 plugin id —— 必须与 compose 生成器（`generateCompose`：`p.backend.service ?? p.id`）
 *  算出同一个名字，否则 standby 按 label 找容器会找不到。
 *
 *  **不往 env 里注入任何凭证。** 容器不需要自己去要 cookie：宿主是唯一调度方，凭证由 adapter
 *  随请求递下去（撤销缘由见 `src/http/app.ts` 里 credential broker 那段说明）。 */
export function specFor(
  plugin: PluginDescriptor,
  network: string,
  publishLoopback: boolean,
): ContainerSpec {
  const b = plugin.backend
  if (!b) throw new Error(`plugin ${plugin.id} declares no backend — nothing to provision`)
  return {
    image: b.image,
    service: b.service ?? plugin.id,
    port: b.port,
    env: b.env,
    volumes: b.volumes,
    mem: b.mem,
    gpu: b.gpu,
    publishLoopback,
    network,
    // 条件铺而不是 `user: b.user`：ContainerSpec 的既有用例用 toEqual 钉着整份形状，
    // 一个 `user: undefined` 键会让"没声明"看起来像"声明了 undefined"。
    ...(b.user ? { user: b.user } : {}),
  }
}

/**
 * 确保这个包的 backend 有一个容器在跑。**绝不 throw**——失败进 `error` 字段由调用方决定怎么说。
 *
 * 判定顺序：
 * 1. `listByService(service)` 找容器（running 优先）。
 * 2. 有且 running、镜像与声明一致 → `'ran'`，什么都不做。
 * 3. 有但停着、镜像一致 → 归 standby 管（声明了 `backend.standby`）就 `'asleep'` 零写操作；
 *    不归 standby 管（常驻）才 `start` → `'started'`。见头注「谁管『转不转』」。
 * 4. 有但镜像与声明不一致（包升级换了 tag）→ `recreateOnImageMismatch: true`（接线层传的就是它）
 *    时 remove + 重建 → `'recreated'`；不传则 `'image-mismatch'`，零写操作。
 * 5. 没有 → `ensureNetwork` → `pullImage` → `createContainer` → `start` → `'created'`。
 * 6. 起来之后等健康：声明了 `health` 就轮询它直到 2xx；没声明就只等容器 running。
 *    超时 → `error`，容器留着。
 */
export async function provisionBackend(
  docker: DockerClient,
  plugin: PluginDescriptor,
  opts: ProvisionOptions,
): Promise<ProvisionResult> {
  // 没有 backend 的包（xhs/rsshub 这类进程内适配器）不该有容器，也不算失败。
  if (!plugin.backend) return { service: plugin.id, action: 'skipped' }
  const spec = specFor(plugin, opts.network, opts.publishLoopback)
  const service = spec.service
  // 第三方那道运行时闸门（见 requireMemLimit 的头注）。判在任何 docker 调用**之前**：
  // 一个不限内存的容器不该因为"已经建好了"就将错就错。
  if (opts.requireMemLimit && !plugin.backend.mem) {
    return {
      service,
      action: 'skipped',
      error: new Error(
        `包 '${plugin.id}' 的 backend 没有 mem（内存上限）—— 拒绝创建容器。` +
        '安装期这一格是强制的，会走到这里说明盘上的 package.json 在装完之后被改过。',
      ),
    }
  }
  // action 记「走到哪一步」：出错时它和 error 一起构成可读的失败现场（例如
  // action:'created' + error = 建起来了但没等到健康，去 docker logs 看那个容器）。
  let action: ProvisionResult['action'] = 'skipped'
  let containerId: string | undefined

  try {
    // docker 不可用（没装 / daemon 没跑 / socket 够不着）不是错误，是「这台机器上没有容器这条路」。
    if (!(await docker.ping())) return { service, action: 'skipped' }

    const list = await docker.listByService(service)
    // running 优先；多个残留取第一个（docker 返回按创建时间新→旧），与 standby 的挑法一致。
    const existing = list.find((c) => c.State === 'running') ?? list[0]
    // list 与 inspect 之间容器可能已被删（也可能 list 返回的是别人刚清掉的残影）——
    // inspect 回 null 就当「没有」走新建，别拿一个不存在的 id 去 start。
    const state = existing ? await docker.inspectState(existing.Id) : null

    if (existing && state && state.image === spec.image) {
      containerId = existing.Id
      if (state.running) return { service, action: 'ran', containerId }
      // 停着 + 归 standby 管 → **别动它**。见函数头注「谁管『转不转』」。
      // 提前返回而不是 fall through：容器没转，waitHealthy 会一路探到 healthTimeout 才罢休
      // （声明了 health 的更糟，那是每秒一发的出站请求），而它本来就不该转。
      if (plugin.backend.standby) return { service, action: 'asleep', containerId }
      action = 'started'
      await docker.start(containerId)
    } else {
      if (existing && state) {
        // 镜像与声明对不上（包升级换了 tag）。本函数默认只把这件事说出去、零写操作；
        // 要不要动用户的容器由调用方决定（接线层传 true —— 见该选项的头注）。
        if (!opts.recreateOnImageMismatch) {
          return { service, action: 'image-mismatch', containerId: existing.Id }
        }
        // 显式打开时才走重建。先删旧的：容器名 `stream-<service>` 被它占着，不删就 create 409。
        action = 'recreated'
        await docker.removeContainer(existing.Id)
      } else {
        action = 'created'
      }
      await docker.ensureNetwork(spec.network)
      await docker.pullImage(spec.image)
      containerId = await docker.createContainer(spec)
      await docker.start(containerId)
    }

    await waitHealthy(docker, containerId, spec, plugin.backend.health, opts)
    return { service, action, containerId }
  } catch (e) {
    // 单个插件容器起不来不该掀翻 bootstrap。**这里绝不回滚**：健康没等到时容器还在，
    // 用户能 `docker logs stream-<service>` 看到它为什么起不来。
    const error = e instanceof Error ? e : new Error(String(e))
    return { service, action, containerId, error }
  }
}

/** 起来之后等它真的可用：声明了 health 就轮询那个路径直到 2xx，没声明就只等容器 running。
 *  超时抛错（调用方转成 `error` 字段），**不删容器**。 */
async function waitHealthy(
  docker: DockerClient,
  id: string,
  spec: ContainerSpec,
  health: string | undefined,
  opts: ProvisionOptions,
): Promise<void> {
  const now = opts.now ?? Date.now
  const probe = opts.probeHealth ?? defaultProbe
  const pollMs = opts.pollMs ?? 1000
  const deadline = now() + (opts.healthTimeoutMs ?? 60_000)

  for (;;) {
    if (health) {
      const origin = await healthOrigin(docker, id, spec)
      // 探活 URL **不能用字符串拼**：`health: '@evil.com/'` 拼出
      // `http://127.0.0.1:34567@evil.com/`，按 URL 文法前半段是 userinfo、host 是 evil.com
      // ——宿主后端每秒替攻击者发一次出站 GET，一直发到 healthTimeout。安装期钳制已经拒了
      // 这类声明，这里是纵深（盘上的 package.json 手改得动）：先归一化成绝对路径
      // （同时塌掉 `//` 那种协议相对形），再交给 URL 解析。
      const url = origin ? new URL(normalizeHealthPath(health), origin).toString() : null
      // 探活函数自己抛（连接被拒是常态：容器刚起、端口还没听）= 「还没绿」，不是失败。
      if (url && await probe(url).catch(() => false)) return
    } else {
      // 没声明 health 就只能问 docker：容器进程还在不在。
      if ((await docker.inspectState(id))?.running) return
    }
    if (now() >= deadline) {
      throw new Error(
        `plugin backend ${spec.service} did not become healthy in time — container ${id} left running on purpose, check \`docker logs\``,
      )
    }
    await sleep(pollMs)
  }
}

/** 探活打哪儿：host 档打 inspect 出来的 loopback 随机口（那口是 start 时才分配的，
 *  所以只能起来之后才问）；compose 档打容器 DNS `http://<service>:<port>`。 */
async function healthOrigin(docker: DockerClient, id: string, spec: ContainerSpec): Promise<string | null> {
  if (!spec.publishLoopback) return `http://${spec.service}:${spec.port}`
  const port = await docker.inspectHostPort(id, spec.port)
  return port ? `http://127.0.0.1:${port}` : null
}
