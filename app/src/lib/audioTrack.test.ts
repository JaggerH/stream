import { describe, it, expect } from 'vitest'
import { toTrack, toTracks, audioResolveUrl, originFallback } from './audioTrack.ts'
import type { Item, Media } from './types.ts'

const BASE = 'http://host:4555'

/** Minimal Item carrying a single audio media entry. */
function audioItem(media: Media): Item {
  return {
    id: 'itm1',
    stream_id: 's1',
    type: 'post',
    title: '雪落成盐(Saltsnow) - 万能日记',
    author: '万能日记',
    content: { archetype: 'audio', media: [media] },
    timestamp: '2026-07-05T20:28:43.274Z',
    fetched_at: '2026-07-05T20:28:43.274Z',
  }
}

/** Parse the query of a rebuilt resolve url for assertions. */
function q(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf('?') + 1))
}

describe('toTrack — resolve route is rebuilt from the (platform, id) reference, never trusted from storage', () => {
  it('form ① NetEase item carrying the RETIRED /api/audio/resolve route → rebuilt onto the live route (the 07-05 breakage)', () => {
    const t = toTrack(
      audioItem({
        kind: 'audio',
        url: '/api/audio/resolve?platform=netease&id=2691870537', // dead route baked at ingest
        platform: 'netease',
        track_id: '2691870537',
        poster: 'https://p2.music.126.net/cover.jpg',
        duration_s: 143,
      }),
      BASE,
    )
    expect(t).not.toBeNull()
    // rebuilt onto the CURRENT endpoint — the dead /api/audio/resolve is gone, no fallback smuggled in
    expect(t!.url).toBe(`${BASE}/api/media/tracks/resolve?platform=netease&id=2691870537`)
    expect(t!.url).not.toContain('/api/audio/resolve')
    expect(q(t!.url).has('fallback')).toBe(false)
    expect(t!.durationS).toBe(143)
  })

  it('form ①b new-normalizer NetEase item (reference only, NO url persisted) → rebuilt from the ref', () => {
    const t = toTrack(
      audioItem({ kind: 'audio', platform: 'netease', track_id: '2691870537', poster: 'https://p/c.jpg', duration_s: 143 }),
      BASE,
    )
    expect(t!.url).toBe(`${BASE}/api/media/tracks/resolve?platform=netease&id=2691870537`)
  })

  it('form ② recognized podcast → origin enclosure salvaged from ?fallback= and re-attached', () => {
    const enclosure = 'https://cdn.lizhi.fm/audio/2024/ep123.mp3?sign=abc'
    const t = toTrack(
      audioItem({
        kind: 'audio',
        url: `/api/media/tracks/resolve?platform=lizhi&id=999&fallback=${encodeURIComponent(enclosure)}`,
        platform: 'lizhi',
        track_id: '999',
      }),
      BASE,
    )
    expect(t).not.toBeNull()
    const params = q(t!.url)
    expect(params.get('platform')).toBe('lizhi')
    expect(params.get('id')).toBe('999')
    // the one genuinely non-derivable datum survives the rebuild, intact
    expect(params.get('fallback')).toBe(enclosure)
  })

  it('form ②b new-normalizer podcast (origin enclosure in url + ref) → route rebuilt, enclosure re-attached', () => {
    // What the normalizer writes since it stopped baking routes: url IS the origin enclosure.
    // The reader must still play through the resolve route (so the netdisk alignment layer can
    // intervene by platform:id) and carry the enclosure as the fallback.
    const enclosure = 'http://cdn5.lizhi.fm/audio/2016/07/04/2543504329178871814_hd.mp3'
    const t = toTrack(
      audioItem({ kind: 'audio', url: enclosure, platform: 'lizhi', track_id: '2543504329178871814' }),
      BASE,
    )
    const params = q(t!.url)
    expect(params.get('platform')).toBe('lizhi')
    expect(params.get('id')).toBe('2543504329178871814')
    expect(params.get('fallback')).toBe(enclosure)
  })

  it('form ③b new-normalizer paid podcast (NO url at all, resolveOnly) → clean rebuild, no fallback', () => {
    const t = toTrack(
      audioItem({ kind: 'audio', platform: 'lizhi', track_id: '888', resolveOnly: true }),
      BASE,
    )
    expect(t!.url).toBe(`${BASE}/api/media/tracks/resolve?platform=lizhi&id=888`)
    expect(q(t!.url).has('fallback')).toBe(false)
  })

  it('form ③ resolveOnly podcast (no enclosure) → clean rebuild, no fallback', () => {
    const t = toTrack(
      audioItem({
        kind: 'audio',
        url: '/api/media/tracks/resolve?platform=lizhi&id=888',
        platform: 'lizhi',
        track_id: '888',
        resolveOnly: true,
      }),
      BASE,
    )
    expect(t!.url).toBe(`${BASE}/api/media/tracks/resolve?platform=lizhi&id=888`)
    expect(q(t!.url).has('fallback')).toBe(false)
  })

  it('direct-url podcast (no platform ref) plays its enclosure as-is (absolute external url, untouched)', () => {
    const t = toTrack(
      audioItem({ kind: 'audio', url: 'https://cdn.example.com/direct-episode.mp3' }),
      BASE,
    )
    expect(t!.url).toBe('https://cdn.example.com/direct-episode.mp3')
  })

  it('root-relative direct url (a backend media route, e.g. netdisk-play) gets the baseUrl prefix — desktop needs this to reach the backend origin', () => {
    const t = toTrack(
      audioItem({ kind: 'audio', url: '/api/media/netdisk-play?path=%2Fquark%2Fep1.mp3' }),
      'http://streamapi.localhost',
    )
    expect(t!.url).toBe('http://streamapi.localhost/api/media/netdisk-play?path=%2Fquark%2Fep1.mp3')
  })

  it('root-relative direct url with an empty baseUrl (same-origin web) stays root-relative — no regression', () => {
    const t = toTrack(
      audioItem({ kind: 'audio', url: '/api/media/netdisk-play?path=%2Fquark%2Fep1.mp3' }),
      '',
    )
    expect(t!.url).toBe('/api/media/netdisk-play?path=%2Fquark%2Fep1.mp3')
  })

  it('item with neither a track ref nor a direct audio url → null', () => {
    const t = toTrack(audioItem({ kind: 'image', url: 'https://x/i.png' }), BASE)
    expect(t).toBeNull()
  })
})

