/**
 * 代理上游响应体的一道闸：**上游断流必须被我们接住并带来源记一行**，不能裸着从
 * `@hono/node-server` 的兜底里冒出来。
 *
 * 为什么要有它：`proxyUrl` / `proxyRangedStream` 把 undici fetch 的 body 原样流回浏览器
 * （分片代理、播放代理、回落直链代理都在这条路上）。上游 CDN 断流时 body 流以
 * `TypeError: terminated`（cause `SocketError: other side closed`）报错，而 node-server 的
 * `handleResponseError` 拿到它只做一句裸 `console.error(e)`——日志里就是一段没有前缀、
 * 没有来源的 undici 内部栈，既看不出是哪个 CDN、也看不出断在哪个请求上（活体：一段
 * 明文 http GET 读了 ~10MB 后对端关闭，日志里只剩裸 `TypeError: terminated`）。
 *
 * 处理：手动泵一层（不能走 `pipeThrough`——源错误会被 TransformStream 原样透传给读端，
 * 等于没接），接住源错误后**带 host 记一行**（只记 host，query 里常有签名/凭据），然后让
 * 读端以 `ERR_STREAM_PREMATURE_CLOSE` 收场——node-server 对这个 code 只回一句 info，不再
 * 打裸栈。读端拿到的仍是一次明确的传输中断（播放器会换源/重试该分片，与原行为一致），
 * 不是一次"看起来完整"的截断。
 *
 * 下游取消（播放器 seek/换档 routinely cancel 分片请求）走 cancel 路径：原样取消上游，
 * 安静收场，不记日志。pull 里冒出的 AbortError（上游自己被中止——超时信号等）**不**算取消：
 * 按断流处理（见 cancelled 标志的注释）。
 */

/** node-server 对 `ERR_STREAM_PREMATURE_CLOSE` 只打一句 info，见其 handleResponseError。 */
export const PREMATURE_CLOSE = 'ERR_STREAM_PREMATURE_CLOSE'

export interface GuardOpts {
  /** 缺省 `console.warn`。 */
  log?: (m: string) => void
}

export function guardUpstreamBody(resp: Response, url: string, opts?: GuardOpts): Response {
  if (!resp.body) return resp
  const log = opts?.log ?? ((m: string) => console.warn(m))
  let host = url
  try {
    host = new URL(url).host
  } catch {
    /* 相对/畸形 url 就原样记，别让守卫自己变成新的故障点 */
  }
  const reader = resp.body.getReader()
  let bytes = 0
  /** 下游主动取消过了没有。只有 cancel 回调**已触发**之后的 AbortError 才是取消的回声——
   *  下游取消走 cancel 回调（ReadsTream 的约定），到不了 pull；pull 里冒出来的 AbortError 是
   *  **上游**被中止（超时信号、上游断流的一种），这时安静 close 会把截断的响应体伪装成完整
   *  结束（没有 content-length 的 200 尤其看不出来），必须按断流处理。 */
  let cancelled = false
  const out = new ReadableStream<Uint8Array>({
    pull: async (ctrl) => {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (e) {
        // cancel 回调已触发之后的 AbortError 是这次取消自己的回声：安静收场。
        if (cancelled && e instanceof Error && e.name === 'AbortError') {
          ctrl.close()
          return
        }
        const detail = e instanceof Error ? e.message : String(e)
        log(`[media-proxy] 上游 ${host} 在转发 ${bytes} 字节后断流：${detail}`)
        const closed = new Error(`[media-proxy] 上游 ${host} 中断于 ${bytes} 字节（${detail}）`)
        ;(closed as Error & { code?: string }).code = PREMATURE_CLOSE
        ctrl.error(closed)
        return
      }
      if (chunk.done) {
        ctrl.close()
        return
      }
      bytes += chunk.value.byteLength
      ctrl.enqueue(chunk.value)
    },
    cancel: () => {
      // 播放器取消（seek/换档/关页面）：把取消传导给上游，socket 才放得掉。
      cancelled = true
      return reader.cancel().then(
        () => {},
        () => {},
      )
    },
  })
  return new Response(out, { status: resp.status, statusText: resp.statusText, headers: resp.headers })
}
