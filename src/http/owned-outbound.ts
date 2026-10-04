/**
 * Stream 自己的受控出站 HTTP 通道 —— 内嵌 RSSHub 的 request-rewriter 够不着的那条。
 *
 * 背景：我们把 RSSHub 嵌进本进程，它懒加载时 `Object.defineProperties(globalThis, {fetch,
 * Headers, FormData, Request, Response})` 并替换 node:http/node:https 的 get/request，对无
 * Referer 的请求强塞 self-origin Referer。本模块在**顶层同步**快照原始绑定，先于任何 facility
 * 加载（RSSHub 首次路由命中才 await import），因此已存引用免疫全部补丁：
 *   - undici fetch 有独立网络栈（不经被 patch 的 node:http），内部用自己的 Request/Response；
 *   - ESM 具名 import 在加载时把当时的 http.get 绑定进本地名字，之后改 http.get 属性不影响它。
 * 此判断由命门测试 owned-outbound.sentinel.test.ts 锁死，不靠信仰。
 *
 * 归属边界：Stream 自己的出站走 owned；RSSHub 路由走它自己的改写器。见 docs/ARCHITECTURE.md。
 */
import { get as httpGet, request as httpRequest } from 'node:http'
import { get as httpsGet, request as httpsRequest } from 'node:https'

// 顶层同步快照 —— 加载时即绑定，后续 globalThis 被 patch 不影响已存引用。
const capturedFetch = globalThis.fetch

/** Stream 自己的出站 fetch：原始 undici fetch，标准 Response 语义。SSRF/业务语义由调用方保留。 */
export function ownedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return capturedFetch(input, init)
}

/** 原始 node http(s) 绑定 —— 流式 body / Range / 精细 header 控制的场景用（image-fetch）。 */
export const owned = { httpGet, httpsGet, httpRequest, httpsRequest }
