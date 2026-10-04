import type { Normalizer, RawItem } from '../../src/content/normalize.ts'
import type { Content, Media } from '../../src/content/types.ts'
import { DETAIL_SOURCE } from './detail.ts'

/**
 * 小红书笔记的渲染规则。输入是本包几份 recipe 的 MappedItem，字段名统一为
 * `{ title, author, cover|enclosure_url, note_type|is_video, likes, noteId, xsec_token, link, author_avatar }`。
 *
 * feed（`xhs-home` / `xhs-search`）每条只暴露一张封面 + 类型标志（'normal' | 'video'）。整套图集与可播的
 * 视频流**不在 feed 里**——打开笔记时由本包的 detail enricher 现取（`detail.ts`）。所以时间线卡片只画
 * feed 真有的东西：
 *   - 图文笔记 → gallery，一张封面。
 *   - 视频笔记 → archetype 'video'，media `{ provider: 'xhs', vid: noteId, poster: 封面 }`，**没有 url / embed**
 *     → 前端 planVideo() 落 poster 档（显示封面、「源」打开站点页）；播放走通用 `(provider, vid)` 解析，
 *     由本包的 xhs-resolve 成员从 detail 记下的流地址表里取（`adapter.ts` / `streams.ts`）。
 *
 * 每条笔记的 Content 带 `enrich`——告诉前端「打开时去哪现取剩下的」：`{ source: 'xhs-detail',
 * params: { noteId, xsec_token } }`。前端从此不认识本站。两个参数任一缺席就不写 enrich（没有东西可取）；
 * `xsec_token` 没有独立字段时从 `link` 的 query 里抠（feed / search 两份 recipe 都把它拼进了 link）。
 *
 * 到这里的 raw 有**两种形状**，字段名不共用：
 *   - feed / search → 一张 `cover`（或 `enclosure_url`），没有正文。
 *   - detail（`xhs-detail`）→ 整套 `imageList`（每项的显示地址是 `urlDefault`）+ 正文 `desc`，**没有** `cover`。
 * 只读 feed 那套名字会把 detail 笔记的正文和图集全丢掉：没有 `cover` 就落到裸 `{archetype:'text', title}`，
 * 一条 8 张图的笔记渲染成零媒体、零正文。两种形状下面都映射。
 *
 * 作者经 StreamItem.author 走（同其他视频平台），不进 Content。每个字段都防御性读——normalizer 绝不许抛。
 */
export const xhsNormalizer: Normalizer = (raw) => {
  const title = raw.title ? String(raw.title) : undefined
  // 正文：detail 形状带 `desc`。feed 形状没有，所以这里保持 undefined——feed 的渲染因此不变。
  const text = typeof raw.desc === 'string' && raw.desc.trim() ? raw.desc.trim() : undefined
  // 图集：detail 形状带整套 `imageList`（每项显示地址 `urlDefault`）；feed 形状只有一张 `cover`。
  // 没有可用地址的项直接跳过，不发成坏媒体。
  const imageUrls: string[] = Array.isArray(raw.imageList)
    ? (raw.imageList as unknown[]).flatMap((im) => {
        const url = im && typeof im === 'object' ? (im as { urlDefault?: unknown }).urlDefault : undefined
        return typeof url === 'string' && url ? [url] : []
      })
    : []
  // 封面：状态采集映射 `cover`；DOM 采集映射 `enclosure_url`（a.cover img src）。
  const cover =
    (typeof raw.cover === 'string' && raw.cover) ? raw.cover :
    (typeof raw.enclosure_url === 'string' && raw.enclosure_url) ? raw.enclosure_url : undefined
  const pageUrl = typeof raw.link === 'string' && raw.link ? raw.link : undefined
  // 视频标志：状态采集映射 `note_type`（'video'）；DOM 采集映射 `is_video`（.play-icon 的 class 串，非空即视频）。
  const isVideo =
    String(raw.note_type ?? '') === 'video' ||
    (typeof raw.is_video === 'string' && raw.is_video.trim().length > 0)
  const noteId = typeof raw.noteId === 'string' && raw.noteId ? raw.noteId : undefined
  const enrich = enrichOf(raw, noteId, pageUrl)

  let content: Content
  if (isVideo) {
    // detail 没有 `cover`，它的第一张图就是笔记的封面帧。
    const media: Media[] = [
      { kind: 'video', provider: 'xhs', vid: noteId, poster: cover ?? imageUrls[0], page_url: pageUrl },
    ]
    content = { archetype: 'video', title, text, media }
  } else if (imageUrls.length > 0) {
    content = { archetype: 'gallery', title, text, media: imageUrls.map((url) => ({ kind: 'image', url })) }
  } else if (cover) {
    content = { archetype: 'gallery', title, text, media: [{ kind: 'image', url: cover }] }
  } else {
    // 一张图都没有 → 留住正文，别把笔记丢掉
    content = { archetype: 'text', title, text }
  }
  if (enrich) content.enrich = enrich
  return content
}

/** 「打开时去哪现取」：noteId 与 xsec_token 都在手才写——少一个就没有东西可取。 */
function enrichOf(raw: RawItem, noteId: string | undefined, pageUrl: string | undefined): Content['enrich'] {
  if (!noteId) return undefined
  const token = typeof raw.xsec_token === 'string' && raw.xsec_token ? raw.xsec_token : tokenFromLink(pageUrl)
  if (!token) return undefined
  return { source: DETAIL_SOURCE, params: { noteId, xsec_token: token } }
}

/** feed / search 两份 recipe 把 token 拼进了 link 的 query（`xsec_token=…`），字段缺席时从这里抠。 */
function tokenFromLink(link: string | undefined): string | undefined {
  if (!link) return undefined
  try {
    return new URL(link).searchParams.get('xsec_token') || undefined
  } catch {
    return undefined
  }
}
