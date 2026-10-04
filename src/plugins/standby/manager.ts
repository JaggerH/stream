import type { DockerClient } from './docker-api.ts'
import { StandbyWakeTimeoutError } from './wake-error.ts'

export type StandbyState = 'asleep' | 'starting' | 'awake' | 'stopping'
export interface StandbyEntry { service: string; state: StandbyState; lastUsed: number | null; lastWakeMs: number | null }
export interface StandbyServiceSpec {
  service: string
  idleMinutes: number
  startTimeoutSeconds: number
  /** compose 档:静态 healthUrl(容器 DNS,构造期可知)。host 档不给。 */
  healthUrl?: string
  /** host 档:容器内口 + health 路径。唤醒后 inspect 出宿主口再拼 healthUrl(随机口
   *  start 前不存在,只能延迟构造)。两字段恰好一个存在——planStandbyServices 保证。 */
  hostProbe?: { containerPort: number; healthPath: string }
  /** 额外的查名别名(典型来源:插件 id 与 backend.service 不同时的那个 id)。指向**同一个 Cell**,
   *  不是第二个 cell —— 一个容器只有一份状态和一份引用计数。见 service-list.ts 的 MINOR F 注释。 */
  aliases?: string[]
}

/** 一次**只读对质**的结果：缓存怎么说 + Docker 本人怎么说，并排摆着。
 *  `cachedOrigin`（cell 缓存）与 `hostPort`（现场 inspect）不一致 = 缓存陈旧；
 *  `container: 'running'` 而 `state: 'asleep'` = standby 不知道容器已经在跑了。
 *  两个数分家的那一刻正是 `pluginTarget` 答空的那一刻——所以它们必须来自同一次采样。 */
export interface StandbyDiagnosis {
  service: string
  /** 名册里有没有它（含别名命中）。false = 这个 service 根本不归 standby 管。 */
  managed: boolean
  /** cell 状态；不在名册 → null。 */
  state: StandbyState | null
  /** cell 缓存的 loopback origin —— 本来该由 `pluginTarget` 答出来的那个数；无 → null。 */
  cachedOrigin: string | null
  /** Docker 本人说的容器现状。`unknown` = 问不到（原因在 `note`）。 */
  container: 'running' | 'stopped' | 'absent' | 'unknown'
  containerId: string | null
  /** 现场 inspect 出来的宿主口；容器没在跑 / spec 没有 hostProbe → null（原因在 `note`）。 */
  hostPort: number | null
  /** 上面几项取不到时的原因原文。"为什么取不到"本身就是要记的字段。 */
  note?: string
}

export interface StandbyManagerDeps {
  docker: DockerClient
  services: StandbyServiceSpec[]
  now?: () => number
  /** GET healthUrl,2xx=true。注入以便单测;默认 fetch + 短超时。 */
  probeHealth?: (url: string) => Promise<boolean>
  /** health 轮询间隔 ms(默认 1000;测试给 1) */
  pollMs?: number
  log?: (msg: string) => void
}

