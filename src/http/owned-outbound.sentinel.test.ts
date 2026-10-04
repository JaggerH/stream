/**
 * 命门测试：owned 在顶层 import 时已捕获原始绑定。本测试**在 import 之后**手动 patch
 * globalThis.fetch 与 http.get（模拟 RSSHub request-rewriter 后加载注入 self-origin Referer），
 * 断言 owned 通道不被注入，而裸通道被注入。若哪天捕获时序坏了（捕获晚于补丁），本测试转红。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ownedFetch, owned } from './owned-outbound.ts'

let server: Server | undefined
const restore: Array<() => void> = []
afterEach(() => {
  server?.close()
  while (restore.length) restore.pop()!()
})

/** 起本地 server，把每次请求收到的 referer header 推进 seen 数组。 */
async function refererRecorder(): Promise<{ base: string; seen: Array<string | undefined> }> {
  const seen: Array<string | undefined> = []
  server = createServer((req, res) => {
    seen.push(req.headers.referer)
    res.end('ok')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const { port } = server!.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, seen }
}

/** 模拟 rewriter：包一层，对无 Referer 的请求注入 self-origin Referer。 */
function installFetchRewriter() {
  const real = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('referer')) headers.set('referer', 'https://self-origin.example/')
    return real(input, { ...init, headers })
  }) as typeof fetch
  restore.push(() => {
    globalThis.fetch = real
  })
}

function installHttpGetRewriter() {
  const real = http.get
  ;(http as { get: typeof http.get }).get = ((
    url: string | URL,
    options: http.RequestOptions,
    cb?: (r: http.IncomingMessage) => void,
  ) => {
    const headers: Record<string, string> = { ...((options?.headers as Record<string, string>) ?? {}) }
    if (!('Referer' in headers) && !('referer' in headers)) headers.Referer = 'https://self-origin.example/'
    return real(url as URL, { ...options, headers }, cb)
  }) as typeof http.get
  restore.push(() => {
    ;(http as { get: typeof http.get }).get = real
  })
}

describe('owned 通道免疫 request-rewriter', () => {
  it('ownedFetch 不被注入 Referer；对照裸 fetch 被注入', async () => {
    const { base, seen } = await refererRecorder()
    installFetchRewriter()

    await ownedFetch(`${base}/owned`)
    // 对照：裸 globalThis.fetch（已被 patch）—— 证明 patch 真生效
    await globalThis.fetch(`${base}/bare`)

    expect(seen[0]).toBeUndefined() // owned 通道：无注入
    expect(seen[1]).toBe('https://self-origin.example/') // 裸通道：有注入
  })

  it('owned.httpGet 不被注入 Referer；对照 http.get 属性被注入', async () => {
    const { base, seen } = await refererRecorder()
    installHttpGetRewriter()

    await new Promise<void>((resolve, reject) => {
      owned
        .httpGet(new URL(`${base}/owned`), {}, (res) => {
          res.resume()
          res.on('end', () => resolve())
        })
        .on('error', reject)
    })
    // 对照：被 patch 的 http.get 属性
    await new Promise<void>((resolve, reject) => {
      http
        .get(new URL(`${base}/bare`), {}, (res) => {
          res.resume()
          res.on('end', () => resolve())
        })
        .on('error', reject)
    })

    expect(seen[0]).toBeUndefined() // owned 捕获绑定：无注入
    expect(seen[1]).toBe('https://self-origin.example/') // http.get 属性：有注入
  })
})