describe('originFallback', () => {
  it('pulls the fallback param out of a resolve route', () => {
    const enc = 'https://cdn.lizhi.fm/e.mp3'
    expect(originFallback(`/api/media/tracks/resolve?platform=lizhi&id=1&fallback=${encodeURIComponent(enc)}`)).toBe(enc)
  })
  it('a plain resolve route (old or new) carries no fallback', () => {
    expect(originFallback('/api/audio/resolve?platform=netease&id=1')).toBeUndefined()
    expect(originFallback('/api/media/tracks/resolve?platform=netease&id=1')).toBeUndefined()
  })
  it('a bare origin url stored beside a ref is treated as the origin', () => {
    expect(originFallback('https://cdn.example.com/ep.mp3')).toBe('https://cdn.example.com/ep.mp3')
  })
  it('undefined → undefined', () => {
    expect(originFallback(undefined)).toBeUndefined()
  })
})

describe('audioResolveUrl', () => {
  it('omits fallback when none given', () => {
    expect(audioResolveUrl(BASE, { platform: 'netease', trackId: '5' })).toBe(
      `${BASE}/api/media/tracks/resolve?platform=netease&id=5`,
    )
  })
  it('appends fallback when given', () => {
    const enc = 'https://c/d.mp3'
    const url = audioResolveUrl(BASE, { platform: 'lizhi', trackId: '7', fallback: enc })
    expect(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('fallback')).toBe(enc)
  })
})

