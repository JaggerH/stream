/**
 * bilibili Web API 客户端：一个视频 id → 可播放流（progressive / DASH / 纯音轨）、UP 主、评论。
 *
 * 只**解析**，不搬字节——代理归宿主的播放路由（`src/video/dash.ts` / `play.ts`）。
 * 通用的 DASH 机制（分片信任表、MPD 拼装、Range 代理）也住宿主那边，这里只喂它数据：
 * `dash()` 把「取这些分片要带的请求头」放进 `DashResult.headers`，由 `/api/media/dash` 路由
 * 登进信任表。**这里不碰那张表**——它是宿主单例，包 bundle 里 inline 出来的会是第二张空表。
 * 本文件只许 `import type` 宿主的东西（自包含守卫 `src/packages/self-contained.guard.test.ts`）。
 */
import type { DashResult, DashStream } from '../../src/video/dash.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com'

/** cookie 从宿主来（`ctx.cookieFor('bilibili.com')`），**不读 process.env**：
 *  环境变量那条路是 RSSHub 的，采集侧现取才跟得上用户重新登录。 */
export type CookieFn = () => Promise<string | undefined>

/** A video reference — bilibili exposes either a bvid ("BV…") or a numeric avid. */
export interface VideoRef {
  bvid?: string
  aid?: string
}

/** 一个 id 字符串（`BV…` / `av…` / 裸数字）→ `VideoRef`。**只有 BV 号能进 `bvid`**：把
 *  `av116830928705054` 塞进 bvid，`refKey` 会当场 `bad video ref` 抛。给它一个名字是因为
 *  这条判据有两个消费端（播放的解析源、抽帧的视频源），各抄一遍就会漂——抽帧那处曾经只写
 *  了 `{ bvid: vid }`，于是每条 av 号的视频抽帧必然失败，而播放照常好使。 */
export function videoRefOf(vid: string): VideoRef {
  return vid.startsWith('BV') ? { bvid: vid } : { aid: vid.replace(/^av/, '') }
}

function refKey(ref: VideoRef): string {
  if (ref.bvid && /^BV[0-9A-Za-z]+$/.test(ref.bvid)) return ref.bvid
  if (ref.aid && /^\d+$/.test(ref.aid)) return `av${ref.aid}`
  throw new Error(`bad video ref: ${JSON.stringify(ref)}`)
}

const httpsify = (u?: string) => (u ? (u.startsWith('//') ? `https:${u}` : u) : '')

interface Resolved {
  url: string
  mime: string
  exp: number
}

export interface BiliUser {
  uid: string
  name: string
  face: string
}
export interface BiliOwner {
  mid: string
  name: string
  face: string
}
export interface BiliComment {
  rpid: string
  mid: string
  author: string
  avatar: string
  text: string
  like: number
  rcount: number
  ctime: number
  isUp: boolean
}
export interface BiliComments {
  total: number
  pageSize: number
  page: number
  pinned: BiliComment | null
  comments: BiliComment[]
}

const DAY = 24 * 3600_000
const cache = new Map<string, Resolved>()
const dashCache = new Map<string, DashResult & { exp: number }>()
const userCache = new Map<string, BiliUser & { exp: number }>()
const nameCache = new Map<string, BiliUser & { exp: number }>()
const ownerCache = new Map<string, BiliOwner & { exp: number }>()
const commentCache = new Map<string, BiliComments & { exp: number }>()

export class BilibiliClient {
  constructor(private readonly cookie: CookieFn) {}