export interface StandbyManager {
  /** 咽喉调用:非 standby 服务 no-op;asleep→start+等 health;starting→共享同一 in-flight;
   *  stopping→等 stop 完再 start。成功即刷新 lastUsed。唤醒超时抛 StandbyWakeTimeoutError
   *  (retryable:true,cell 落回 asleep 可再唤醒)——直调方(如 HTTP 端点)据此回 502,但**转写
   *  任务层不判死,而是延迟重排整条阶梯**(容器届时已装完权重),见 wake-error.ts 与
   *  docs/superpowers/specs/2026-07-24-standby-wake-timeout-retryable-design.md。
   *  只保证"进入时"容器是醒的 —— 长请求请用 withAwake,否则会被 reaper 中途停掉。 */
  ensureAwake(service: string): Promise<void>
  /** 首选形式:唤醒 + 在 fn 执行期间持有一个 in-flight 引用,reaper 绝不停有引用的 cell。
   *  释放写在 finally 里、绑在调用方自己的 promise 上 —— 调用方没法"忘记释放"。 */
  withAwake<T>(service: string, fn: () => Promise<T>): Promise<T>
  /** 启动收养:running 容器→awake(lastUsed=now),孤儿自然被 reaper 回收(spec「生命周期边界」)。 */
  adopt(): Promise<void>
  /** reaper 一步:awake 且闲置超 idleMinutes 且无 in-flight 引用 → stop。由调度中心定时驱动。
   *  永不 reject(周期调用者若不捕获 rejection 会带走整个进程)。 */
  tick(): Promise<void>
  /** SIGTERM:等掉在飞的 start/stop,再 best-effort stop 全部 awake;之后管理器进入终态。 */
  shutdown(): Promise<void>
  snapshot(): StandbyEntry[]
  /** host 档:醒着时返回缓存的 loopback origin(http://127.0.0.1:<口>),其余一律 null。
   *  缓存只是 Docker 状态的影子:Cell 离开 awake 即清空(不变量),没有 TTL、没有刷新任务。 */
  origin(service: string): string | null
  /** 这个 service(或它的别名)有没有被 standby 管着 —— 问的是"管不管得着",不是
   *  "现在醒着吗"。给 readiness 判断用:一个能力"可用"不该看它此刻是否醒着(host 档下
   *  睡着是常态,唤醒是 withAwake 的活),而该看它是不是被这套机制接管、真调用时会不会
   *  被唤醒。未接线/没有对应 Cell → false。 */
  managed(service: string): boolean
  /** 诊断用的**只读对质**：拿 cell 的缓存状态 + 直接问 Docker「容器在不在、宿主口是多少」。
   *  **不唤醒、不改任何 cell 状态**——它只被观测路径调用（`pluginTarget` 答空时的现场记录，
   *  spec 2026-08-19-plugin-target-empty-observability）。名册里没有的 service 也照答：
   *  「名单漏了它」和「容器没建」是两种病，必须分得开。Docker 抛 → `container:'unknown'`
   *  + 错误原文进 `note`，**绝不抛给调用方**（观测不能反过来打死主链路）。 */
  diagnose(service: string): Promise<StandbyDiagnosis>
}

interface Cell {
  spec: StandbyServiceSpec
  state: StandbyState
  lastUsed: number | null
  lastWakeMs: number | null
  inflight: Promise<void> | null // starting 或 stopping 的进行中操作
  inUse: number // withAwake 持有的引用计数;>0 表示有请求正压在这个容器上
  origin: string | null // host 档:inspect 出的 loopback origin。compose 档恒 null。
}

const defaultProbe = async (url: string): Promise<boolean> => {
  try { return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok } catch { return false }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 恢复只认 TCP 连接层三兄弟(spec:实测 stop 过渡期序列 200→RST→挂起~2s→稳定秒拒)。
 *  undici 把网络错包在 fetch failed 的 cause 链里,逐层剥。慢响应/HTTP 5xx 不在此列——
 *  那是容器活着但不舒服,重启治不了还雪上加霜。 */
const CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'])
// 深度上限:真实 cause 链顶多两三层(undici fetch failed → 系统错误)。8 层绰绰有余,
// 只为挡住 e.cause === e(或更长的环)这类畸形错误——没有它,for 循环永不终止,
// 请求死挂、withAwake 的 inUse 引用永远压着这个容器不放。
const MAX_CAUSE_DEPTH = 8
function isConnectFailure(e: unknown): boolean {
  let cur = e
  for (let depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth += 1, cur = (cur as { cause?: unknown }).cause) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && CONNECT_FAILURE_CODES.has(code)) return true
  }
  return false
}

