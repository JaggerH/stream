/**
 * profile 认领的扩展半边（browser-identity D3）。
 *
 * Stream 经 host agent 用某个 profile 打开 `claim.html#n=<nonce>`；打开它的一定是那个 profile 里的这个扩展
 * 实例（扩展 id 固定、存储按 profile 隔离）。页面把 `nonce` 交给 SW，SW 经**全部已连的绑定**各发一次
 * `{ type: 'claim', nonce }`——不知道是哪个 Stream 签的（本机、配对的远处实例都可能），签发的那个认得它、
 * 回 `ok`，别的回「不认识」或者（老后端）干脆不回。第一个 `ok` 就是答案。
 *
 * 认领页往往正是把 SW 叫醒的那个事件：页面打开时连接可能还没建起来。所以不是只发一轮，而是在超时之前
 * 每隔一会儿看一眼，之后才连上的绑定也补发一次。
 */
import { notifySockets } from './relay-notify.ts'
import { rememberProfile } from './node.ts'

export interface ClaimResult {
  profileDir: string
  profileName: string
}

interface ClaimReplyMsg {
  type?: unknown
  nonce?: unknown
  ok?: unknown
  profileDir?: unknown
  profileName?: unknown
  error?: unknown
}

/** nonce → 等它回话的那次认领。 */
const waiting = new Map<string, (bindingId: string, msg: ClaimReplyMsg) => void>()

/** 驱动收到的一帧是不是认领回话；是就交给等它的那次认领，返回 true（不再进 dispatch）。 */
export function handleClaimReply(bindingId: string, msg: unknown): boolean {
  const m = msg as ClaimReplyMsg | null
  if (!m || m.type !== 'claim-result') return false
  if (typeof m.nonce === 'string') waiting.get(m.nonce)?.(bindingId, m)
  return true
}

export interface ClaimOpts {
  /** 等多久还没有一个 `ok` 就放弃。后端 20 秒判「未连上」，这里留够余量但不比它长太多。 */
  timeoutMs?: number
  pollMs?: number
  sockets?: () => Array<[string, { send(data: string): void }]>
  remember?: (profileDir: string, profileName: string) => Promise<unknown>
}

/**
 * 交回 `nonce`。成功：profile 记进 `chrome.storage.local.node` 并返回；全都拒了或超时：抛出能给用户看的错误。
 */
export function claimProfile(nonce: string, opts: ClaimOpts = {}): Promise<ClaimResult> {
  const { timeoutMs = 25_000, pollMs = 500, sockets = notifySockets, remember = rememberProfile } = opts
  return new Promise<ClaimResult>((resolve, reject) => {
    const sentTo = new Set<string>()
    const refusals = new Map<string, string>()
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(timer)
      waiting.delete(nonce)
      fn()
    }
    const sendAll = () => {
      for (const [id, s] of sockets()) {
        if (sentTo.has(id)) continue
        try {
          s.send(JSON.stringify({ type: 'claim', nonce }))
          sentTo.add(id)
        } catch { /* 正在断开，下一轮再试 */ }
      }
    }
    waiting.set(nonce, (bindingId, m) => {
      if (m.ok === true && typeof m.profileDir === 'string' && typeof m.profileName === 'string') {
        const r = { profileDir: m.profileDir, profileName: m.profileName }
        finish(() => { remember(r.profileDir, r.profileName).then(() => resolve(r), reject) })
        return
      }
      refusals.set(bindingId, typeof m.error === 'string' ? m.error : '拒绝了')
      // 连着的每一条都拒了，就不必等到超时（还没连上的绑定除外——它可能正是签发的那个）。
      const all = sockets().map(([id]) => id)
      if (all.every((id) => refusals.has(id))) finish(() => reject(new Error([...new Set(refusals.values())].join('；'))))
    })
    const poll = setInterval(sendAll, pollMs)
    const timer = setTimeout(() => finish(() => {
      if (!sentTo.size) reject(new Error('扩展没有连上任何 Stream——确认 Stream 在运行，再从面板重新识别'))
      else reject(new Error(refusals.size ? [...new Set(refusals.values())].join('；') : 'Stream 没有回应这次认领——从面板重新识别'))
    }), timeoutMs)
    sendAll()
  })
}
