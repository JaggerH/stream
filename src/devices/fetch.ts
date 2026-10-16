/**
 * 出站 HTTP 的唯一入口。按执行上下文的设备选实现：`local` 走 owned 通道（`ownedFetch`），
 * 其他设备经 host-relay 的 `http.fetch` op 由那台设备发出。调用方拿到的是同一个 fetch 签名。
 *
 * **非 local 的分支里没有任何一条路通向 `ownedFetch`**——设备离线、断连、拒绝都只会抛，
 * 不会改在主实例上发。这是 spec device-execution「绝不回落到 local」的实现本身，不是约定。
 * 权威设计：openspec/changes/device-execution/design.md D5、D6、D9。
 */
import { ownedFetch } from '../http/owned-outbound.ts'
import {
  HostFetchQueueTimeout, HostOpError, HostRelayDisconnected, HostRelayTimeout,
  type HttpFetchArgs, type HttpFetchResult,
} from '../http/host-relay.ts'
import type { DeviceFetchRelay } from '../http/host-registry.ts'
import type { DebugEntry } from '../debug.ts'
import { DeviceFetchQueueTimeout, DeviceIncapable, DeviceLost, DeviceOffline, DeviceRefused, HostNotAllowed } from './errors.ts'
import { LOCAL_DEVICE, currentPlacement, hostAllowed } from './run-context.ts'

export const MAX_DEVICE_BODY = 10 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

export interface FetchForDeps {
  directory: {
    isOnline(id: string): boolean
    hasOp(id: string, op: string): boolean
    fetchRelay(id: string): DeviceFetchRelay | undefined
  }
  local?: typeof fetch
  debug?: (e: DebugEntry) => void
  now?: () => number
}

async function encodeBody(body: RequestInit['body']): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body).toString('base64')
  if (body instanceof URLSearchParams) return Buffer.from(body.toString()).toString('base64')
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('base64')
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64')
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer()).toString('base64')
  // 流式 body / FormData：设备通道第一版不做流（spec Non-Goals）。说清楚，不悄悄丢。
  throw new TypeError('device fetch: 只支持 string / URLSearchParams / ArrayBuffer / TypedArray / Blob 作为请求体')
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

function toResponse(r: HttpFetchResult): Response {
  const headers = new Headers()
  for (const [k, v] of r.headers) headers.append(k, v)
  const bytes = Buffer.from(r.body, 'base64')
  const res = new Response(NULL_BODY_STATUS.has(r.status) ? null : bytes, { status: r.status, headers })
  // 构造出来的 Response 没有 url；调用方（重定向判断、日志）要它。
  Object.defineProperty(res, 'url', { value: r.url })
  return res
}

/** 调用方 signal 的剩余时间。`AbortSignal.timeout` 没有公开剩余时间，所以只能取默认上限，由下面的竞速兜底。 */
function timeoutFor(_signal: AbortSignal | null | undefined): number {
  return DEFAULT_TIMEOUT_MS
}

function abortRace<T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

export function makeFetchFor(deps: FetchForDeps): typeof fetch {
  const local = deps.local ?? ownedFetch
  const now = deps.now ?? Date.now

  return async function fetchFor(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const p = currentPlacement()
    if (p.deviceId === LOCAL_DEVICE) return local(input, init)

    const req = input instanceof Request ? input : undefined
    const url = new URL(req ? req.url : String(input))
    const deviceId = p.deviceId
    if (!hostAllowed(url.hostname, p.allowHosts)) throw new HostNotAllowed(deviceId, url.hostname)
    if (!deps.directory.isOnline(deviceId)) throw new DeviceOffline(deviceId)
    const relay = deps.directory.fetchRelay(deviceId)
    if (!relay) throw new DeviceIncapable(deviceId, 'http.fetch')

    const signal = init?.signal ?? req?.signal
    if (signal?.aborted) throw signal.reason

    const headers: [string, string][] = []
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => headers.push([k, v]))
    const args: HttpFetchArgs = {
      method: (init?.method ?? req?.method ?? 'GET').toUpperCase(),
      url: url.toString(),
      headers,
      ...(init?.body !== undefined ? { body: await encodeBody(init.body) } : {}),
      redirect: (init?.redirect ?? req?.redirect) === 'manual' ? 'manual' : 'follow',
      timeoutMs: timeoutFor(signal),
      allowHosts: [...p.allowHosts],
    }

    const started = now()
    let status = 0
    try {
      const result = await abortRace(relay.fetchOp(args), signal)
      if (Buffer.byteLength(result.body, 'base64') > MAX_DEVICE_BODY) {
        throw new DeviceRefused(deviceId, 'too-large', `响应体超过 ${MAX_DEVICE_BODY} 字节`)
      }
      status = result.status
      try {
        return toResponse(result)
      } catch (e) {
        // 设备回了 Response 不接受的状态码（如 1xx）：归成设备侧的网络错误，别漏出裸 RangeError。
        throw new DeviceRefused(deviceId, 'network', e instanceof Error ? e.message : String(e))
      }
    } catch (e) {
      if (e instanceof DeviceRefused) throw e
      if (e instanceof HostFetchQueueTimeout) throw new DeviceFetchQueueTimeout(deviceId)
      if (e instanceof HostOpError) throw new DeviceRefused(deviceId, e.code ?? 'network', e.message)
      if (e instanceof HostRelayDisconnected || e instanceof HostRelayTimeout) throw new DeviceLost(deviceId, e)
      // HostAbortedByUser 与调用方自己的 abort reason 原样抛：前者是用户明确的停止，不是设备故障。
      throw e
    } finally {
      deps.debug?.({
        id: `device-fetch:${deviceId}@${started}`,
        at: started,
        channel: 'device-fetch',
        key: deviceId,
        title: `${args.method} ${url.hostname}`,
        summary: `${deviceId} ${args.method} ${url.hostname} → ${status || 'error'} (${now() - started}ms)`,
        ok: status >= 200 && status < 400,
        fields: [
          { label: 'device', value: deviceId },
          { label: 'method', value: args.method },
          { label: 'host', value: url.hostname },
          { label: 'status', value: String(status || 'error') },
          { label: 'ms', value: String(now() - started) },
        ],
      })
    }
  }
}

/** 未接线时的缺省：local 照常，非 local 一律离线——宁可报错，不可在本机悄悄发出去。 */
let impl: typeof fetch = async (input, init) => {
  const p = currentPlacement()
  if (p.deviceId === LOCAL_DEVICE) return ownedFetch(input, init)
  throw new DeviceOffline(p.deviceId)
}

/** serve 装配时调用一次，把带设备目录的实现装进来。 */
export function installFetchFor(f: typeof fetch): void {
  impl = f
}

/** 模块级委托：调用点不需要接线就能 import，现取 `impl`。 */
export const fetchFor: typeof fetch = (input, init) => impl(input, init)