export function makeStandbyManager(deps: StandbyManagerDeps): StandbyManager {
  const now = deps.now ?? Date.now
  const probe = deps.probeHealth ?? defaultProbe
  const pollMs = deps.pollMs ?? 1000
  const log = deps.log ?? ((m: string) => console.log(`[standby] ${m}`))
  // 重名 service(含别名撞名)会在 Map 里静默相互覆盖(后者胜),两份配置只有一份生效、另一份的
  // idleMinutes 等参数凭空消失且毫无迹象 —— 宁可开机就炸。调用方(serve.ts)负责把这一炸降级成
  // "standby inert",不让它掀翻整个后端启动。
  const names = deps.services.flatMap((s) => [s.service, ...(s.aliases ?? [])])
  const dupes = names.filter((s, i, a) => a.indexOf(s) !== i)
  if (dupes.length > 0) throw new Error(`standby: duplicate service names in config: ${[...new Set(dupes)].join(', ')}`)
  // cellList 是唯一的遍历真相(adopt/tick/shutdown/snapshot 都走它),cells 只是**查名索引**:
  // 同一个 Cell 可以挂在 service 名和若干别名下,遍历时绝不会因此重复出现。
  const cellList: Cell[] = deps.services.map((s) => ({ spec: s, state: 'asleep', lastUsed: null, lastWakeMs: null, inflight: null, inUse: 0, origin: null }))
  const cells = new Map<string, Cell>()
  for (const cell of cellList) {
    cells.set(cell.spec.service, cell)
    for (const alias of cell.spec.aliases ?? []) cells.set(alias, cell)
  }
  let shuttingDown = false

  async function containerIdOf(service: string): Promise<string | null> {
    const list = await deps.docker.listByService(service)
    if (list.length === 0) return null
    // running 优先;多个残留取第一个(docker 返回按创建时间新→旧)
    return (list.find((c) => c.State === 'running') ?? list[0]).Id
  }

  async function wake(cell: Cell): Promise<void> {
    const t0 = now()
    try {
      const id = await containerIdOf(cell.spec.service)
      if (!id) throw new Error(`standby: no container for ${cell.spec.service} — run \`pnpm plugins compose\` + \`docker compose up -d\` first`)
      await deps.docker.start(id)
      let probeUrl = cell.spec.healthUrl
      if (cell.spec.hostProbe) {
        const port = await deps.docker.inspectHostPort(id, cell.spec.hostProbe.containerPort)
        if (!port)
          throw new Error(
            `standby: no host port mapping for ${cell.spec.service} — regenerate docker-compose.yml (pnpm plugins compose) so backends publish 127.0.0.1:: loopback ports`,
          )
        cell.origin = `http://127.0.0.1:${port}`
        probeUrl = `${cell.origin}${cell.spec.hostProbe.healthPath}`
      }
      if (!probeUrl) throw new Error(`standby: spec for ${cell.spec.service} has neither healthUrl nor hostProbe`)
      const deadline = t0 + cell.spec.startTimeoutSeconds * 1000
      while (now() < deadline) {
        if (await probe(probeUrl)) {
          const t = now() // 只读一次表:lastWakeMs 和 lastUsed 必须来自同一时刻,否则两者互相矛盾
          cell.state = 'awake'
          cell.lastWakeMs = t - t0
          cell.lastUsed = t
          log(`${cell.spec.service} awake in ${cell.lastWakeMs}ms`)
          return
        }
        await sleep(pollMs)
      }
      // 可重试而非终态:容器多半没死,还在装权重,下次唤醒就绿(catch 已把 cell 落回 asleep)。
      // 上层(转写任务层)据 isRetryable 决定延迟重排,而不是把整个任务判死。message 与旧抛法一致。
      throw new StandbyWakeTimeoutError(cell.spec.service, cell.spec.startTimeoutSeconds)
    } catch (e) {
      // 任何失败出口(找不到容器 / docker.start 抛 / 探活抛 / 超时)都必须落回 asleep:
      // 卡在 starting 的 cell 既会被状态端点永远报成"启动中",又会被 tick 跳过(只收 awake),
      // 等于永久泄漏一个没人管的容器。
      cell.state = 'asleep'
      cell.origin = null
      throw e
    }
  }

  /** 僵尸口对质:缓存只是 Docker 状态的影子,连接层失败 → 回 Docker 本人处对表。
   *  返回 true = 状态已修复(新口/重唤醒),调用方可重试一次;false = 对表后一切如旧,
   *  重试同一个死法没有意义,原错误该原样上抛。 */
  async function reconcileDeadPort(cell: Cell): Promise<boolean> {
    const list = await deps.docker.listByService(cell.spec.service)
    const running = list.find((c) => c.State === 'running')
    if (!running) {
      // 容器真死了:打回 asleep 走正常冷启动。并发者在 ensureAwake 里共享同一个 starting/inflight——
      // 但若在我们等 listByService 期间,另一个并发的对质已经先一步把 cell 推进 starting,这里
      // 就不能再无脑盖回 asleep(会撞飞它的 inflight、多打一次 start),直接搭它的车即可。
      if (cell.state === 'starting' && cell.inflight) { await cell.inflight; return true }
      cell.state = 'asleep'
      cell.origin = null
      await m.ensureAwake(cell.spec.service)
      return true
    }
    if (cell.spec.hostProbe) {
      const port = await deps.docker.inspectHostPort(running.Id, cell.spec.hostProbe.containerPort)
      const next = port ? `http://127.0.0.1:${port}` : null
      if (next && next !== cell.origin) { cell.origin = next; return true }
    }
    return false
  }

  const m: StandbyManager = {
    async ensureAwake(service) {
      const cell = cells.get(service)
      if (!cell) return
      // shutdown 之后不再拉起任何容器。选择"静默 no-op"而非 reject:SIGTERM 抽干期间
      // 仍在跑的请求会再撞到这个咽喉,reject 会把一个本来能正常收尾的请求直接打死;
      // 容器此刻多半还活着,让它继续跑完是更安全的一侧。
      if (shuttingDown) return
      if (cell.state === 'stopping' && cell.inflight) await cell.inflight.catch(() => {})
      // 上面这次 await 期间 shutdown() 可能已经跑完并置位 shuttingDown ——
      // 一个原本停在 stopping 上等待的调用方恢复过来看到的是 asleep,不再查一次
      // 就会把 shutdown 已经收干净的容器重新拉起,留下一个没有 reaper 收它的孤儿。
      if (shuttingDown) return
      if (cell.state === 'awake') { cell.lastUsed = now(); return }
      if (cell.state === 'starting' && cell.inflight) { await cell.inflight; cell.lastUsed = now(); return }
      // 提交 start 前最后一道闸。**今天它是不可达的**:从上面那次 `if (shuttingDown) return`
      // 到这里没有任何 await,shuttingDown 不可能在这中间翻转。留着它是为了**将来**——上面几行
      // 里任何一次新增的 await(比如给 awake 分支加个探活)都会立刻造出一个"检查完又睡了一觉"
      // 的窗口,而这道闸就守在提交点上。别把这行的注释写成"它在守一个现存的窗口"(那是假话)。
      if (shuttingDown) return
      cell.state = 'starting'
      cell.inflight = wake(cell).finally(() => { cell.inflight = null })
      await cell.inflight
    },
    async withAwake(service, fn) {
      const cell = cells.get(service)
      if (!cell) return fn()
      // 引用计数在 ensureAwake 之前就顶上,不等它成功返回才加 —— ensureAwake 的
      // shuttingDown 提前返回那条路径不会盖 lastUsed;若计数等到 ensureAwake 之后
      // 才加,fn 执行期间会有一段窗口里这个 cell 既没有新鲜时间戳、也没有引用计数,
      // 对 reaper 看起来就是可以收的。减量放在最外层 finally,保证 ensureAwake 抛 /
      // fn 抛 / 正常返回三条路径都不会泄漏引用。
      cell.inUse += 1
      try {
        await m.ensureAwake(service)
        // fn() 开跑前记一次 origin 快照:catch 里要用它跟"对质前"的 cell.origin 比,
        // 判断这次连接层失败发生期间,是不是已经有别的并发调用把口刷新过了。
        const originBefore = cell.origin
        try {
          return await fn()
        } catch (e) {
          // 恢复恰好一层:重试里再炸原样上抛(fn 的第二次调用不在 try 里)。
          if (shuttingDown || !isConnectFailure(e)) throw e
          if (cell.origin !== originBefore) {
            // 别的并发调用已经在我们等 fn() 失败期间跑完了恢复(晚到对质):口已经刷新,
            // 状态早就是对的。这时候再去 reconcileDeadPort 对质,反而会因为"口(相对当前
            // 缓存)没变"或撞见一个已经 awake 的 cell 而误判 —— 直接搭那趟恢复的车重试一次。
            return await fn()
          }
          if (!(await reconcileDeadPort(cell))) throw e
          return await fn()
        }
      } finally {
        // 请求跑完才重新盖时间戳 —— 闲置窗口该从"用完"算起,不是从"开始用"算起。
        cell.inUse -= 1
        cell.lastUsed = now()
      }
    },
    async adopt() {
      for (const cell of cellList) {
        try {
          const list = await deps.docker.listByService(cell.spec.service)
          const running = list.find((c) => c.State === 'running')
          if (running) {
            // host 档:inspect 不出口就不能收养成 awake —— 那样会造出一个哑状态(对外报 awake、
            // origin 恒 null),ensureAwake 见 awake 直接短路,再也不会重新 inspect,也再不会浮出
            // wake() 里那条指向"重新生成 docker-compose.yml"的可行动错误,只能干等 reaper 按
            // idleMinutes 自愈。真实触发场景:用户拿着没发布 loopback 口的旧 compose 升级上来。
            // 保持 asleep,下一次真实使用会走 wake(),立刻抛出明确错误。
            if (cell.spec.hostProbe) {
              const port = await deps.docker.inspectHostPort(running.Id, cell.spec.hostProbe.containerPort)
              if (!port) { log(`adopt ${cell.spec.service}: running but no host port mapping, leaving asleep`); continue }
              cell.origin = `http://127.0.0.1:${port}`
            }
            cell.state = 'awake'
            cell.lastUsed = now()
          }
        } catch (e) { log(`adopt ${cell.spec.service} failed: ${String(e)}`) }
      }
    },
    async tick() {
      for (const cell of cellList) {
        // 一个服务停失败不能连累后面的服务 —— 没有这层隔离,Map 里排在它后面的全都收不掉,
        // 而且 tick() 的 rejection 在周期调用者眼里是 unhandled,默认会终结进程。
        try {
          if (cell.state !== 'awake' || cell.lastUsed === null) continue
          if (cell.inUse > 0) continue // 有请求正压着(ASR 单次转写可以远超 10 分钟),再闲也不能停
          if (now() - cell.lastUsed <= cell.spec.idleMinutes * 60_000) continue
          cell.state = 'stopping'
          cell.inflight = (async () => {
            try {
              const id = await containerIdOf(cell.spec.service)
              if (id) await deps.docker.stop(id)
              cell.state = 'asleep'
              cell.origin = null
            } catch (e) {
              // 停失败 = 容器八成还在跑。标 asleep 会让它彻底脱离 reaper 视野(tick 只看 awake),
              // 所以退回 awake,下一轮重试。
              cell.state = 'awake'
              throw e
            } finally { cell.inflight = null }
          })()
          await cell.inflight
          // 成功日志必须在**停止那段 try 之外**:默认 sink 是 console.log,它会 EPIPE(stdout
          // 被关掉/管道断了)。日志留在里面时,一次写日志失败会掉进那个 catch,把已经真的停掉的
          // 容器的状态回滚成 awake —— 一行日志把一次成功的停止改写成了失败。这里再单独吞一次:
          // tick() 承诺"永不 reject",也不该因为日志失败去走下面那条 "stop failed" 的路。
          try { log(`${cell.spec.service} idle-stopped`) } catch { /* 日志失败不改任何状态 */ }
        } catch (e) {
          // log 本身也可能抛(比如注入的 sink 写崩了) —— tick() 的文档承诺"永不 reject",
          // 一个失败的日志调用不能推翻这个承诺、把整个周期循环带走。
          try { log(`tick stop ${cell.spec.service} failed: ${String(e)}`) } catch { /* 日志失败本身也吞掉 */ }
        }
      }
    },
    async shutdown() {
      // 先立终态旗:抽干期间到达的 ensureAwake 不能再把容器拉起来。
      shuttingDown = true
      for (const cell of cellList) {
        try {
          // 在飞的 start/stop 必须等掉再决定停什么:一个正处于 starting 的 cell 若被跳过,
          // 它的 wake 会在 shutdown 之后完成,进程退出时容器还开着、且再没有 reaper 收它。
          if (cell.inflight) await cell.inflight.catch(() => {})
          if (cell.state !== 'awake') continue
          const id = await containerIdOf(cell.spec.service)
          if (id) await deps.docker.stop(id)
          cell.state = 'asleep'
          cell.origin = null
        } catch (e) { log(`shutdown stop ${cell.spec.service} failed: ${String(e)}`) }
      }
    },
    snapshot() {
      return cellList.map((c) => ({ service: c.spec.service, state: c.state, lastUsed: c.lastUsed, lastWakeMs: c.lastWakeMs }))
    },
    origin(service) {
      const cell = cells.get(service)
      return cell && cell.state === 'awake' ? cell.origin : null
    },
    managed(service) {
      return cells.has(service)
    },
    async diagnose(service) {
      const cell = cells.get(service)
      const cached = {
        service,
        managed: cell !== undefined,
        state: cell?.state ?? null,
        cachedOrigin: cell?.origin ?? null,
      }
      try {
        // 名册里没有它时按传入名去问 Docker —— 那正是「名单漏了它，但容器其实建起来了」那一格。
        const list = await deps.docker.listByService(cell?.spec.service ?? service)
        const running = list.find((c) => c.State === 'running')
        const found = running ?? list[0] ?? null
        const container = found ? (running ? 'running' : 'stopped') : 'absent'
        let hostPort: number | null = null
        let note: string | undefined
        if (!cell?.spec.hostProbe) {
          note = 'spec has no hostProbe (compose-mode target, or not a host-door service)'
        } else if (running) {
          hostPort = await deps.docker.inspectHostPort(running.Id, cell.spec.hostProbe.containerPort)
          if (hostPort === null) note = 'container running but no 127.0.0.1 port mapping published'
        } else {
          note = 'container not running — no host port exists yet'
        }
        return { ...cached, container, containerId: found?.Id ?? null, hostPort, note }
      } catch (e) {
        // Docker 够不着**也是一条现场**（"取不到"和"取到了但是空"必须分开），照样答，不抛。
        return { ...cached, container: 'unknown', containerId: null, hostPort: null, note: `docker: ${String(e)}` }
      }
    },
  }
  return m
}
