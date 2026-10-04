/**
 * 「这条回落直链该怎么送到播放器」——按 host 查一张表，命中才改变送法。
 *
 * 存在的理由是**可见性**，不是加速。播放路径上的懒加载浏览器早就在做，而且做得比我们能做的好
 * （实测：84MB/87.8 分钟的 mp3，静止时只预缓冲前 278 秒就 defer；跳到第 70 分钟只取那附近 210
 * 秒、416ms 可播、中间 4000 秒一个字节不取）。它唯一的前提是源要正常应答 Range。
 *
 * 真正会坏的是另一头：有的源会**拒绝**某些区间（有的 CDN 对未缓存区间一律 403，实例见对应
 * facility 包的 README），而 resolve 的
 * 回落档是写死的 `302 → 原始直链`——302 一发出去 Stream 就退出了字节路径，状态码和原因全看不见，
 * `<audio>` 只会给一个裸的 `MEDIA_ERR_SRC_NOT_SUPPORTED` 然后静默转圈。用户看到的"加载好久"，
 * 其实是"上游已经拒了，但没人报告"。
 *
 * 命中表的 host 改走后端代理：**Range 原样透传**（懒加载语义一字不变），Stream 只是站在中间，
 * 于是拒绝这件事变得看得见、说得出、还能冷却。
 *
 * **策略来自包声明，源码不认识任何站。** 一个 facility 的 CDN 脾气写在它自己的
 * `package.json#stream.serving`（spec 2026-09-18-facility-knowledge-in-package §2.1），装载时由
 * `servingPoliciesOf` 并成一张表、经 `setServingPolicySource` 挂进来。**每次查都现取**——
 * install 热挂载后新包的策略要立刻生效，不在 boot 期存结果。
 *
 * **消费方有两个**：播放路径与**转写取字节**。两边问的都是同一个漏斗
 * （`src/audio/track-source.ts`），拿到 `fallback` 那一档时都查这张表——同样的直链、同样会吃
 * 403，所以谁都不许在这一步裸 fetch。
 */
import { proxyRangedStream } from '../video/play.ts'

export interface ServingPolicy {
  /** host 后缀。以 `.` 开头 = 后缀匹配（`.example.fm` 命中 `cdn5.example.fm` 与 `example.fm` 本身）；
   *  否则要求 host 全等。**别用裸 `endsWith`**——那会把 `evil-example.fm` 一起收进来。 */
  match: string
  /** 上游拒绝时报给用户的来源名（进 toast 文案）。 */
  label: string
  /**
   * 同一条路径可以由哪些主机服务。声明了就**不认接口给的那一台**——按 `hostStats` 排序挨个试，
   * 第一台给出非 4xx/5xx 的就用它。留空 = 只打原主机（老行为）。
   */
  hosts?: string[]
  /** 包作者写的一句结论——为什么这条 host 要走这张表。 */
  reason?: string
  /**
   * 这台主机的字节要带哪个 `Referer` 才给（有的 CDN 反着防盗链：不带 Referer 直接拒）。
   * 宿主**所有**替这台主机取字节的地方都问 `refererForUrl`——图片代理、海报比对、以及本表的
   * 代理透传——不许各写一份站点判断。缺省 = 不带（多数 CDN 反而拒带 Referer 的请求）。
   */
  referer?: string
}

/** 策略表的数据源。默认空表：没接线 = 没有任何站走代理，一律 302（老行为）。 */
let policySource: () => ServingPolicy[] = () => []

/** 装配层把「所有 recipe 包的 serving 声明」以 thunk 挂进来（`src/kernel/plugins/sources.ts`）。 */
export function setServingPolicySource(source: () => ServingPolicy[]): void {
  policySource = source
}

/** 这条 url 命中哪条服务策略；没命中 = 保持调用方的现状（302 直发给浏览器）。 */
export function servingPolicyFor(url: string): ServingPolicy | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  return policySource().find((p) =>
    p.match.startsWith('.')
      ? host === p.match.slice(1) || host.endsWith(p.match)
      : host === p.match,
  )
}

/** 替这条 url 取字节时该带的 Referer（包 serving 声明的 `referer`）；没声明 → undefined（不带）。 */
export function refererForUrl(url: string): string | undefined {
  return servingPolicyFor(url)?.referer
}

/** 冷却窗口。够盖住三种连打：浏览器媒体栈自己的重试、前端失败后的诊断二次拉取、用户手动再点一次。 */
const COOLDOWN_MS = 60_000

