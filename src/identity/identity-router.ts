/**
 * 按身份 / 环境选节点（browser-identity D7）。执行开始时解析一次，选出的节点决定设备与扩展绑定，整次执行不变。
 *
 * - 身份目标：候选 = 身份表里该 facility 下这个账号为 `signed-in` 的节点。
 * - 环境目标：候选 = 标了这个环境、且该 facility 为 `signed-in` 的节点。同一环境里登着两个号时取最近核对过的
 *   ——用户选的是环境、不是账号，这一层歧义是他接受的。
 * - 挑法：在线的优先，同为在线取最近核对过的。
 *
 * 候选都离线时按需唤起（D8）：其中有记下 profile 目录、且所在设备的 host agent 在线的，让 agent 用
 * `--no-startup-window` 静默加载那个 profile（spike S2：Linux 与 Windows 上都不开窗），至多等 30 秒让节点连上。
 * 同一个节点同一时刻只有一次唤起在飞，并发的执行共用它的结果。定时执行也唤起——不抢屏（S2 通过）。
 *
 * 唤起的 profile 用完要收回去（D8「收回的路：关掉它的最后一扇窗」）：`woken_at` 非空的节点在执行开始时按住
 * （扩展不让中途关掉最后一扇窗），同一节点上并发的执行全部结束后放掉——扩展关掉 Stream 自己的标签与窗，
 * profile 随最后一扇窗卸载；用户在那个 profile 里有自己的窗就只关我们的标签。两种情况 `woken_at` 都清空：
 * 前者 profile 没了，后者它是用户在用的 profile，不再是「Stream 在后台开着的」。放不掉（扩展断了、老扩展）
 * 就留着 `woken_at`，面板照样列出它。
 *
 * 派发任何动作前在选定的节点上核对一次身份（D9），除非身份表里那一行够新：采集 10 分钟、任务中心的动作 60 秒
 * （动作可能对外，宁可多开一个标签）。核对出另一个账号 → `identity-mismatch`；已登出 → `identity-signed-out`；
 * 问不出来（`unknown`）→ `identity-offline`。没有 `whoami` / `login` 形状的 facility 不核对。
 *
 * **没有回落分支。** 候选为空、都离线且唤不起——这里只会抛 `IdentityOffline`。不读设备默认、不回 `local`、不换成
 * 同一节点上别的账号。读这个文件的人如果想加一个「实在不行就……」，那正是这套设计要防的事。
 */
import { IdentityMismatch, IdentityOffline, IdentitySignedOut } from '../devices/errors.ts'
import type { RunIdentity } from '../devices/run-context.ts'
import { describeTarget, type Target } from '../devices/target.ts'
import type { SiteIdentity } from './identity-store.ts'
import type { ProbeResult } from './whoami.ts'
import type { EventInput } from '../events/store.ts'

/** 执行的用途：决定执行前核对的新鲜度窗口（D9）。采集 10 分钟，任务中心的动作 60 秒。 */
export type RunPurpose = 'harvest' | 'action'

export type IdentityTarget = Exclude<Target, { kind: 'device' }>

/** 路由要知道的节点信息（`NodeStore` 的行满足它）。 */
export interface RouterNode {
  nodeId: string
  deviceId: string
  bindingId: string
  profileDir?: string
  profileName?: string
  label?: string
  environment?: string
  wokenAt?: number
}

/** 身份表的记录多新可以免核对（D9）。 */
export const FRESH_MS: Record<RunPurpose, number> = { harvest: 10 * 60_000, action: 60_000 }

/** 一台设备上的 host agent（`agentFrom` 的结果满足它）。 */
export interface WakeAgent {
  ops: ReadonlySet<string>
  send(op: { op: string; args?: Record<string, unknown> }): Promise<unknown>
}

