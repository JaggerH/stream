import type { Normalizer } from '../../src/content/normalize.ts'
import type { Media } from '../../src/content/types.ts'
import type { DouyinAweme } from './adapter/douyin-types.ts'

/**
 * 抖音作品 normalizer —— 把 adapter 原样带过来的一条作品映成 Content。作品要么是视频（常态），
 * 要么是图集（`images[]`）。字段路径对着活体 web 响应核过（见 adapter/__fixtures__/aweme.json）。
 *
 * 视频 media 只带身份 `(provider:'douyin', vid:<aweme_id>)` + 页面地址 / 封面 / 时长 / 尺寸，
 * **不烘任何播放地址**：play_addr 是签名 + referer 门禁的 CDN 链接，直接给播放器必死；真正的
 * 播放地址由本包的 resolve 成员在播放那一刻按 `(provider, vid)` 现解，走宿主的通用播放路由。
 * normalizer 里若写死一条路由字符串，路由一改存量内容就全部指向不存在的地址。
 *
 * 作者住 StreamItem.author（与 xhs 等视频平台一致），这里的 Content 有意不带。每个字段都防御
 * 式读取——normalizer 绝不能抛。
 */
export const douyinNormalizer: Normalizer = (raw) => {
  // adapter 把每条 item 归成 { …桥接字段, douyin: <原始作品> }；从那里读作品
  // （没走过 adapter 归一的路径就退回裸 raw）。
  const a = (((raw as { douyin?: DouyinAweme }).douyin ?? raw) as unknown) as DouyinAweme
  const title = a.desc ? String(a.desc) : undefined
  // 搜索结果里的作品没有 share_url；规范的 /video/<id> 地址是 enrich 的键，缺 share_url 时合成它。
  const pageUrl = a.share_url
    ? String(a.share_url)
    : a.aweme_id
      ? `https://www.douyin.com/video/${a.aweme_id}`
      : undefined
  const poster = firstUrl(a.video?.cover) ?? firstUrl(a.video?.origin_cover)

  // 图集（media_type 2 / aweme_type 68）。平台给图文作品**合成**一条幻灯片视频（cover + play_addr），
  // 所以 play_addr 单独不能判成视频——images 列表优先。否则图集会被误送进 <video> 播放器，
  // 而那条幻灯片视频解析必失败（"图片被当视频播"那个 bug）。aweme_type 68 是图文模式的规范
  // 标记，media_type 2 是备用判据。
  const images = (a.images ?? []).map((im) => firstUrl(im)).filter((u): u is string => !!u)
  if (images.length) {
    return { archetype: 'gallery', title, media: images.map((url) => ({ kind: 'image', url })) }
  }
  // 图文模式却没带 images[]（这个接口省掉了）——保留文案当文本，别去播那条加载不出来的幻灯片。
  if (a.media_type === 2 || a.aweme_type === 68) return { archetype: 'text', title }

  // 视频。duration 上游是**毫秒**。
  const duration_s = a.video?.duration ? Math.round(a.video.duration / 1000) : undefined
  // 源视频尺寸（顶层 video.width/height）：让画框首帧就按正确朝向摆好，而不是先按 16:9 再等
  // 封面加载完翻一次。
  const w = pos(a.video?.width)
  const h = pos(a.video?.height)
  // 身份是 aweme_id；没有它就没有可解析的视频（share_url 只是页面地址，不是播放身份）。
  // 有 aweme_id 就一定有 pageUrl（上面合成过），所以只需判 vid。
  const vid = a.aweme_id != null && a.aweme_id !== '' ? String(a.aweme_id) : undefined
  const media: Media[] = vid
    ? [
        {
          kind: 'video',
          provider: 'douyin',
          vid,
          poster,
          duration_s,
          page_url: pageUrl,
          ...(w && h ? { w, h } : {}),
        },
      ]
    : []
  if (media.length) return { archetype: 'video', title, media }

  // 既没有可解析的身份也没有图片 → 降级成文本（文案还在）。
  return { archetype: 'text', title }
}

/** 一个 {url_list} 块的第一个非空地址。 */
function firstUrl(block?: { url_list?: string[] }): string | undefined {
  return block?.url_list?.find((u) => !!u)
}

/** 有限正数，否则 undefined（防御：上游尺寸有时是 0 / 缺失）。 */
function pos(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined
}