/**
 * 上游拒绝的负缓存——本模块的「省着用」那一半。
 *
 * 同一条 url 被上游拒过之后，窗口内**不再打上游**，直接把那条拒绝原样端出去。这类 CDN 对访问
 * 节奏敏感（侦察期间反复把本机打成整体 403、持续数小时），而失败恰恰是请求最容易翻倍的时刻。
 *
 * 只缓存**失败**，永不缓存成功的字节——那是播放器和 CDN 之间的事，我们不插手。进程内 Map，
 * 随重启清空；惰性淘汰，不留后台定时器。
 */
class RejectionCooldown {
  private readonly at = new Map<string, { status: number; ms: number }>()

  remember(url: string, status: number): void {
    this.at.set(url, { status, ms: Date.now() })
  }

  /** 窗口内 → 上次的上游状态码；过期或没记过 → undefined（该去打上游了）。 */
  get(url: string): number | undefined {
    const hit = this.at.get(url)
    if (!hit) return undefined
    if (Date.now() - hit.ms > COOLDOWN_MS) {
      this.at.delete(url)
      return undefined
    }
    return hit.status
  }

  clear(): void {
    this.at.clear()
  }
}

export const rejectionCooldown = new RejectionCooldown()

/** 上游连不上（DNS/超时/断连）时记的状态码。它是**数字 0**，所以读冷却一律用 `!== undefined`
 *  判在不在，别用真值判断——`if (cooled)` 会把这一档静默漏掉。 */
const UNREACHABLE = 0

