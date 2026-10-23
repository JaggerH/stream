/**
 * profile 认领（browser-identity D3）：Stream 经一台设备上的 host agent 列出 Chrome 的全部 profile，逐个用
 * 那个 profile 打开扩展自己的认领页（`claim.html#n=<nonce>`）；打开它的扩展实例经自己的绑定把 `nonce` 交回，
 * 交回的是哪个节点，那个 profile 就是它。
 *
 * 三条硬规矩：
 * - **只认同一台设备交回的 `nonce`。** 会话记着执行 `browser.claim` 的 agent 对应的扩展设备（`extDeviceId`）；
 *   交回的绑定落在别的设备上（另一台机器上的扩展拿到了这串 URL）就拒，节点一个都不动，`nonce` 也不作废
 *   ——真正在这台机器上的那个实例还要用它。
 * - **`nonce` 一次性、2 分钟。** 交回成功即作废；过期、未知、已用过一律拒。
 * - **20 秒没交回 = 「扩展未安装或未连上」。** 没装扩展时认领页根本打不开，后端除了等不到之外没有任何信号，
 *   所以只能按时间判。交回晚于 20 秒但在 2 分钟内的照样记下（状态从 missing 改回 claimed）。
 *
 * 新 profile 的竞态（spike S1）：profile 第一次被拉起时认领页先于扩展注册打开，页面加载失败、停在 URL 上。
 * 所以等待期间这台设备上新连上一个**尚未认领**的节点，就对仍在等的 profile 各补发一次 `browser.claim`，
 * 每个 profile 只补一次。分不出新连上的是哪个 profile（它还说不出自己是谁，这正是要认领的原因），只能对
 * 全部在等的都补——代价是没装扩展的 profile 会多开一扇窗，20 秒后它们照样落进同一个提示。
 *
 * 认领只由用户在面板上点出来（会在那台机器上开窗口），路由只认 loopback，见 `http/node-routes.ts`。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { DeviceIncapable, DeviceOffline } from './errors.ts'
import type { BrowserNode } from './node-store.ts'
import { PAIRED_PLATFORMS } from './device-store.ts'
import { LOCAL_DEVICE } from './run-context.ts'
import type { HostRelayRegistry } from '../http/host-registry.ts'

export const CLAIM_TTL_MS = 2 * 60_000
export const CLAIM_WAIT_MS = 20_000
export const MISSING_REASON = '扩展未安装或未连上'

/** 执行认领的那台设备的 host agent。 */
export interface ClaimAgent {
  deviceId: string
  /**
   * 这台机器上扩展绑定所在的设备：用共享 secret 连进来的桌面 agent 与后端同机 → `local`（本机节点都在
   * `local` 下）；配对设备 → 它自己的 `deviceId`。
   */
  extDeviceId: string
  ops: ReadonlySet<string>
  send(op: { op: string; args?: Record<string, unknown> }): Promise<unknown>
}

/**
 * 从 `/api/host` 的在线设备里找认领用的 agent。`local` = 后端这台机器上的桌面 agent（与 `ensureHarvestBrowser`
 * 唤起 Chrome 时同一个判法：`deviceFor('desktop')`）。
 *
 * 扩展设备的判法：共享 secret 只发给本机进程，用它连进来的只能是桌面 agent（配对平台拿共享 secret 连会被
 * 4003 拒，见 `attachHostRelay`），所以 windows / macos 的 agent 就是后端这台机器，扩展绑定在 `local` 下；
 * 配对设备上的扩展绑定挂在那台设备自己的 id 下（`ExtBindingStore` 签码时记的目标设备）。
 */
export function agentFrom(registry: Pick<HostRelayRegistry, 'devices' | 'deviceFor'>): (deviceId: string) => ClaimAgent | undefined {
  return (deviceId) => {
    const d = deviceId === LOCAL_DEVICE ? registry.deviceFor('desktop') : registry.devices().find((x) => x.hello.deviceId === deviceId)
    if (!d) return undefined
    return {
      deviceId: d.hello.deviceId,
      extDeviceId: PAIRED_PLATFORMS.has(d.hello.platform) ? d.hello.deviceId : LOCAL_DEVICE,
      ops: d.ops,
      send: (op) => d.relay.send(op),
    }
  }
}