  private async apiHeaders(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'User-Agent': UA, Referer: REFERER }
    const c = await this.cookie()
    if (c) h.Cookie = c
    return h
  }

  /** 登录用户自己的 uid（cookie 里的 DedeUserID）。一键订阅靠它零输入。 */
  async myUid(): Promise<string | null> {
    return (await this.cookie())?.match(/(?:^|;\s*)DedeUserID=(\d+)/)?.[1] ?? null
  }

  /** GET a bilibili JSON API with a few retries. view/playurl transiently return a
   *  non-zero code (risk control -412, brief rate limits) or drop the connection — a
   *  single blip must not 502 the whole video, so retry with a short backoff and only
   *  resolve on code===0. */
  private async apiJson(url: string, tries = 3): Promise<{ code: number; data?: unknown }> {
    let last: unknown
    for (let i = 0; i < tries; i++) {
      try {
        const j = (await fetch(url, { headers: await this.apiHeaders() }).then((r) => r.json())) as {
          code: number
          data?: unknown
        }
        if (j.code === 0) return j
        last = new Error(`code=${j.code}`)
      } catch (e) {
        last = e
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
    throw last instanceof Error ? last : new Error('bili api failed')
  }

  /** view → cid, then html5 playurl → a single progressive MP4 durl. Cached ~90min. */
  async stream(ref: VideoRef): Promise<Resolved> {
    const key = refKey(ref)
    const hit = cache.get(key)
    if (hit && hit.exp > Date.now()) return hit

    const idQ = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`
    const view = (await fetch(`https://api.bilibili.com/x/web-interface/view?${idQ}`, {
      headers: await this.apiHeaders(),
    }).then((r) => r.json())) as { code: number; data?: { cid?: number } }
    const cid = view.data?.cid
    if (view.code !== 0 || !cid) throw new Error(`view failed code=${view.code}`)

    const playIdQ = ref.bvid ? `bvid=${ref.bvid}` : `avid=${ref.aid}`
    const pu = (await fetch(
      `https://api.bilibili.com/x/player/playurl?${playIdQ}&cid=${cid}&qn=64&otype=json&fnval=1&fnver=0&platform=html5&high_quality=1`,
      { headers: await this.apiHeaders() }
    ).then((r) => r.json())) as { code: number; data?: { durl?: Array<{ url: string }> } }
    const url = pu.data?.durl?.[0]?.url
    if (pu.code !== 0 || !url) throw new Error(`playurl failed code=${pu.code}`)

    const resolved: Resolved = { url, mime: 'video/mp4', exp: Date.now() + 90 * 60_000 }
    cache.set(key, resolved)
    return resolved
  }

  /** Pure resolve: bvid/aid → the progressive CDN url + the headers its CDN demands
   *  (Referer, UA, cookie). No byte fetch — the caller streams it. */
  async progressive(ref: VideoRef): Promise<{ url: string; headers: Record<string, string> }> {
    const { url } = await this.stream(ref)
    return { url, headers: await this.apiHeaders() }
  }

  /** Resolve a video to its full DASH stream set (separate video + audio reps).
   *  This is the shared core: the MPD player and the audio path are independent
   *  consumers of it, so neither couples to the other. Cached ~90min.
   *
   *  `headers` 每次现取、不进缓存：cookie 在缓存窗口内可能轮换，分片代理要带的是此刻这份。 */
  async dash(ref: VideoRef): Promise<DashResult> {
    const key = refKey(ref)
    const hit = dashCache.get(key)
    if (hit && hit.exp > Date.now()) {
      const { exp: _exp, ...streams } = hit
      return { ...streams, headers: await this.apiHeaders() }
    }

    const idQ = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`
    const view = (await this.apiJson(`https://api.bilibili.com/x/web-interface/view?${idQ}`)) as {
      code: number
      data?: { cid?: number }
    }
    const cid = view.data?.cid
    if (!cid) throw new Error('view: no cid')

    const playIdQ = ref.bvid ? `bvid=${ref.bvid}` : `avid=${ref.aid}`
    const pu = (await this.apiJson(
      `https://api.bilibili.com/x/player/playurl?${playIdQ}&cid=${cid}&qn=120&otype=json&fnval=4048&fnver=0&fourk=1`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as { code: number; data?: { dash?: any } }
    const dash = pu.data?.dash
    if (!dash) throw new Error('playurl: no dash')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (s: any): DashStream => {
      const sb = s.SegmentBase ?? s.segment_base ?? {}
      return {
        id: s.id,
        codecs: s.codecs,
        mimeType: s.mimeType ?? s.mime_type,
        width: s.width,
        height: s.height,
        frameRate: s.frameRate ?? s.frame_rate,
        bandwidth: s.bandwidth,
        url: s.baseUrl ?? s.base_url,
        backupUrls: (s.backupUrl ?? s.backup_url ?? []) as string[],
        init: sb.Initialization ?? sb.initialization,
        indexRange: sb.indexRange ?? sb.index_range,
      }
    }
    const result: DashResult = {
      durationS: dash.duration ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      video: (dash.video ?? []).map(map),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audio: (dash.audio ?? []).map(map),
    }
    dashCache.set(key, { ...result, exp: Date.now() + 90 * 60_000 })
    return { ...result, headers: await this.apiHeaders() }
  }

  /** 最小码率的纯音轨：转写要的是声音，不是 1080p 画面。 */
  async audio(ref: VideoRef): Promise<{ url: string; headers: Record<string, string> }> {
    const dash = await this.dash(ref)
    const a = [...dash.audio].sort((x, y) => x.bandwidth - y.bandwidth)[0]
    if (!a) throw new Error('no audio stream')
    return { url: a.url, headers: await this.apiHeaders() }
  }

  /** uid → UP主 name + avatar, so a channel reads "bilibili-up <name>" and the
   *  detail header can show the author's avatar. Cached ~24h. */
  async user(uid: string): Promise<BiliUser> {
    if (!/^\d+$/.test(uid)) throw new Error(`bad uid: ${uid}`)
    const hit = userCache.get(uid)
    if (hit && hit.exp > Date.now()) return { uid, name: hit.name, face: hit.face }

    const j = (await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${uid}&photo=false`, {
      headers: await this.apiHeaders(),
    }).then((r) => r.json())) as { code: number; data?: { card?: { name?: string; face?: string } } }
    const name = j.data?.card?.name
    if (j.code !== 0 || !name) throw new Error(`card failed code=${j.code}`)
    const user: BiliUser = { uid, name, face: httpsify(j.data?.card?.face) }
    userCache.set(uid, { ...user, exp: Date.now() + DAY })
    return user
  }

  /** name → uid + avatar via user search (top result). The feed only gives author
   *  names, so this is how the detail header links to an author's space. Cached ~24h. */
  async userByName(name: string): Promise<BiliUser | null> {
    const key = name.trim()
    if (!key) return null
    const hit = nameCache.get(key)
    if (hit && hit.exp > Date.now()) return { uid: hit.uid, name: hit.name, face: hit.face }

    const j = (await fetch(
      `https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(key)}`,
      { headers: { ...(await this.apiHeaders()), Referer: 'https://search.bilibili.com/' } }
    ).then((r) => r.json())) as {
      code: number
      data?: { result?: Array<{ mid: number; uname: string; upic?: string }> }
    }
    // prefer an exact name match, else the top (highest-ranked) result
    const list = j.data?.result ?? []
    const u = list.find((x) => x.uname === key) ?? list[0]
    if (!u) return null
    const user: BiliUser = { uid: String(u.mid), name: u.uname, face: httpsify(u.upic) }
    nameCache.set(key, { ...user, exp: Date.now() + DAY })
    return user
  }

  /** bvid/aid → uploader { mid, name, avatar } via the video view API. Multi-author
   *  feeds (popular / followings) only carry the author name — RSSHub drops the face —
   *  so the list card resolves the real publisher avatar by video id. Cached ~24h. */
  async owner(ref: VideoRef): Promise<BiliOwner> {
    const key = refKey(ref)
    const hit = ownerCache.get(key)
    if (hit && hit.exp > Date.now()) return { mid: hit.mid, name: hit.name, face: hit.face }
    const idQ = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`
    const j = (await this.apiJson(`https://api.bilibili.com/x/web-interface/view?${idQ}`)) as {
      code: number
      data?: { owner?: { mid?: number; name?: string; face?: string } }
    }
    const o = j.data?.owner
    if (!o?.name) throw new Error('view: no owner')
    const owner: BiliOwner = { mid: String(o.mid ?? ''), name: o.name, face: httpsify(o.face) }
    ownerCache.set(key, { ...owner, exp: Date.now() + DAY })
    return owner
  }

  /** Top page of hot comments for a video, with the pinned / UP-author comments
   *  flagged (that's where supplementary text the video can't show usually lives).
   *  Fetched lazily on read and cached ~15min — comments evolve, items mostly
   *  aren't opened, so fetching at feed-tick time would be pure waste + rate-limit. */
  async comments(ref: VideoRef, pn = 1): Promise<BiliComments> {
    const cacheKey = `${refKey(ref)}#${pn}`
    const hit = commentCache.get(cacheKey)
    if (hit && hit.exp > Date.now()) return hit

    let aid = ref.aid
    if (!aid) {
      const view = (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${ref.bvid}`, {
        headers: await this.apiHeaders(),
      }).then((r) => r.json())) as { code: number; data?: { aid?: number } }
      aid = String(view.data?.aid ?? '')
      if (view.code !== 0 || !aid) throw new Error(`view failed code=${view.code}`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await fetch(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=${pn}&ps=20&sort=2`, {
      headers: await this.apiHeaders(),
    }).then((x) => x.json())) as { code: number; data?: any }
    if (r.code !== 0 || !r.data) throw new Error(`reply failed code=${r.code}`)

    const upMid = String(r.data.upper?.mid ?? '')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (x: any): BiliComment => ({
      rpid: String(x.rpid),
      mid: String(x.mid),
      author: x.member?.uname ?? '',
      avatar: httpsify(x.member?.avatar),
      text: x.content?.message ?? '',
      like: x.like ?? 0,
      rcount: x.rcount ?? 0,
      ctime: x.ctime ?? 0,
      isUp: !!upMid && String(x.mid) === upMid,
    })
    // pinned only belongs on the first page
    const pinnedRaw = pn === 1 ? (r.data.upper?.top ?? r.data.top?.upper ?? null) : null
    const result: BiliComments = {
      total: r.data.page?.count ?? 0,
      pageSize: r.data.page?.size ?? 20,
      page: r.data.page?.num ?? pn,
      pinned: pinnedRaw ? map(pinnedRaw) : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      comments: (r.data.replies ?? []).map(map),
    }
    commentCache.set(cacheKey, { ...result, exp: Date.now() + 15 * 60_000 })
    return result
  }

  /** 一次 view 调用同时拿标题与 UP 主——贴链接抓媒体要的就是这两样。 */
  async view(ref: VideoRef): Promise<{ title: string; owner: BiliOwner | null }> {
    const idQ = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`
    const j = (await this.apiJson(`https://api.bilibili.com/x/web-interface/view?${idQ}`)) as {
      data?: { title?: string; owner?: { mid?: number; name?: string; face?: string } }
    }
    const o = j.data?.owner
    return {
      title: j.data?.title ?? '',
      owner: o?.name ? { mid: String(o.mid ?? ''), name: o.name, face: httpsify(o.face) } : null,
    }
  }
}
