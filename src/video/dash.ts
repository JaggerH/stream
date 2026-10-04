/**
 * 通用 DASH：流形状、MPD 构建、分片主机信任表、带请求头的 range 代理。
 *
 * **这里不认识任何站点。** 分片代理能连哪些主机、带什么请求头，全部来自解析出的那一组流
 * 的登记（`rememberSegHosts`）——那些 URL 是上游自己给的，攻击者注入不进来，
 * 比放宽域名规则安全得多。静态域名白名单已经删除：它既追不上轮换的 CDN 域名
 * （表现是最高码率那一档恒 400、播放器卡死），又逼着宿主认识站名。
 *
 * **登记的是 `/api/media/dash` 路由，不是包。** 信任表是宿主进程里的单例；出 DASH 的那个包
 * 只在 `DashResult.headers` 里申报「取这些流要带的请求头」，路由拿到结果后按
 * `allStreamUrls(result)` 登记。包若自己 import 这里的单例去登记，用户层从 `dist/index.js`
 * 装载的那一份会把本文件 inline 进自己的 bundle——拿到的是第二张空表，登了也白登，
 * 分片路由一律 403 而没有任何一处会喊。
 *
 * 权威设计：docs/superpowers/specs/2026-09-19-facility-knowledge-stage3-design.md §2.3；
 * 回路由的理由：docs/superpowers/specs/2026-09-20-code-packages-prebuilt-dist-design.md §2.1
 */

export interface DashStream {
  id: number
  codecs: string
  mimeType: string
  width?: number
  height?: number
  frameRate?: string
  bandwidth: number
  url: string
  /** 同一段字节的备用 CDN 节点——主节点挂起或 5xx 时代理透明切过去。 */
  backupUrls?: string[]
  init: string
  indexRange: string
}

export interface DashResult {
  durationS: number
  video: DashStream[]
  audio: DashStream[]
  /** 分片代理取这些流时要带的请求头（站点的 Referer / Cookie）。由解析出它的包填，
   *  由 `/api/media/dash` 路由连同全部流 URL 一起登进信任表；缺省 = 不带头。 */
  headers?: Record<string, string>
}

/** 分片代理可能去取的每一条 URL——每条视频/音频流的主节点 + 备节点——SSRF 闸门要全部放行。 */
export function allStreamUrls(r: DashResult): string[] {
  return [...r.video, ...r.audio].flatMap((s) => [s.url, ...(s.backupUrls ?? [])])
}

/** 信任窗口：与解析结果的缓存同寿。过期之后那条流本来也该重解。 */
const SEG_HOST_TTL_MS = 90 * 60_000

interface SegHostEntry { exp: number; headers: Record<string, string> }
const seenSegHosts = new Map<string, SegHostEntry>()

const hostOf = (url: string): string | undefined => {
  try { return new URL(url).hostname } catch { return undefined }
}

/**
 * 「我刚解析出这一组流，它们在这些主机上，取它们要带这些请求头」。
 *
 * **请求头必须跟着一起记**：分片代理自己不认识任何站点，取不到 Referer / Cookie 的那一刻
 * 上游回的是 403，而 403 和"这个节点慢"在代理里长得一样（都只是一次失败的取字节）。
 */
export function rememberSegHosts(urls: string[], headers: Record<string, string>): void {
  const exp = Date.now() + SEG_HOST_TTL_MS
  for (const u of urls) {
    const host = hostOf(u)
    if (host) seenSegHosts.set(host, { exp, headers: { ...headers } })
  }
}

function liveEntry(url: string): SegHostEntry | undefined {
  // 只认 https：登记的请求头里带着用户的 Cookie，一条 http 分片 URL 会把它明文发出去。
  // 主机名相同、协议不同的 URL 是两回事——信任表按主机记，这一格得在这里补。
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.protocol !== 'https:') return undefined
  const entry = seenSegHosts.get(parsed.hostname)
  return entry && entry.exp > Date.now() ? entry : undefined
}

/** 这条分片 URL 的主机在不在信任表里（SSRF 闸门，`?u=`/`?b=` 的唯一判据）。 */
export function isAllowedSegHost(url: string): boolean {
  return liveEntry(url) !== undefined
}

