import { publicHttpUrl } from '../adapters/safe-fetch.ts'
import { hostMatchesDomain } from './http-fetch.ts'
import type { InterpretHtmlDeps } from './interpret-html.ts'
import type { HtmlRecipe } from './recipe.ts'

/**
 * The `fetchHtml` a kind:'html' recipe runs on: a bare host GET that returns the response
 * TEXT (not JSON). Same two non-negotiable guards as makeHttpFetch — SSRF (public-host only,
 * so a recipe can't read cloud metadata or Stream's own admin API) and cookie binding
 * (cookieDomain must cover the request host). A STATIC cookie (anti-bot `visitor_test=human`)
 * rides in request.headers instead and is passed through untouched, to list and detail alike.
 *
 * `doFetch` is injected for tests; the default is Node's own globalThis.fetch. Headers go out
 * verbatim — see makeHttpFetch on why a browser-shaped User-Agent is a liability.
 */
/**
 * 按响应**自己声明的**字符集解码，不是无条件当 UTF-8。
 *
 * `res.text()` 永远按 UTF-8 解（fetch 规范如此，不看 Content-Type），所以任何 GBK/GB2312/
 * Big5 站取回来都是乱码——而**乱码不报错**：选择器一条都不命中，表现成「这个源今天没有内容」，
 * 跟站点改版长得一模一样。中文站这一档大量存在（实测 2026-09-02：中关村在线产品库
 * `content-type: text/html; charset=GBK`）。
 *
 * **这一格是通用机制不是站点知识**（判据：换个站还成不成立——成立），所以进引擎、不进 recipe：
 * 服务器已经在 Content-Type 里说了自己是什么编码，照做即可，recipe 什么都不用声明。头里没说
 * 就退回嗅探页面自己的 `<meta charset>`（老站常见），再没有才默认 UTF-8。
 */
export function charsetOf(contentType: string | null, body: ArrayBuffer): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  // 嗅探只看前 2KB：<meta> 必在 <head> 里，而那一段无论页面是什么编码，ASCII 字节都是原样的。
  const head = new TextDecoder('latin1').decode(body.slice(0, 2048))
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head)?.[1]
  return (fromMeta ?? 'utf-8').toLowerCase()
}

/** 解码；编码标签不认识就退回 UTF-8——宁可少数几个字错，也别整条源挂掉。 */
export function decodeBody(contentType: string | null, body: ArrayBuffer): string {
  const label = charsetOf(contentType, body)
  try {
    return new TextDecoder(label).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

export function makeHtmlFetch(
  recipe: HtmlRecipe,
  cookieFor?: (domain: string) => Promise<string | undefined>,
  doFetch?: typeof fetch,
): InterpretHtmlDeps['fetchHtml'] {
  const send = doFetch ?? fetch
  return async (req) => {
    const url = publicHttpUrl(req.url)
    if (!url) throw new Error(`html recipe "${recipe.sourceId}": refusing non-public URL ${req.url}`)
    const headers: Record<string, string> = { ...req.headers }
    if (recipe.cookieDomain) {
      if (!hostMatchesDomain(url.hostname, recipe.cookieDomain)) {
        throw new Error(
          `html recipe "${recipe.sourceId}": cookieDomain "${recipe.cookieDomain}" does not cover request host "${url.hostname}"`,
        )
      }
      const cookie = await cookieFor?.(recipe.cookieDomain)
      if (cookie) headers.cookie = cookie
    }
    const res = await send(url, { method: req.method, headers, body: req.body })
    if (!res.ok) {
      throw new Error(`html recipe "${recipe.sourceId}": ${req.method} ${url.hostname}${url.pathname} → ${res.status}`)
    }
    return decodeBody(res.headers.get('content-type'), await res.arrayBuffer())
  }
}
