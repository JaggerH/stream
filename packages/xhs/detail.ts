import type { Enricher } from '../../src/packages/activate.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'
import type { PackageReadSource } from '../../src/packages/read-source.ts'
import type { Comment, Enrichment, Media } from '../../src/content/types.ts'
import type { StreamTable } from './streams.ts'

/**
 * 打开一条笔记时现取正文 / 图集 / 视频流 / 评论的那条源（本包的 `xhs-detail` recipe，局部名）。
 *
 * **导出而不是就地写字面量**：它是本包 home / search 两个 feed 源的隐性依赖，那份依赖在 recipe 的
 * `meta.uses` 里申报着；「申报的那个 id 就是这里真调的那个」由 `src/registry/affected-sources.real.test.ts`
 * 钉住——两边各写一份字面量的话，改了一边不会有任何一处报错，只会让「谁被连累」静静少算一条。
 */
export const DETAIL_SOURCE = 'xhs-detail'

/** detail / adapter 共用的两样东西：跑本包源的门（`ctx.readSource`）+ 进程内流地址表。 */
export interface DetailDeps {
  readSource: PackageReadSource
  streams: StreamTable
}

/** 笔记页 `__INITIAL_STATE__` 里的形状（camelCase；签名 feed API 那份是 snake_case）。 */
interface NoteImage {
  urlDefault?: string
  width?: number
  height?: number
}
interface NoteStream {
  masterUrl?: string
  backupUrls?: string[]
}
interface NoteComment {
  id?: string
  content?: string
  likeCount?: number
  createTime?: number
  ipLocation?: string
  userInfo?: { nickname?: string; image?: string }
  subComments?: NoteComment[]
}
export interface NoteDetail {
  noteId?: unknown
  title?: unknown
  desc?: unknown
  author?: unknown
  author_avatar?: unknown
  imageList?: NoteImage[]
  video_stream?: Record<string, NoteStream[]>
  comments?: NoteComment[]
}

/**
 * 第一条带可播地址的流（master，其次 backup）。站方偶尔把流元数据里的签名地址抹空（软性反爬限流）
 * ——那时这里是 null，笔记退化成封面。
 *
 * **键名不写死。** 流按 codec 分组，键是站方自己的代号：活体（2026-09-20）读到的是 `EF4` / `EF5`
 * （`videoCodec` 同值，`EF6` / `EF7` 空数组），早先是 `h264` / `h265`。按固定名单查，站方换一次代号
 * 这里就永远 null、每条视频笔记都静默退化成封面，而没有一处会喊。所以：先看清单里认识的那几个
 * （兼容性最好的排前面），再把其余键按出现顺序扫一遍。
 */
export const PREFERRED_STREAM_CODECS = ['h264', 'EF4', 'h265', 'EF5', 'av1', 'h266'] as const
export function playableUrl(stream: Record<string, NoteStream[]> | undefined): string | null {
  if (!stream) return null
  const order = [...PREFERRED_STREAM_CODECS, ...Object.keys(stream).filter((k) => !(PREFERRED_STREAM_CODECS as readonly string[]).includes(k))]
  for (const codec of order) {
    for (const s of Array.isArray(stream[codec]) ? stream[codec] : []) {
      if (typeof s?.masterUrl === 'string' && s.masterUrl) return s.masterUrl
      const bak = Array.isArray(s?.backupUrls) ? s.backupUrls.find((u) => typeof u === 'string' && u) : undefined
      if (bak) return bak
    }
  }
  return null
}

/** 笔记页评论 → 归一化 Comment；子回复只展开一层（`subComments`）。 */
function mapComment(c: NoteComment): Comment {
  return {
    id: c.id ?? '',
    author: c.userInfo?.nickname,
    avatar: c.userInfo?.image,
    text: c.content ?? '',
    like: c.likeCount ?? 0,
    ip: c.ipLocation,
    time: c.createTime,
    replies: Array.isArray(c.subComments) && c.subComments.length ? c.subComments.map(mapComment) : undefined,
  }
}

/** 一次 xhs-detail 运行读到的那条笔记：原样条目 + 图集 + 可播地址（已顺手登记进 `streams`）。 */
export interface NoteRead {
  it: NoteDetail
  images: Extract<Media, { kind: 'image' }>[]
  videoUrl: string | null
}

