import { mediaPlayUrl } from '../../shared/package-sdk/media-url.ts'
import type { FetchUrlResult } from '../../src/http/fetch-url.ts'
import type { BilibiliClient } from './client.ts'
import { videoRefOf } from './client.ts'

const PLATFORM = 'bilibili'
const SHORT_HOST = 'b23.tv'
const NO_ID: FetchUrlResult = { platform: PLATFORM, media: [], error: '这个链接里没有视频 id（BV… 或 av…）' }

/** 一条链接里的视频 id：`BV…`（任何位置）或 `/video/av<数字>`。抠不到给 undefined。 */
function videoIdIn(url: string): string | undefined {
  const bv = url.match(/BV[0-9A-Za-z]+/)?.[0]
  const av = url.match(/\/video\/av(\d+)/)?.[1]
  return bv ?? (av ? `av${av}` : undefined)
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

const onMainSite = (host: string) => host === 'bilibili.com' || host.endsWith('.bilibili.com')

/**
 * 短链 `b23.tv/<code>` 带的是一个短码，不是 BV 号——**只跟一跳** 302 拿 `Location`，再在它上面抠 id。
 * 只认落到主站的跳转：跳去别处的 Location 不当视频链接看（一个短链服务可以指向任何地方）。
 * HEAD 被拒（405 之类）就换 GET 再试一次；网络失败当「没跟到」处理，由调用方回原来的失败结果。
 */
async function followShortLink(url: string, fetchFn: typeof fetch): Promise<string | undefined> {
  const location = async (method: 'HEAD' | 'GET') => {
    const r = await fetchFn(url, { method, redirect: 'manual' })
    return { status: r.status, loc: r.headers.get('location') }
  }
  try {
    let { status, loc } = await location('HEAD')
    if (!loc && (status === 405 || status === 403 || status === 501)) ({ loc } = await location('GET'))
    if (!loc) return undefined
    const abs = new URL(loc, url).toString()
    return onMainSite(hostOf(abs)) ? abs : undefined
  } catch {
    return undefined
  }
}

export interface FetchUrlDeps {
  /** 只给短链跟跳用；默认全局 fetch，测试注入假的。 */
  fetch?: typeof fetch
}

/**
 * 「给我这个链接里的媒体」——本包认领 `bilibili.com` / `b23.tv` 两个键。
 *
 * 媒体地址用宿主导出的 `mediaPlayUrl` 拼，**不自己拼路由字符串**：路由改名的那天，
 * 自己拼的那份不会报错，只会指向一个 404。
 */
export async function fetchUrlFor(
  client: Pick<BilibiliClient, 'view'>, url: string, deps: FetchUrlDeps = {},
): Promise<FetchUrlResult> {
  let vid = videoIdIn(url)
  if (!vid && hostOf(url) === SHORT_HOST) {
    const target = await followShortLink(url, deps.fetch ?? globalThis.fetch)
    if (target) vid = videoIdIn(target)
  }
  if (!vid) return { ...NO_ID }
  let title = ''
  let author = ''
  let authorAvatar = ''
  try {
    const view = await client.view(videoRefOf(vid))
    title = view.title
    author = view.owner?.name ?? ''
    authorAvatar = view.owner?.face ?? ''
  } catch {
    // 标题/作者取不到不影响「这条链接能播」——地址是从 id 直接拼出来的。
  }
  return {
    platform: PLATFORM,
    title,
    author,
    author_avatar: authorAvatar,
    media: [{
      kind: 'video',
      url: mediaPlayUrl({ platform: PLATFORM, vid }),
      download_url: mediaPlayUrl({ platform: PLATFORM, vid, dl: true }),
    }],
  }
}
