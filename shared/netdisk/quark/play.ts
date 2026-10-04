/**
 * Quark's own transcoded playback stream.
 *
 * Why: a netdisk release is a raw remux (AC3/DTS/EAC3 audio, sometimes HEVC video) — the browser
 * plays the picture but not the sound. Quark, however, has already transcoded every video in the
 * drive to progressive **H.264 + AAC MP4** (this is what its own web player uses — hence it has
 * sound). We ask quark for that stream and proxy it to the browser. No transcoding on our side —
 * quark did it; we only relay bytes.
 *
 * The stream URL is short-lived and gated: fetching it needs the user's quark cookie + a
 * `pan.quark.cn` referer (412 otherwise), so the browser can't hit it cross-origin — the backend
 * proxies it (see the /api/media/quark-play route). Cookie-only, no signature — same contract as
 * quark-save; nothing is reverse-engineered.
 *
 * 转码直链**全家 412** 的真因（2026-07-23 活体二分钉死）：CDN 鉴权严格校验 `__puus` 的新鲜度——
 * broker 里的 `__puus` 一过期就全 412（带不带 cookie/referer/UA、curl 还是全套 Chrome 头都一样），
 * 而本文件打的 drive-pc API 容忍旧 `__puus`（code 0 照常返 URL），于是呈现"取链成功、取流被拒"。
 * 判据：同一条 URL 同一 curl，换上新鲜 cookie 立刻 200；出口 IP/头/URL 参数(ud/ct/dfi)全都无关。
 * 自愈路径：用户开一次 pan.quark.cn（页面会刷新 `__puus`）→ 后端下一轮取回 → 零代码改动复活。
 * 所以见到这个签名先查 `__puus` 年龄，别去侦察防盗链参数。
 */
const Q = '?pr=ucpro&fr=pc&uc_param_str='
const DRIVE_PC = 'https://drive-pc.quark.cn/1/clouddrive'
export const QUARK_PLAY_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://pan.quark.cn/',
}

// highest → lowest; we pick the best the account can actually access
const RES_ORDER = ['4k', '2k', 'super', 'high', 'normal', 'low'] as const

export interface QuarkStream {
  url: string
  resolution: string
  width?: number
  audioCodec?: string
  videoCodec?: string
  /**
   * Every rendition quark says is playable, best → cheapest, INCLUDING the one picked above.
   *
   * Playback wants the best; pulling an audio track for transcription wants the cheapest —
   * same API response, opposite ends of the same list. Carried as a field on the play object so
   * the `netdisk.play` callsite keeps its shape (`output: object`) and no second Provider row,
   * callsite, or source has to exist for what is one question asked twice.
   */
  renditions?: QuarkRendition[]
}

/** One playback rendition. `sizeBytes`/`bitrateBps` are present only when quark states them —
 *  the audio-route decision refuses to switch on anything it had to make up (see audio-route.ts). */
export interface QuarkRendition {
  resolution: string
  url: string
  sizeBytes?: number
  bitrateBps?: number
}

export interface QuarkPlayDeps {
  cookieFor: (domain: string) => Promise<string | undefined>
  fetchFn?: typeof fetch
}

/**
 * Resolve a quark file id → its best accessible transcoded stream (H.264 + AAC MP4).
 * Returns null when there is no login, no transcode is ready, or nothing is accessible.
 */
export async function quarkPlayStream(fid: string, deps: QuarkPlayDeps): Promise<QuarkStream | null> {
  const send = deps.fetchFn ?? fetch
  const cookie = await deps.cookieFor('quark.cn')
  if (!cookie) return null
  const res = await send(`${DRIVE_PC}/file/v2/play${Q}`, {
    method: 'POST',
    headers: { ...QUARK_PLAY_HEADERS, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ fid, resolutions: 'normal,low,high,super,2k,4k', supports: 'fmp4' }),
    // 无超时时 drive-pc.quark.cn 挂起会让整条解析永不 settle → 路由的 try/catch 等不到回落。
    signal: AbortSignal.timeout(10000),
  })
  const body = (await res.json().catch(() => ({}))) as {
    code?: number
    data?: { video_list?: Array<Record<string, unknown>> }
  }
  if (body.code !== 0) return null
  const list = body.data?.video_list ?? []
  const usable = list
    .map((v) => ({ v, info: v.video_info as Record<string, unknown> | undefined }))
    .filter((x) => x.v.accessable && x.v.trans_status === 'success' && !!x.info?.url)
  if (!usable.length) return null
  // pick by resolution preference
  const byRes = new Map(usable.map((x) => [String(x.v.resolution), x]))
  const best = RES_ORDER.map((r) => byRes.get(r)).find(Boolean) ?? usable[0]
  if (!best) return null
  const info = best.info as Record<string, unknown>
  const ranked = RES_ORDER.map((r) => byRes.get(r)).filter(Boolean) as typeof usable
  const rest = usable.filter((x) => !ranked.includes(x))
  // 可选字段只在真有值时才铺进去：这份也给 exactOptionalPropertyTypes 的宿主（DSH 插件）编译。
  const audioCodec = (info.audio as Record<string, unknown> | undefined)?.codec
  return {
    url: String(info.url),
    resolution: String(best.v.resolution),
    ...(typeof info.width === 'number' ? { width: info.width } : {}),
    ...(typeof audioCodec === 'string' ? { audioCodec } : {}),
    ...(typeof info.codec === 'string' ? { videoCodec: info.codec } : {}),
    renditions: [...ranked, ...rest].map((x) => toRendition(String(x.v.resolution), x.info!)),
  }
}

/** A positive finite number, else undefined. Quark writes `0` for "not computed" on some
 *  renditions, and a 0-byte estimate would make a 2GB stream look free. */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function toRendition(resolution: string, info: Record<string, unknown>): QuarkRendition {
  const sizeBytes = num(info.size)
  // quark has shipped both spellings over the years; take whichever is there.
  const bitrateBps = num(info.bitrate) ?? num(info.bit_rate)
  return {
    resolution,
    url: String(info.url),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(bitrateBps !== undefined ? { bitrateBps } : {}),
  }
}
