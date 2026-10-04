import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HarvestBrowserStatus } from './harvest-browser.ts'
import { cleanField, sanitizeHandshake, type ExtHandshake } from '../../shared/browser-relay/handshake.ts'
export { parseExtHandshake, sanitizeHandshake, type ExtHandshake } from '../../shared/browser-relay/handshake.ts'

/**
 * 「用户这台机器上，浏览器采集这条链到底具备不具备」的落盘缓存。
 *
 * 关键事实（spec §5）：**扩展本身就跑在 Chrome 里**。它连上来的那一刻，「有没有 Chrome」和
 * 「有没有扩展」同时被回答——不需要查文件系统、不需要问 host-agent、不在乎后端跑在哪。
 * 原本设想的三级递增检测因此塌成一条线，缓存里也就只需要一个布尔。
 *
 * **`everSeen` 语义单调：一旦 true 永不回退。** "装过"是历史事实，卸载不会让它没发生过——
 * 所以这里**没有任何过期/失效逻辑，也不要加 TTL**。用户真把扩展卸了，他会看到"扩展掉线了"、
 * 照排查步骤走、重装、又连上；不需要代码去猜他卸没卸。
 */
export interface BrowserCapability {
  /** 连上过 ⇒ Chrome 和扩展都装了（一条信号答两个问题）。单调，永不回退。 */
  everSeen: boolean
  /** ISO；"掉线多久了"用它。 */
  lastSeenAt?: string
  /** 扩展自报。升级后没 reload 是最常见的一类故障。 */
  extVersion?: string
  /** 扩展自报：UA 里的 Chrome/Edge + 大版本。 */
  browser?: string
  /** 扩展自报：win/mac/linux —— 排查步骤要按平台给。 */
  platform?: string
}

/** 快判的三态，直接对应 spec §5 那三行引导文案。 */
export type BrowserCapabilityState =
  /** relay 连着 —— 现在就能采。 */
  | 'ready'
  /** 没连 + everSeen —— 扩展掉线了（提示 + 排查步骤，**不跑诊断**）。 */
  | 'disconnected'
  /** 没连 + 从没连上过 —— 装 Chrome + 装扩展（引导是同一套）。 */
  | 'never-seen'

/** `GET /api/browser-capability` 的返回：relay 现状 + 落盘缓存，别的什么都没有。 */
export interface BrowserCapabilitySnapshot extends BrowserCapability {
  state: BrowserCapabilityState
  /** 扩展**此刻**连着吗。MV3 的 SW 被回收是常态，false 不等于出故障。 */
  connected: boolean
  /** 当前这条连接的建立时刻（ISO），未连时 null —— 与 `/api/ext/relay-status` 同源。 */
  since: string | null
}

/**
 * 全量诊断的返回：快判的每个字段 + 一个 `chrome` 块（「采集用哪个 Chrome」的候选与当前选择）。
 * `POST /api/browser-capability/diagnose` 和 MCP 的 `harvest_capability` 是这同一个结构的两扇门。
 */
export interface BrowserCapabilityDiagnosis extends BrowserCapabilitySnapshot {
  chrome: HarvestBrowserStatus
}

/**
 * 纯函数：relay 现状 + 缓存 → 快判返回体。**不探测、不等待、不唤醒**，所以永远秒回。
 * 三态判定就这一处，端点和 MCP tool 共用同一个形状（不另造）。
 */
export function summarizeCapability(
  status: { connected: boolean; since: string | null },
  cap: BrowserCapability,
): BrowserCapabilitySnapshot {
  const state: BrowserCapabilityState = status.connected
    ? 'ready'
    : cap.everSeen
      ? 'disconnected'
      : 'never-seen'
  return { ...cap, state, connected: status.connected, since: status.since }
}

/**
 * 快判 + Chrome 候选 → 全量诊断。**组装只有这一处**：HTTP 端点和 MCP tool 都调它，所以
 * `chrome` 这个字段名和「快判字段原样带着」这条只存在一份，两面不可能各自漂。
 * 候选发现（摸文件系统）由调用方先做完再传进来——这个函数自己不做任何 I/O。
 */
export function diagnoseCapability(
  quick: BrowserCapabilitySnapshot,
  chrome: HarvestBrowserStatus,
): BrowserCapabilityDiagnosis {
  return { ...quick, chrome }
}

/**
 * `data/browser-capability.json` 的读写。写入点全局只有一处：`ExtRelay.connect()`。
 *
 * 写失败**不抛**（走 onError 记一行）：这是一份诊断缓存，让它把一条正常的扩展连接掀翻是本末倒置。
 * 只读的场景（stdio MCP 的 disk 档）天然不会走到写——那条路根本没有 relay 连接。
 */
export class BrowserCapabilityStore {
  private cap: BrowserCapability
  private readonly now: () => Date
  private readonly onError: (err: unknown) => void

  constructor(
    private readonly path: string,
    opts?: { now?: () => Date; onError?: (err: unknown) => void },
  ) {
    this.now = opts?.now ?? (() => new Date())
    this.onError = opts?.onError ?? ((err) => console.warn(`[browser-capability] persist failed: ${String(err)}`))
    this.cap = this.load()
  }

  private load(): BrowserCapability {
    if (!existsSync(this.path)) return { everSeen: false }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      // 逐字段收：文件是我们自己写的，但读的时候仍按不可信处理（手改过、版本漂移过都可能）。
      const cap: BrowserCapability = { everSeen: raw.everSeen === true }
      const lastSeenAt = cleanField(raw.lastSeenAt)
      if (lastSeenAt) cap.lastSeenAt = lastSeenAt
      Object.assign(cap, sanitizeHandshake(raw))
      return cap
    } catch {
      // 文件损坏 → 冷启动（everSeen:false）。写是 tmp+rename 原子换的，这条几乎不该发生；
      // 真发生了也宁可让用户多看一次装机引导，不去从一份读不懂的文件里猜"他以前装过"。
      return { everSeen: false }
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = join(dirname(this.path), `.browser-capability.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(this.cap, null, 2))
      renameSync(tmp, this.path) // 原子替换
    } catch (err) {
      this.onError(err)
    }
  }

  /** 当前缓存的拷贝（快判读它）。 */
  get(): BrowserCapability {
    return { ...this.cap }
  }

  /**
   * 扩展连上了：`everSeen` 置 true（单调）、刷新 `lastSeenAt`，并用自报字段覆盖对应项。
   * **自报字段缺失 = 保持原值**（老版本扩展降级连上时，不该把之前记下的版本/平台抹掉）。
   */
  markSeen(info?: ExtHandshake): BrowserCapability {
    const h = sanitizeHandshake(info)
    this.cap = {
      ...this.cap,
      ...h,
      everSeen: true,
      lastSeenAt: this.now().toISOString(),
    }
    this.persist()
    return this.get()
  }
}
