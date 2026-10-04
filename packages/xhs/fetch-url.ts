import { mediaPlayUrl } from '../../shared/package-sdk/media-url.ts'
import type { FetchUrlResult } from '../../src/http/fetch-url.ts'
import { readNote, type DetailDeps } from './detail.ts'

const PLATFORM = 'xhs'
const SHORT_HOST = 'xhslink.com'

/**
 * 链接里的笔记 id：分享出来的三种路径 `/explore/<id>`、`/discovery/item/<id>`、`/search_result/<id>`。
 * 笔记 id 是 24 位十六进制。
 */
function noteIdIn(url: URL): string | undefined {
  return url.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-f]{24})(?:[/?#]|$)/i)?.[1]
}

function parse(url: string): URL | undefined {
  try { return new URL(url) } catch { return undefined }
}

const onMainSite = (host: string) => host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com')

/**
 * 短链 `xhslink.com/<code>` 只跟一跳 302 拿 `Location`（token 在跳转后的那条长链上）。
 * 只认落到主站的跳转；HEAD 被拒就换 GET 再试一次；网络失败当「没跟到」。
 */
async function followShortLink(url: string, fetchFn: typeof fetch): Promise<URL | undefined> {
  const location = async (method: 'HEAD' | 'GET') => {
    const r = await fetchFn(url, { method, redirect: 'manual' })
    return { status: r.status, loc: r.headers.get('location') }
  }
  try {
    let { status, loc } = await location('HEAD')
    if (!loc && (status === 405 || status === 403 || status === 501)) ({ loc } = await location('GET'))
    if (!loc) return undefined
    const abs = new URL(loc, url)
    return onMainSite(abs.hostname.toLowerCase()) ? abs : undefined
  } catch {
    return undefined
  }
}

export interface FetchUrlDeps {
  /** 只给短链跟跳用；默认全局 fetch，测试注入假的。 */
  fetch?: typeof fetch
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * 「给我这条小红书链接里的媒体」——本包认领 `xiaohongshu.com` / `xhslink.com` 两个键。
 *
 * 取数与打开笔记同一条路：在用户自己的 Chrome 里跑一次 xhs-detail（`readNote`）。所以链接必须带
 * `xsec_token`——没有它 recipe 只能碰运气找 feed 里的卡片，大概率白烧一个限速名额。分享链接都带。
 *
 * 视频笔记的地址是宿主通用播放路由（`mediaPlayUrl`）：签名 mp4 已由 `readNote` 登记进流地址表，
 * 播放时 xhs-resolve 成员取出、宿主代理。图文笔记直接给图集的 CDN 地址。
 */
export async function fetchUrlFor(
  deps: DetailDeps, url: string, opts: FetchUrlDeps = {},
): Promise<FetchUrlResult> {
  let u = parse(url)
  if (u && u.hostname.toLowerCase() === SHORT_HOST) u = await followShortLink(url, opts.fetch ?? globalThis.fetch)
  const noteId = u ? noteIdIn(u) : undefined
  if (!u || !noteId) return { platform: PLATFORM, media: [], error: '这个链接里没有笔记 id（/explore/… 或 /discovery/item/…）' }
  const token = u.searchParams.get('xsec_token')
  if (!token) return { platform: PLATFORM, media: [], error: '链接里没有 xsec_token——请用 App / 网页「分享」出来的完整链接' }

  const note = await readNote(noteId, token, deps)
  if (!note) return { platform: PLATFORM, media: [], error: '笔记页没读到这条笔记（可能已删除、仅自己可见，或登录态失效）' }
  const { it, images, videoUrl } = note
  const media: FetchUrlResult['media'] = videoUrl
    ? [{
        kind: 'video',
        url: mediaPlayUrl({ platform: PLATFORM, vid: noteId }),
        download_url: mediaPlayUrl({ platform: PLATFORM, vid: noteId, dl: true }),
        poster: images[0]?.url,
      }]
    : images.map((im) => ({ kind: 'image', url: im.url }))
  return {
    platform: PLATFORM,
    title: str(it.title),
    author: str(it.author),
    author_avatar: str(it.author_avatar),
    text: str(it.desc) || undefined,
    media,
  }
}
