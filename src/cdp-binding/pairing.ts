/**
 * 配对与「对端自证」——与扩展走**同一套**（`extension/src/lib/pair-code.ts`、
 * `backend-identity.ts`），只换了运行时（Node 的 `fetch` / `crypto`）。
 *
 * 顺序不能反：先用一次性码换 token → 让对端用**这把 token** 签一条挑战应答（证明它也知道
 * token，而不是随便一个抢到这个口的进程）→ 才把 token 放进 WS 握手交出去。跳过中间那步，
 * 等于把 token 白送给任何抢到这个口的进程。
 *
 * ## Origin：这个绑定报的是扩展的 Origin
 *
 * `/api/ext/pair` 与 `/api/ext/verify` 各有一道 Origin 门，只认
 * `chrome-extension://<固定 id>`——它挡的是**网页**（浏览器强制 Origin，网页改不了它）。
 * CDP 绑定不是扩展，但服务端从 S10 起就把「用 CDP 驱动的浏览器」当成又一条扩展绑定看待：
 * 同一条 WS、同一套命令、同一份上下线事件。所以它在这里扮演的正是扩展那个浏览器客户端，
 * 报同一个 Origin。
 *
 * 这不是绕过：能设这个头的是本机进程，而本机进程本来就拿得到配对码 / token（同一条信任边界）；
 * 网页仍然伪造不了它。要换成另一个专属 Origin，得改服务端的门（网关），那是计划之外的事。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'
import { RELAY_PROTOCOL, VERIFY_PREFIX } from '../../shared/browser-relay/wire.ts'

export { RELAY_PROTOCOL }

/** 服务端这两口认的 Origin（见头注）。 */
export const EXT_ORIGIN = `chrome-extension://${STREAM_EXTENSION_ID}`

export class PairingFailed extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'PairingFailed'
  }
}

export class ServerNotTrusted extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ServerNotTrusted'
  }
}

export interface PairReply {
  bindingId: string
  token: string
  deviceId: string
}

export interface PairingHttp {
  fetchImpl?: typeof fetch
}

const base = (serverUrl: string) => serverUrl.replace(/\/+$/, '')

/** `HMAC-SHA256(sha256(token), VERIFY_PREFIX + nonce)` 的小写 hex（与服务端逐字节一致）。 */
export function bindingProof(token: string, nonce: string): string {
  const key = createHash('sha256').update(token).digest('hex')
  return createHmac('sha256', key).update(`${VERIFY_PREFIX}${nonce}`).digest('hex')
}

/** 一次性码换绑定 token。码不对 / 过期 → `PairingFailed`。 */
export async function pairWithCode(
  opts: { serverUrl: string; code: string; name?: string; browser?: string; platform?: string } & PairingHttp,
): Promise<PairReply> {
  const f = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await f(`${base(opts.serverUrl)}/api/ext/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXT_ORIGIN },
      body: JSON.stringify({
        code: opts.code.trim(),
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.browser ? { browser: opts.browser } : {}),
        ...(opts.platform ? { platform: opts.platform } : {}),
      }),
    })
  } catch (e) {
    throw new PairingFailed(`连不上 ${opts.serverUrl}：${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status === 403) throw new PairingFailed('配对码不对或已过期——在 Stream 上重新生成一个')
  if (!res.ok) throw new PairingFailed(`配对被拒：HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as Partial<PairReply> | null
  if (!body || typeof body.bindingId !== 'string' || typeof body.token !== 'string') {
    throw new PairingFailed('配对的回复不完整——对端可能不是 Stream，或版本太旧')
  }
  return { bindingId: body.bindingId, token: body.token, deviceId: typeof body.deviceId === 'string' ? body.deviceId : '' }
}

/**
 * 让对端证明它也持有这把 token。通过则返回，否则抛 `ServerNotTrusted`。
 *
 * **调用方必须把它当闸门，不能当日志**：验不过就别连（见头注的顺序）。
 */
export async function verifyServer(
  opts: { serverUrl: string; token: string; bindingId: string } & PairingHttp,
): Promise<void> {
  const f = opts.fetchImpl ?? fetch
  const nonce = randomBytes(32).toString('hex')
  let res: Response
  try {
    res = await f(`${base(opts.serverUrl)}/api/ext/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXT_ORIGIN },
      body: JSON.stringify({ nonce, binding: opts.bindingId }),
    })
  } catch (e) {
    throw new ServerNotTrusted(`验身份的请求没发出去：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new ServerNotTrusted(`验身份被拒：HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as { proof?: unknown } | null
  if (!body || typeof body.proof !== 'string') throw new ServerNotTrusted('验身份的应答里没有 proof')
  const expected = bindingProof(opts.token, nonce)
  const got = body.proof
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(got, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ServerNotTrusted('对端算不出正确的 proof —— 它不是我们配对的那台 Stream')
  }
}