export interface IdentityRouterDeps {
  /** 该 facility 在身份表里的全部行（现读：探测随时在写）。 */
  identities(facility: string): SiteIdentity[]
  node(nodeId: string): RouterNode | undefined
  isOnline(bindingId: string): boolean
  /** 设备上在线的 host agent；不在线 = undefined（唤不起）。 */
  agent?(deviceId: string): WakeAgent | undefined
  /** 这台设备上拉起浏览器用哪个可执行文件（本机：采集浏览器的配置）。缺席 = agent 自己找 Chrome。 */
  launchBase?(deviceId: string): { exe?: string; process?: string }
  /** 等这条绑定连上，至多 `ms`。缺席 = 每 250ms 看一眼 `isOnline`。 */
  waitOnline?(bindingId: string, ms: number): Promise<boolean>
  /** 记下 / 清掉「这个 profile 是 Stream 唤起的」（`NodeStore.setWokenAt`）。 */
  setWokenAt?(nodeId: string, at: number | null): void
  /**
   * 执行前核对（`siteIdentities.verify`）：在这个节点上问这个 facility 一次，结果照常落表。回 undefined =
   * 这个 facility 不核对（没有 whoami、`login` 形状）。缺席 = 一律不核对。
   */
  verify?(facility: string, node: RouterNode): Promise<ProbeResult | undefined>
  /**
   * 发通知（`streamEvents.emit`）。换号发 `identity.mismatch`；登出发 `auth.needed`——与「需要登录」同一类事件，
   * 只是指名是哪个 profile（D9）。缺席 = 不发（错误本身照抛）。
   */
  notify?(e: EventInput): void
  /** facility 给人看的名字（包的 `facility.label`）。缺席 = facility 键。 */
  facilityLabel?(facility: string): string | undefined
  /** 按住 / 放掉一个唤起的 profile（扩展的 `holdProfile` / `releaseProfile`，经该节点的绑定）。 */
  holdProfile?(bindingId: string): Promise<void>
  releaseProfile?(bindingId: string): Promise<{ userWindows: number; unloading: boolean }>
  /** 等节点连上的上限。 */
  wakeWaitMs?: number
  now?: () => number
  log?: (line: string) => void
}

/** 唤起之后等节点连上的上限（D8）：一次冷加载 profile + 扩展 SW 起来 + 连上中继。 */
export const WAKE_WAIT_MS = 30_000

export interface IdentityRequest {
  target: IdentityTarget
  facility: string
  purpose: RunPurpose
}

/** 解析结果：在哪个节点上、以哪个身份；`release` 由 `runOnDevice` 在执行结束时叫一次。 */
export interface IdentityRoute {
  node: RouterNode
  identity: RunIdentity
  release(): Promise<void>
}

export interface IdentityRouter {
  resolve(req: IdentityRequest): Promise<IdentityRoute>
}

interface Candidate {
  node: RouterNode
  row: SiteIdentity & { accountId: string }
  online: boolean
}

/** 通知与错误里怎么称呼一个节点：「工作」（环境：工作）。 */
export function nodeWhere(n: Pick<RouterNode, 'nodeId' | 'label' | 'profileName' | 'environment'>): string {
  const name = n.label ?? n.profileName ?? n.nodeId
  return `「${name}」${n.environment && n.environment !== name ? `（环境：${n.environment}）` : ''}`
}