export interface ProfileClaimsDeps {
  /** 按路由里的设备 id 找到在线的 agent。不在线 = undefined。 */
  agent: (deviceId: string) => ClaimAgent | undefined
  nodes: {
    get(nodeId: string): BrowserNode | undefined
    forDevice(deviceId: string): BrowserNode[]
    claimProfile(nodeId: string, profileDir: string, profileName: string): BrowserNode | undefined
    renameProfile(deviceId: string, profileDir: string, profileName: string): number
  }
  /** 绑定在哪台设备（`ExtRelayRegistry.deviceOf`）。 */
  deviceOf: (bindingId: string) => string | undefined
  /** 绑定是哪个节点（`ExtRelayRegistry.nodeOf`）；兼容槽与没记过节点的老配对绑定没有。 */
  nodeOf: (bindingId: string) => string | undefined
  /** 扩展 id（`STREAM_EXTENSION_ID`）：认领页的地址。 */
  extId: string
  now?: () => number
  nonce?: () => string
  log?: (line: string) => void
}

export interface DiscoverOpts {
  exe?: string
  userDataDir?: string
}

/** 认领时还可以只点名几个 profile（按目录名）。不点名 = 全部——但没装扩展的 profile 每个都会弹出一扇
 *  打不开的窗、并一直加载着，用户只装了一两个时就该点名。 */
export interface ClaimOpts extends DiscoverOpts {
  dirs?: string[]
}

export interface DiscoveredProfile {
  dir: string
  name: string
  gaiaEmail?: string
  gaiaName?: string
  /** 在 `last_active_profiles` 里：此刻（或 Chrome 上次退出时）开着。 */
  active: boolean
  /** 已认领过、记着这个目录的节点。 */
  nodeId?: string
}

export interface Discovery {
  deviceId: string
  userDataDir: string
  profiles: DiscoveredProfile[]
}

export type ClaimState = 'pending' | 'claimed' | 'missing' | 'failed'

export interface ClaimProfileStatus {
  dir: string
  name: string
  state: ClaimState
  nodeId?: string
  /** `missing` 的人话，或 `failed` 时 agent 回的错误。 */
  reason?: string
}

export interface ClaimSnapshot {
  claimId: string
  deviceId: string
  startedAt: number
  expiresAt: number
  /** 没有 profile 还在等了。 */
  done: boolean
  profiles: ClaimProfileStatus[]
}

export type ClaimAck =
  | { ok: true; profileDir: string; profileName: string; nodeId: string }
  | { ok: false; error: string }

interface Slot {
  dir: string
  name: string
  nonce: string
  state: ClaimState
  nodeId?: string
  reason?: string
  resent: boolean
}

interface Session {
  claimId: string
  deviceId: string
  extDeviceId: string
  startedAt: number
  expiresAt: number
  waitUntil: number
  exe?: string
  slots: Slot[]
  timers: Array<ReturnType<typeof setTimeout>>
}

const PROFILES_OP = 'browser.profiles'
const CLAIM_OP = 'browser.claim'

interface RawProfiles {
  userDataDir: string
  profiles: Array<{ dir: string; name: string; gaiaEmail?: string; gaiaName?: string }>
  lastActive: string[]
}

const isStr = (v: unknown): v is string => typeof v === 'string'

/** agent 回包的形状校验。坏了就报出来——当成空列表会让面板说「这台机器没有 profile」，而真因是 agent 坏了。 */
function parseProfiles(deviceId: string, raw: unknown): RawProfiles {
  const r = raw as Partial<RawProfiles> | null
  const bad = () => new Error(`设备 ${deviceId} 的 ${PROFILES_OP} 回包形状不对`)
  if (!r || typeof r !== 'object' || !isStr(r.userDataDir) || !Array.isArray(r.profiles)) throw bad()
  const profiles = r.profiles.map((p) => {
    if (!p || !isStr(p.dir) || !isStr(p.name)) throw bad()
    return { dir: p.dir, name: p.name, ...(isStr(p.gaiaEmail) ? { gaiaEmail: p.gaiaEmail } : {}), ...(isStr(p.gaiaName) ? { gaiaName: p.gaiaName } : {}) }
  })
  return { userDataDir: r.userDataDir, profiles, lastActive: Array.isArray(r.lastActive) ? r.lastActive.filter(isStr) : [] }
}