describe('toTrack — platform/trackId passthrough', () => {
  it('carries (platform, trackId) through onto the AudioTrack for a NetEase free song', () => {
    const t = toTrack(
      audioItem({
        kind: 'audio',
        url: '/api/media/tracks/resolve?platform=netease&id=186016',
        platform: 'netease',
        track_id: '186016',
        poster: 'https://p2.music.126.net/cover.jpg',
        duration_s: 143,
      }),
      BASE,
    )
    expect(t?.platform).toBe('netease')
    expect(t?.trackId).toBe('186016')
  })

  it('has no platform/trackId for a direct-url podcast episode', () => {
    const t = toTrack(audioItem({ kind: 'audio', url: 'https://cdn.example.com/ep.mp3' }), BASE)
    expect(t?.platform).toBeUndefined()
    expect(t?.trackId).toBeUndefined()
  })
})

describe('toTrack — queue kind', () => {
  it("defaults to the music queue (Music channel's existing behavior)", () => {
    const t = toTrack(audioItem({ kind: 'audio', url: 'https://cdn.example.com/ep.mp3' }), BASE)
    expect(t?.kind).toBe('music')
  })

  it("routes to the podcast queue when the caller (the timeline) says so", () => {
    const t = toTrack(audioItem({ kind: 'audio', url: 'https://cdn.example.com/ep.mp3' }), BASE, 'podcast')
    expect(t?.kind).toBe('podcast')
  })
})

describe('toTracks — the queue producer over a feed item list', () => {
  const ep = (id: string): Item => ({ ...audioItem({ kind: 'audio', url: `https://cdn.example.com/${id}.mp3` }), id })
  const textItem: Item = { id: 'txt', stream_id: 's1', type: 'post', title: 'no audio here', timestamp: '', fetched_at: '' }

  it('keeps feed order and drops non-playable items, stamping every track with the requested kind', () => {
    const tracks = toTracks([ep('a'), textItem, ep('b')], BASE, 'podcast')
    expect(tracks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(tracks.every((t) => t.kind === 'podcast')).toBe(true)
  })

  it('returns an empty queue for a list with nothing playable', () => {
    expect(toTracks([textItem], BASE, 'podcast')).toEqual([])
  })
})

// AudioTrack 要穿过一串**拿不到 baseUrl** 的消费端（QueueSheet / Navbar 迷你条 /
// SidebarNowPlaying / acrylic 的 audio-player 与 audio-player-stage），到了那儿再想补代理是
// 补不上的——所以封面必须在产出这一刻就是展示就绪的。漏掉的症状是防盗链图床返回一张空白图，
// 不报错、不降级、没有任何一处会喊，所以只能靠这条守着。
describe('toTrack — poster 是展示就绪的（已过图片代理）', () => {
  const cover = 'https://p2.music.126.net/cover.jpg'
  const proxied = `${BASE}/api/media/image?url=${encodeURIComponent(cover)}`

  it('平台曲的封面（audio media 上）过代理', () => {
    const t = toTrack(
      audioItem({ kind: 'audio', platform: 'netease', track_id: '186016', poster: cover }),
      BASE,
    )
    expect(t!.poster).toBe(proxied)
  })

  it('VIP 曲的封面（link media 的 image 上）过代理', () => {
    const t = toTrack(
      audioItem({ kind: 'link', platform: 'netease', track_id: '186016', image: cover, url: 'https://music.163.com/song?id=186016' }),
      BASE,
    )
    expect(t!.poster).toBe(proxied)
  })

  it('播客直链条目的封面过代理', () => {
    const t = toTrack(audioItem({ kind: 'audio', url: 'https://cdn.example.com/ep.mp3', poster: cover }), BASE, 'podcast')
    expect(t!.poster).toBe(proxied)
  })

  it('没有封面就是 undefined，不会拼出一个指向空 url 的代理地址', () => {
    const t = toTrack(audioItem({ kind: 'audio', url: 'https://cdn.example.com/ep.mp3' }), BASE)
    expect(t!.poster).toBeUndefined()
  })
})