export function makeIdentityRouter(deps: IdentityRouterDeps): IdentityRouter & { candidates(target: IdentityTarget, facility: string): Candidate[] } {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const wakeWaitMs = deps.wakeWaitMs ?? WAKE_WAIT_MS
  const waitOnline = deps.waitOnline ?? (async (bindingId: string, ms: number) => {
    const deadline = Date.now() + ms
    while (!deps.isOnline(bindingId)) {
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, 250))
    }
    return true
  })
  /** 节点 → 在飞的那次唤起。 */
  const waking = new Map<string, Promise<boolean>>()

  /** 这个节点唤得起吗：记着 profile 目录、设备上的 agent 在线且会 `ensureApp`。 */
  const wakeable = (n: RouterNode): WakeAgent | undefined => {
    if (!n.profileDir) return undefined
    const agent = deps.agent?.(n.deviceId)
    return agent?.ops.has('ensureApp') ? agent : undefined
  }

  const wake = (node: RouterNode, agent: WakeAgent): Promise<boolean> => {
    const inflight = waking.get(node.nodeId)
    if (inflight) return inflight
    const p = (async () => {
      try {
        // `force`：节点离线这件事本身已经证明目标 profile 没加载，「有 Chrome 进程就不动手」在这里正好是错的
        // （design Context 6）。`--no-startup-window` 显式给：带了 `exe` 时 agent 不补默认参数。
        const out = await agent.send({
          op: 'ensureApp',
          args: { ...deps.launchBase?.(node.deviceId), profileDirectory: node.profileDir, force: true, args: ['--no-startup-window'] },
        }) as { running?: boolean } | undefined
        // 启动过了但进程始终没出现：没有扩展会来连，等 30 秒毫无意义。
        if (out?.running === false) return false
      } catch (e) {
        log(`[identity] 唤起 ${nodeWhere(node)} 失败：${e instanceof Error ? e.message : String(e)}`)
        return false
      }
      const ok = await waitOnline(node.bindingId, wakeWaitMs)
      if (ok) deps.setWokenAt?.(node.nodeId, now())
      else log(`[identity] 唤起了 ${nodeWhere(node)}，${wakeWaitMs / 1000} 秒内它的扩展没连上`)
      return ok
    })().finally(() => waking.delete(node.nodeId))
    waking.set(node.nodeId, p)
    return p
  }

  /**
   * 核对结果 → 放行（回此刻的显示名）或抛。对照的是选中那一行的账号：身份目标就是用户指定的那个号；环境目标是
   * 我们以为这个 profile 里登着的那个——换了号同样拦下（D9 不分两种目标），让用户知道环境里变了人。
   */
  const verdict = (
    r: ProbeResult | undefined,
    ctx: { label: string; node: RouterNode; row: Candidate['row']; facility: string },
  ): string | undefined => {
    if (r === undefined) return undefined // 这个 facility 不核对
    const where = nodeWhere(ctx.node)
    const site = deps.facilityLabel?.(ctx.facility) ?? ctx.facility
    const expected = ctx.row.displayName ?? ctx.row.accountId
    if (r.state === 'signed-in') {
      if (r.accountId === ctx.row.accountId) return r.name
      const found = r.name ?? r.accountId
      const e = new IdentityMismatch(ctx.facility, ctx.label, ctx.node.nodeId, found, where)
      emit({
        type: 'identity.mismatch', severity: 'warn',
        title: `${where}里的${site}现在登的是 ${found}`,
        body: `这次要用的是 ${expected}，执行已拦下，没有发出任何动作。在那个 profile 里换回 ${expected}，或把任务的身份改成 ${found}。`,
        detail: `facility=${ctx.facility}\nnode=${ctx.node.nodeId}\nexpected=${ctx.row.accountId}\nfound=${r.accountId}\ntarget=${ctx.label}`,
        ref: { kind: 'facility', id: ctx.facility },
        // 按（facility，节点）去重：同一个 profile 换了号，每一轮定时执行都撞一次，通知只要一条。
        dedupeKey: `identity-mismatch:${ctx.facility}:${ctx.node.nodeId}`,
      })
      throw e
    }
    if (r.state === 'signed-out') {
      const e = new IdentitySignedOut(ctx.facility, ctx.label, ctx.node.nodeId, where)
      emit({
        type: 'auth.needed', severity: 'warn',
        title: `${site} 在${where}里登录失效`,
        body: `${expected} 在${where}里已登出，按这个身份的执行已拦下。在那个 profile 里重新登录 ${site}。`,
        ref: { kind: 'facility', id: ctx.facility },
        // 与「需要登录」同一类事件；按节点去重——同一个号在两个 profile 里各自登出是两件要做的事。
        dedupeKey: `auth:${ctx.facility}:${ctx.node.nodeId}`,
      })
      throw e
    }
    // 问不出来不是答案（D5）：不当成登出、也不当成没换号——按离线处理，可重试。
    throw new IdentityOffline(ctx.facility, ctx.label, `在${where}核对身份没有结果：${r.reason}`)
  }

  /** 通知失败不遮住拦下这件事本身。 */
  const emit = (e: EventInput): void => {
    try { deps.notify?.(e) } catch { /* 同上 */ }
  }

  /** 节点 → 此刻有几次执行按着它。 */
  const holds = new Map<string, number>()

  const putBack = async (node: RouterNode): Promise<void> => {
    try {
      const r = await deps.releaseProfile!(node.bindingId)
      log(`[identity] 收回 ${nodeWhere(node)}：${r.userWindows > 0 ? `用户开着 ${r.userWindows} 扇窗，只关了 Stream 的标签` : '最后一扇窗已关，profile 将被卸载'}`)
      deps.setWokenAt?.(node.nodeId, null)
    } catch (e) {
      log(`[identity] 收回 ${nodeWhere(node)} 失败（它仍在后台开着）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 这次执行按住这个节点；回一个只生效一次的放手。不是 Stream 唤起的节点（用户自己开着的 profile）什么都不做：
   * 那不是我们的，收尾不该关它的窗。
   */
  const hold = async (node: RouterNode): Promise<() => Promise<void>> => {
    if (node.wokenAt === undefined || !deps.releaseProfile) return async () => {}
    const n = holds.get(node.nodeId) ?? 0
    holds.set(node.nodeId, n + 1)
    if (n === 0) await deps.holdProfile?.(node.bindingId).catch(() => {})
    let done = false
    return async () => {
      if (done) return
      done = true
      const left = (holds.get(node.nodeId) ?? 1) - 1
      if (left > 0) { holds.set(node.nodeId, left); return }
      holds.delete(node.nodeId)
      await putBack(node)
    }
  }

  /** 候选都离线：唤起其中最近核对过、唤得起的那一个。只试一个——每个都等 30 秒，一次执行就能拖上几分钟。 */
  const wakeOne = async (all: Candidate[]): Promise<Candidate | undefined> => {
    for (const c of all) {
      const agent = wakeable(c.node)
      if (!agent) continue
      if (!(await wake(c.node, agent))) return undefined
      // 连上时节点表刷新了绑定（同一个 profile 重新配对过）：读新的。
      const node = deps.node(c.node.nodeId) ?? c.node
      return { ...c, node, online: true }
    }
    return undefined
  }
  const candidates = (target: IdentityTarget, facility: string): Candidate[] => {
    const out: Candidate[] = []
    for (const row of deps.identities(facility)) {
      // `signed-out` 的行保留着上次的账号 id（界面显示「已登出」），它不是候选。
      if (row.state !== 'signed-in' || !row.accountId) continue
      if (target.kind === 'identity' && row.accountId !== target.accountId) continue
      const node = deps.node(row.nodeId)
      if (!node) continue
      if (target.kind === 'environment' && node.environment !== target.environment) continue
      out.push({ node, row: row as Candidate['row'], online: deps.isOnline(node.bindingId) })
    }
    return out.sort((a, b) => Number(b.online) - Number(a.online) || b.row.verifiedAt - a.row.verifiedAt)
  }

  const resolve = async (req: IdentityRequest): Promise<IdentityRoute> => {
    const { target, facility } = req
    const label = describeTarget(target, facility)
    const all = candidates(target, facility)
    if (!all.length) throw new IdentityOffline(facility, label, '身份表里没有哪个浏览器 profile 登着它')
    const pick = all.find((c) => c.online) ?? await wakeOne(all)
    if (!pick) throw new IdentityOffline(facility, label, '登着它的 profile 都不在线，也唤不起')
    // 现读：唤起刚记下的 `woken_at`、或之前哪次执行唤起后没收回去的，都在节点表里。
    const node = deps.node(pick.node.nodeId) ?? pick.node
    // 先按住再核对：`page` 形状的核对在唤起的 profile 里开一张标签、读完就关——那正是它唯一的一扇窗。
    const release = await hold(node)
    let accountName = pick.row.displayName
    try {
      if (deps.verify && now() - pick.row.verifiedAt > FRESH_MS[req.purpose]) {
        accountName = verdict(await deps.verify(facility, node), { label, node, row: pick.row, facility }) ?? accountName
      }
    } catch (e) {
      // 没执行就收尾：唤起的 profile 照样收回去。
      await release()
      throw e
    }
    return {
      node,
      identity: {
        facility,
        accountId: pick.row.accountId,
        ...(accountName ? { accountName } : {}),
        nodeId: node.nodeId,
      },
      release,
    }
  }

  return { resolve, candidates }
}