/** 取这条分片要带的请求头（没登记过 = undefined，调用方此时本就不该去取它）。 */
export function segHeadersFor(url: string): Record<string, string> | undefined {
  const entry = liveEntry(url)
  return entry ? { ...entry.headers } : undefined
}

/**
 * Range 代理一条上游分片/整片：透传 Range，只带调用方给的请求头。
 *
 * TTFB-only 超时：上游迟迟不回响应头就放弃（死掉的 CDN 节点），但响应头一到就清掉定时器，
 * 让 body 不带截止时间地流下去——整条请求级的 AbortSignal 会掐死长下载。
 */
export async function proxyUrl(
  url: string,
  range: string | undefined,
  mime: string,
  timeoutMs?: number,
  headers?: Record<string, string>,
): Promise<Response> {
  const reqHeaders: Record<string, string> = { ...(headers ?? {}) }
  if (range) reqHeaders.Range = range

  let signal: AbortSignal | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  if (timeoutMs) {
    const ac = new AbortController()
    timer = setTimeout(() => ac.abort(), timeoutMs)
    signal = ac.signal
  }
  let upstream: Response
  try {
    upstream = await fetch(url, { headers: reqHeaders, signal })
  } finally {
    if (timer) clearTimeout(timer)
  }
  const out = new Headers()
  out.set('Content-Type', mime)
  out.set('Accept-Ranges', 'bytes')
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h)
    if (v) out.set(h, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 一条流的 BaseURL：主节点 `u=` + 最多两个备节点 `b=`，代理据此透明切换，
 *  dash.js 永远看不见节点变化。（封顶 2 个是为了不让 MPD 膨胀。） */
const segHref = (s: DashStream, kind: 'video' | 'audio') => {
  const backups = (s.backupUrls ?? [])
    .slice(0, 2)
    .map((b) => `&b=${encodeURIComponent(b)}`)
    .join('')
  return `/api/media/seg?u=${encodeURIComponent(s.url)}${backups}&m=${kind}`
}

/** ~1080p 的像素数（不分横竖屏）。4K/8K 逐分片经自建代理串流会诱发 ABR 过冲 →
 *  缓冲饿死 → 转圈循环，所以砍掉。 */
const MAX_PIXELS = 1920 * 1088

/** 一份 dash.js 能直接播的按需 MPD，每条流的 BaseURL 指向本机分片代理。
 *  只保留 H.264（avc）视频流以求广泛解码支持，并封顶 ~1080p；音频流全给（dash.js 自己挑）。 */
export function buildDashMpd(dash: DashResult): string {
  const rep = (s: DashStream, kind: 'video' | 'audio') => {
    const dims = kind === 'video' ? ` width="${s.width}" height="${s.height}" frameRate="${Math.round(Number(s.frameRate) || 30)}"` : ''
    return (
      `<Representation id="${s.id}-${xml(s.codecs)}" bandwidth="${s.bandwidth}" codecs="${xml(s.codecs)}"${dims}>` +
      `<BaseURL>${xml(segHref(s, kind))}</BaseURL>` +
      `<SegmentBase indexRange="${s.indexRange}"><Initialization range="${s.init}"/></SegmentBase>` +
      `</Representation>`
    )
  }
  const withinCap = (v: DashStream) => (v.width ?? 0) * (v.height ?? 0) <= MAX_PIXELS || !v.width || !v.height
  const avc = dash.video.filter((v) => /^avc/.test(v.codecs))
  // 优先 avc 并封顶 ~1080p；一个视频没有 avc 或只有 >1080p 的流时退而求其次，
  // 别发出一个空的 AdaptationSet。
  const capped = avc.filter(withinCap)
  const videos = capped.length ? capped : avc.length ? avc : dash.video.filter(withinCap)
  const vReps = (videos.length ? videos : dash.video).map((v) => rep(v, 'video')).join('')
  const aReps = dash.audio.map((a) => rep(a, 'audio')).join('')
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT${dash.durationS}S" minBufferTime="PT1.5S">` +
    `<Period>` +
    `<AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">${vReps}</AdaptationSet>` +
    `<AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1" lang="und">${aReps}</AdaptationSet>` +
    `</Period></MPD>`
  )
}