export class ProfileClaims {
  private readonly sessions = new Map<string, Session>()
  /** nonce → 它所在的会话与 profile。 */
  private readonly nonces = new Map<string, { session: Session; slot: Slot }>()
  private readonly now: () => number
  private readonly makeNonce: () => string

  constructor(private readonly deps: ProfileClaimsDeps) {
    this.now = deps.now ?? Date.now
    this.makeNonce = deps.nonce ?? (() => randomBytes(24).toString('base64url'))
  }

  private agentWith(deviceId: string, op: string): ClaimAgent {
    const a = this.deps.agent(deviceId)
    if (!a) throw new DeviceOffline(deviceId)
    if (!a.ops.has(op)) throw new DeviceIncapable(deviceId, op)
    return a
  }

  private async listProfiles(a: ClaimAgent, opts: DiscoverOpts): Promise<RawProfiles> {
    const args: Record<string, unknown> = {
      ...(opts.exe ? { exe: opts.exe } : {}),
      ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
    }
    const list = parseProfiles(a.deviceId, await a.send({ op: PROFILES_OP, ...(Object.keys(args).length ? { args } : {}) }))
    // 显示名可能被用户在 Chrome 里改了：每次列都按目录刷新（目录才是不变的键）。
    for (const p of list.profiles) this.deps.nodes.renameProfile(a.extDeviceId, p.dir, p.name)
    return list
  }

  /** 列出设备上的 profile，标出哪些已认领。只读，不开任何窗口。 */
  async discover(deviceId: string, opts: DiscoverOpts = {}): Promise<Discovery> {
    const a = this.agentWith(deviceId, PROFILES_OP)
    const list = await this.listProfiles(a, opts)
    const nodes = this.deps.nodes.forDevice(a.extDeviceId)
    return {
      deviceId: a.deviceId,
      userDataDir: list.userDataDir,
      profiles: list.profiles.map((p) => {
        const node = nodes.find((n) => n.profileDir === p.dir)
        return { ...p, active: list.lastActive.includes(p.dir), ...(node ? { nodeId: node.nodeId } : {}) }
      }),
    }
  }

  /**
   * 开一次认领：列 profile、每个签一个 `nonce`、逐个 `browser.claim`。同一台设备上一次没完的会话被它顶替
   * （旧 `nonce` 全部作废）——用户又点了一次，就是要重来。
   */
  async start(deviceId: string, opts: ClaimOpts = {}): Promise<ClaimSnapshot> {
    const a = this.agentWith(deviceId, CLAIM_OP)
    if (!a.ops.has(PROFILES_OP)) throw new DeviceIncapable(deviceId, PROFILES_OP)
    const all = await this.listProfiles(a, opts)
    // 点名了一个不存在的目录就整次拒掉，而不是悄悄少认一个：用户以为认领了它，面板上却永远没有结果。
    const unknown = opts.dirs?.filter((d) => !all.profiles.some((p) => p.dir === d)) ?? []
    if (unknown.length) throw new Error(`这台设备的 Chrome 没有这些 profile：${unknown.join('、')}`)
    const list = opts.dirs ? { ...all, profiles: all.profiles.filter((p) => opts.dirs!.includes(p.dir)) } : all
    for (const s of this.sessions.values()) if (s.deviceId === a.deviceId) this.drop(s)
    const t = this.now()
    const session: Session = {
      claimId: `claim_${randomUUID()}`,
      deviceId: a.deviceId,
      extDeviceId: a.extDeviceId,
      startedAt: t,
      expiresAt: t + CLAIM_TTL_MS,
      waitUntil: t + CLAIM_WAIT_MS,
      ...(opts.exe ? { exe: opts.exe } : {}),
      slots: list.profiles.map((p) => ({ dir: p.dir, name: p.name, nonce: this.makeNonce(), state: 'pending' as const, resent: false })),
      timers: [],
    }
    this.sessions.set(session.claimId, session)
    for (const slot of session.slots) this.nonces.set(slot.nonce, { session, slot })
    const missing = setTimeout(() => {
      for (const slot of session.slots) {
        if (slot.state === 'pending') { slot.state = 'missing'; slot.reason = MISSING_REASON }
      }
    }, CLAIM_WAIT_MS)
    // 会话（连同 nonce）留到 2 分钟：面板还要轮询结果，晚到的交回也还认。
    const expire = setTimeout(() => this.drop(session), CLAIM_TTL_MS)
    missing.unref?.()
    expire.unref?.()
    session.timers.push(missing, expire)
    for (const slot of session.slots) await this.sendClaim(a, session, slot)
    return this.snapshot(session)
  }