function rejected(policy: ServingPolicy, status: number): Response {
  const detail = status === UNREACHABLE
    ? `连不上 ${policy.label} 的服务器——不是你这边的问题,稍后再试。`
    : `${policy.label} 拒绝了这次请求（HTTP ${status}）——不是你这边的问题,稍后再试。`
  // 502 而不是把上游的 403 原样透出去：403 在 Stream 自己的 API 语义里是「你没权限」,和「上游
  // 拒绝了我们」是两件事,混用会把排错的人带去查鉴权。前端 reportPlayFailure 读 {error,detail}
  // 弹 toast,所以这段文案就是用户最终看到的那句话。
  return new Response(JSON.stringify({ error: 'upstream_rejected', detail }), {
    status: 502,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** 一条记录的寿命。主机状态本来就在波动，过期就重新探——不能长期钉死在某一台上。 */
const STAT_TTL_MS = 10 * 60 * 1000

/**
 * 「够快了，别再探别的」的门槛（B/s）。
 *
 * 1 MB/s ≈ 一集 88MB 的播客 90 秒拉完，拖动到任意位置都是即时的，没必要再为更快去多打请求。
 * 低于它就还值得探一探——实测同一时刻同一个文件的差距是 103 KB/s vs 12.96 MB/s，
 * 而播放一条 141 kbps 的播客只需要 17.6 KB/s：**"能放"和"拖得动"是两个门槛，这里守的是后者。**
 */
const FAST_ENOUGH_BPS = 1024 * 1024

/**
 * 「哪台主机现在好用」的记忆。
 *
 * **不发探测请求**：拿真实播放的字节当尺子（`meter` 在透传的同时数字节和时间）。这条是有意的——
 * 有的官方 App 是每次播放前挨个打测速文件（实例见对应 facility 包的 README），而我们今天刚
 * 吃过教训：**请求打多了会被拒**。真实流量本来就要发，顺带量一下不多花一个请求。
 *
 * 排序规则：测过速的按速度降序 → 没测过的 → 刚失败过的垫底（**不是拉黑**，过期就重新有机会）。
 */
class HostStats {
  private readonly speed = new Map<string, { bps: number; at: number }>()
  private readonly failed = new Map<string, number>()

  note(host: string, bytesPerSec: number): void {
    if (bytesPerSec > 0) this.speed.set(host, { bps: bytesPerSec, at: Date.now() })
    this.failed.delete(host)
  }

  fail(host: string): void {
    this.failed.set(host, Date.now())
    this.speed.delete(host)
  }

  /** 该主机最近一次实测速度（B/s）；没测过或已过期 → undefined。 */
  speedOf(host: string): number | undefined {
    const hit = this.speed.get(host)
    if (!hit) return undefined
    if (Date.now() - hit.at > STAT_TTL_MS) { this.speed.delete(host); return undefined }
    return hit.bps
  }

  private failedRecently(host: string): boolean {
    const at = this.failed.get(host)
    if (at == null) return false
    if (Date.now() - at > STAT_TTL_MS) { this.failed.delete(host); return false }
    return true
  }

  /**
   * 候选主机的尝试顺序，四档，稳定排序（同档内保持调用方给的顺序）：
   *
   *   0 实测够快  →  1 没测过  →  2 实测很慢  →  3 刚失败过
   *
   * **「没测过」必须排在「实测很慢」前面**，否则永远学不到更好的那台：候选是「成功就停」地
   * 挨个试的，只要第一台能给（哪怕只有 103 KB/s）就再也不会去碰后面那台 12.9 MB/s 的。
   * 活体撞过（2026-08-05）：cdn5 恢复到 206 之后，实测速度稳定钉在 103 KB/s 不动——就是这一档
   * 排反了。把慢的降到「没测过」之后，下一次自然会去探一台新的；探到更快的，它升到 0 档就稳住。
   */
  rank(hosts: string[]): string[] {
    const tier = (h: string) => {
      const bps = this.speedOf(h)
      if (bps != null) return bps >= FAST_ENOUGH_BPS ? 0 : 2
      return this.failedRecently(h) ? 3 : 1
    }
    return [...hosts].sort((a, b) => {
      const ta = tier(a), tb = tier(b)
      if (ta !== tb) return ta - tb
      if (ta === 0 || ta === 2) return (this.speedOf(b) ?? 0) - (this.speedOf(a) ?? 0)
      return 0
    })
  }

  clear(): void { this.speed.clear(); this.failed.clear() }
}

export const hostStats = new HostStats()

/** 只换 host，路径/查询串/协议一个字符不动。换不动（URL 不合法）就返回原样。 */
function withHost(url: string, host: string): string {
  try {
    const u = new URL(url)
    u.host = host
    return u.toString()
  } catch {
    return url
  }
}

/** 这条 url 该按什么顺序试哪些主机。没声明候选 = 只有原主机。 */
function candidateHosts(url: string, policy: ServingPolicy): string[] {
  let origin: string
  try { origin = new URL(url).host } catch { return [] }
  if (!policy.hosts?.length) return [origin]
  return hostStats.rank([origin, ...policy.hosts.filter((h) => h !== origin)])
}

/**
 * 透传字节的同时量速度。**不缓冲**——只在流经的时候数字节和计时，读完才落一条记录。
 * 太小的响应（探测性的几百字节）不作数：算出来的 B/s 全是握手噪声。
 */
const MIN_METERED_BYTES = 64 * 1024
function meter(upstream: Response, host: string): Response {
  if (!upstream.body) return upstream
  // 用 performance.now()（亚毫秒）而不是 Date.now()：本地/近端的响应可能在同一毫秒内流完，
  // 那样 `ms` 会是 0，整条记录被静默丢掉——量到的永远是"没量到"。
  const t0 = performance.now()
  let bytes = 0
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk) },
    flush() {
      const ms = Math.max(performance.now() - t0, 0.001)
      if (bytes >= MIN_METERED_BYTES) hostStats.note(host, Math.round((bytes * 1000) / ms))
    },
  })
  return new Response(upstream.body.pipeThrough(tap), {
    status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
  })
}

/**
 * 按策略把一条上游直链送出去：能放行就原样透传字节（**Range 照传**，懒加载仍归浏览器），
 * 候选主机挨个试，全被拒才变成一条说人话的 502 并进入冷却。
 *
 * 冷却按**原始 url**记（= 这条资源整轮都没成功），先于出站检查——失败恰恰是请求最容易翻倍的时刻
 * （媒体栈重试 + 前端诊断二次拉取 + 用户手点）。
 */
export async function serveWithPolicy(url: string, policy: ServingPolicy, range?: string): Promise<Response> {
  const cooled = rejectionCooldown.get(url)
  if (cooled !== undefined) return rejected(policy, cooled)
  let lastStatus = UNREACHABLE
  for (const host of candidateHosts(url, policy)) {
    let upstream: Response
    try {
      upstream = await proxyRangedStream(withHost(url, host), policy.referer ? { Referer: policy.referer } : undefined, range)
    } catch {
      hostStats.fail(host)
      continue
    }
    if (upstream.status >= 400) {
      upstream.body?.cancel().catch(() => {}) // 丢弃拒绝页的 body,别泄连接
      hostStats.fail(host)
      lastStatus = upstream.status
      continue
    }
    return meter(upstream, host)
  }
  rejectionCooldown.remember(url, lastStatus)
  return rejected(policy, lastStatus)
}