/**
 * 跑一次 xhs-detail、挑出要的那条笔记。三个消费方共用：detail enricher、链接抓媒体（`fetch-url.ts`），
 * 以及间接的 xhs-resolve（它只吃这里登记进 `streams` 的流地址）。
 */
export async function readNote(
  noteId: string,
  xsecToken: string,
  deps: DetailDeps,
  signal?: AbortSignal,
): Promise<NoteRead | undefined> {
  const items = await deps.readSource(DETAIL_SOURCE, { noteId, xsec_token: xsecToken }, { signal })
  // 常驻 tab 的状态表里可能带着早先打开过的笔记——优先取要的那条，而不是位置 0。
  const it = (items.find((i) => (i as NoteDetail)?.noteId === noteId) ?? items[0]) as NoteDetail | undefined
  if (!it) return undefined
  const images: Extract<Media, { kind: 'image' }>[] = (Array.isArray(it.imageList) ? it.imageList : [])
    .filter((im) => typeof im?.urlDefault === 'string' && im.urlDefault)
    .map((im) => ({ kind: 'image', url: im.urlDefault as string, w: im.width, h: im.height }))
  const videoUrl = playableUrl(it.video_stream)
  if (videoUrl) deps.streams.set(noteId, videoUrl)
  return { it, images, videoUrl }
}

/**
 * 跑一次 xhs-detail，把它映射成 `Enrichment`。detail enricher 与 xhs-resolve 成员共用这一份：
 * 前者要整个 Enrichment，后者只要顺手写进 `streams` 的那条流地址。
 *
 * feed 卡片只带封面；整套图集与可播的视频流来自第二次签名调用（笔记详情 feed API，只有登录态
 * 页面签得出来）。视频笔记的 media 只带 `(provider, vid)`——流地址**不**烘进 media，而是记进
 * `streams`，由播放时的 xhs-resolve 成员取出、宿主通用播放路由代理（签名 mp4 是 http，服务端取
 * 就没有 mixed-content 的事）。
 *
 * `xsec_token` 缺省是合法的：locate 步先在 feed 账本里找卡片、找到就从 feed 点进去，不需要 token；
 * 找不到才回落整页导航（那条要 token）。
 */
export async function fetchDetail(
  noteId: string,
  xsecToken: string,
  deps: DetailDeps,
  signal?: AbortSignal,
): Promise<Enrichment> {
  const note = await readNote(noteId, xsecToken, deps, signal)
  if (!note) return {}
  const { it, images, videoUrl } = note
  const sourceUrl = `https://www.xiaohongshu.com/explore/${noteId}`
  const text = typeof it.desc === 'string' ? it.desc : undefined
  const comments = (Array.isArray(it.comments) ? it.comments : []).map(mapComment)
  const article: Enrichment['article'] = videoUrl
    ? { sourceUrl, text, media: [{ kind: 'video', provider: 'xhs', vid: noteId, poster: images[0]?.url }] }
    : { sourceUrl, text, media: images }
  return { article, comments, total: comments.length }
}

/** 本包交给宿主的富化处理器：`/api/enrich?source=xhs-detail&noteId=…&xsec_token=…`，
 *  以及 WS 现取协议（`enrich.open`）——后者会带 `signal`，新点击顶掉旧的时把这次运行真的停掉。 */
export function makeDetailEnricher(deps: DetailDeps): Record<string, Enricher> {
  return {
    [DETAIL_SOURCE]: async (q, signal): Promise<Enrichment> => {
      const noteId = q.noteId
      if (!noteId) throw new ValidationError('noteId required')
      // 缺 token 的一跑会落进 fallback-nav、注定拿不到东西，白烧一个限速名额——
      // 这里的调用方是前端，永远带着 token。播放侧（adapter）的 miss 不再现取 detail，只抛「先打开这条笔记」。
      if (typeof q.xsec_token !== 'string' || !q.xsec_token) throw new ValidationError('xsec_token required')
      return fetchDetail(noteId, q.xsec_token, deps, signal)
    },
  }
}