  private async sendClaim(a: ClaimAgent, session: Session, slot: Slot): Promise<void> {
    const url = `chrome-extension://${this.deps.extId}/claim.html#n=${slot.nonce}`
    try {
      await a.send({ op: CLAIM_OP, args: { profileDirectory: slot.dir, url, ...(session.exe ? { exe: session.exe } : {}) } })
    } catch (e) {
      // 页面开不出来，等也等不到；如实记下 agent 说了什么。别的 profile 照常认领。
      if (slot.state === 'pending') {
        slot.state = 'failed'
        slot.reason = e instanceof Error ? e.message : String(e)
      }
    }
  }

  private drop(s: Session): void {
    for (const t of s.timers) clearTimeout(t)
    for (const slot of s.slots) this.nonces.delete(slot.nonce)
    this.sessions.delete(s.claimId)
  }

  get(claimId: string): ClaimSnapshot | undefined {
    const s = this.sessions.get(claimId)
    return s ? this.snapshot(s) : undefined
  }

  private snapshot(s: Session): ClaimSnapshot {
    return {
      claimId: s.claimId,
      deviceId: s.deviceId,
      startedAt: s.startedAt,
      expiresAt: s.expiresAt,
      done: s.slots.every((x) => x.state !== 'pending'),
      profiles: s.slots.map((x) => ({
        dir: x.dir, name: x.name, state: x.state,
        ...(x.nodeId ? { nodeId: x.nodeId } : {}),
        ...(x.reason ? { reason: x.reason } : {}),
      })),
    }
  }

  /** 扩展经绑定交回了一个 `nonce`（`ExtRelayRegistry.onClaim`）。 */
  redeem(bindingId: string, nonce: string): ClaimAck {
    const hit = this.nonces.get(nonce)
    if (!hit) return { ok: false, error: '认领码不认识或已经用过' }
    const { session, slot } = hit
    if (this.now() > session.expiresAt) {
      this.drop(session)
      return { ok: false, error: '认领码过期了——在面板上重新识别' }
    }
    const device = this.deps.deviceOf(bindingId)
    if (device !== session.extDeviceId) {
      this.deps.log?.(`[profile-claim] 拒绝：${session.deviceId} 签的认领码经 ${bindingId}（设备 ${device ?? '?'}）交回`)
      return { ok: false, error: '这个认领码不是给这台机器的' }
    }
    const nodeId = this.deps.nodeOf(bindingId)
    if (!nodeId) return { ok: false, error: '扩展太旧，说不出自己是哪个节点——更新扩展后重新识别' }
    const node = this.deps.nodes.claimProfile(nodeId, slot.dir, slot.name)
    if (!node) return { ok: false, error: '这个节点还没有记录——稍后重新识别' }
    this.nonces.delete(nonce)
    slot.state = 'claimed'
    slot.nodeId = nodeId
    delete slot.reason
    this.deps.log?.(`[profile-claim] ${session.deviceId} 的 ${slot.dir}（${slot.name}）→ ${nodeId}`)
    return { ok: true, profileDir: slot.dir, profileName: slot.name, nodeId }
  }

  /**
   * 一条绑定连上了（`ExtRelayRegistry.onBindingConnected`）。新 profile 的竞态：等待窗口里，这台设备上连上
   * 一个尚未认领的节点，对仍在等的 profile 各补发一次 `browser.claim`。节点表在连上回调之前已经写好。
   */
  onBindingConnected(bindingId: string): void {
    const t = this.now()
    const device = this.deps.deviceOf(bindingId)
    const nodeId = this.deps.nodeOf(bindingId)
    if (!device || !nodeId) return
    const node = this.deps.nodes.get(nodeId)
    if (!node || node.profileDir) return
    for (const s of this.sessions.values()) {
      if (s.extDeviceId !== device || t > s.waitUntil) continue
      const due = s.slots.filter((x) => x.state === 'pending' && !x.resent)
      if (!due.length) continue
      const a = this.deps.agent(s.deviceId)
      if (!a) continue
      for (const slot of due) slot.resent = true
      void (async () => { for (const slot of due) await this.sendClaim(a, s, slot) })()
    }
  }

  close(): void {
    for (const s of [...this.sessions.values()]) this.drop(s)
  }
}
