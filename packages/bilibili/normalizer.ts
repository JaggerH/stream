import type { Normalizer } from '../../src/content/normalize.ts'
import { extractImages, firstLink, stripImages, toText } from '../../shared/package-sdk/html.ts'

/**
 * bilibili dynamic normalizer — classifies a raw RSSHub item into an archetype
 * and extracts typed fields. Rules validated against real /bilibili/user/dynamic data.
 */
export const bilibiliNormalizer: Normalizer = (raw) => {
  const desc = String(raw.description ?? '')
  const title = raw.title ? String(raw.title) : undefined
  const hay = [raw.attachments?.map((a) => a.url).join(' ') ?? '', desc, String(raw.link ?? '')].join(' ')

  // 1. video — rebuild the canonical player.bilibili embed.
  // The video id appears in several shapes across feeds: an attachment player
  // (user/dynamic), the item's own /video/BV link (popular/ranking), or a
  // blackboard html5 iframe carrying an aid= (followings/dynamic). Accept all;
  // id is a bvid ("BV…") when available, else the avid as "av<number>".
  const hasPlayer = raw.attachments?.some((a) =>
    /newplayer\.html|player\.bilibili|html5mobileplayer|bvid=|[?&]aid=/.test(a.url)
  )
  const playerIframe =
    /blackboard\/html5mobileplayer|player\.bilibili\.com\/player/.test(hay) ||
    /\/video\/BV[0-9A-Za-z]+/.test(String(raw.link ?? ''))
  const bv = hay.match(/(?:bvid=|\/video\/)(BV[0-9A-Za-z]+)/)?.[1]
  const aid = hay.match(/[?&]aid=(\d+)/)?.[1]
  const vid = bv ?? (aid ? `av${aid}` : undefined)
  if ((hasPlayer || playerIframe) && vid) {
    const duration_s = raw.attachments?.find((a) => a.duration_in_seconds)?.duration_in_seconds
    const poster = extractImages(desc)[0]?.url
    const text = toText(stripImages(desc).replace(/视频地址[:：].*$/s, '').trim())
    const embedId = bv ? `bvid=${bv}` : `aid=${aid}`
    return {
      archetype: 'video',
      title,
      text: text || undefined,
      media: [
        {
          kind: 'video',
          provider: 'bilibili',
          vid,
          embed: `https://player.bilibili.com/player.html?${embedId}&autoplay=0&high_quality=1`,
          poster,
          duration_s,
          page_url: `https://www.bilibili.com/video/${vid}`,
        },
      ],
    }
  }

  // 2. forward (转发) — own comment + nested quoted post
  if (title === '转发动态' || /\/\/转发自/.test(desc)) {
    const i = desc.indexOf('//转发自')
    const ownRaw = i >= 0 ? desc.slice(0, i) : ''
    const quotedRaw = i >= 0 ? desc.slice(i) : desc
    const qAuthor = quotedRaw.match(/\/\/转发自[:：]?\s*@([^:：<]+)/)?.[1]?.trim()
    const ownText = toText(ownRaw.replace(/^转发动态/, '')).trim()
    const qText = toText(stripImages(quotedRaw).replace(/\/\/转发自[:：]?\s*@[^:：]+[:：]?/, '')).trim()
    return {
      archetype: 'forward',
      text: ownText || undefined,
      quoted: { author: qAuthor, text: qText || undefined, media: extractImages(quotedRaw) },
    }
  }

  // 3. article (专栏 / opus)
  const opus = firstLink(desc, (h) => /\/opus\/|\/read\/cv/.test(h))
  if (opus) {
    const text = toText(stripImages(desc).replace(/专栏地址[:：].*$/s, '').trim())
    return { archetype: 'article', title, text: text || undefined, media: [{ kind: 'link', url: opus, title: '专栏' }] }
  }

  // 4. gallery — image dynamic
  const imgs = extractImages(desc)
  if (imgs.length > 0) return { archetype: 'gallery', title, text: toText(stripImages(desc)) || undefined, media: imgs }

  // 5. text
  return { archetype: 'text', title, text: toText(desc) || undefined }
}
