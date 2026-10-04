import { createHash } from 'node:crypto'

// 射手字幕：POST shooter.cn/api/subapi.php，按 filehash 精确查。索引是 2014 年化石，绝大多数返回单字节
// 0xff（无命中）——当免费彩票（spec 2026-07-24-subtitle-scrape-provider-design）。命中即精确可直用。

const SHOOTER_URL = 'https://www.shooter.cn/api/subapi.php'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** 允许取字节的主机后缀（防 SSRF：track id 是客户端透传回来的，可被伪造成任意 URL）。 */
const ALLOWED_HOST_SUFFIXES = ['shooter.cn']

/** 宿主给的「按字节区间读这段视频」的能力（网盘侧是 AList rawUrl + HTTP Range）。 */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>

/** 包交给宿主的一条候选（成员合同见 src/providers/system/subtitle-search.ts）。`id` 就是直链。 */
export interface SubtitleHit {
  id: string
  name: string
  nameHint: 'unknown'
  label: string
}

export function isAllowedShooterHost(url: string): boolean {
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    host = u.hostname.toLowerCase()
  } catch {
    return false
  }
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
}

/**
 * 射手 filehash：4 段各 4096B 的 MD5 hex 用 `;` 连接。偏移（协议固定）：
 *   [4096, floor(size/3*2), floor(size/3), size-8192]
 */
export async function shooterFilehash(read: RangeReader, size: number): Promise<string> {
  const offsets = [4096, Math.floor((size / 3) * 2), Math.floor(size / 3), size - 8192]
  const parts: string[] = []
  for (const o of offsets) {
    const buf = await read(o, 4096)
    parts.push(createHash('md5').update(Buffer.from(buf)).digest('hex'))
  }
  return parts.join(';')
}

interface ShooterHit {
  Delay?: number
  Files?: Array<{ Ext?: string; Link?: string }>
}

/** 按 filehash 查。无命中 / 错误 / 缺 size 或 read → []（静默）。 */
export async function searchShooter(opts: {
  videoFile: string
  size?: number
  read?: RangeReader
  fetchImpl?: typeof fetch
}): Promise<SubtitleHit[]> {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    if (!opts.read || !opts.size || opts.size < 8192) return [] // 没有字节可读 / 太小算不出四段
    const filehash = await shooterFilehash(opts.read, opts.size)
    const form = new URLSearchParams({ filehash, pathinfo: opts.videoFile, format: 'json' })
    const res = await fetchImpl(SHOOTER_URL, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    if (!res.ok) return []
    const raw = Buffer.from(await res.arrayBuffer())
    // 协议约定：单字节 0xff = 无命中。任何非 JSON body 同样视为无命中。
    if (raw.length <= 1) return []
    let hits: ShooterHit[]
    try {
      hits = JSON.parse(raw.toString('utf8')) as ShooterHit[]
    } catch {
      return []
    }
    if (!Array.isArray(hits)) return []
    const out: SubtitleHit[] = []
    let i = 0
    for (const hit of hits) {
      for (const file of hit?.Files ?? []) {
        if (!file?.Link || !isAllowedShooterHost(file.Link)) continue
        // 射手不给文件名，用序号占位；语言等宿主从内容探测。
        out.push({ id: file.Link, name: `射手字幕 ${++i}`, nameHint: 'unknown', label: '射手' })
      }
    }
    return out
  } catch {
    return []
  }
}

/** 按候选 id（直链）取字幕字节。主机不在白名单 → 抛。 */
export async function fetchShooterSubtitle(id: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  if (!isAllowedShooterHost(id)) throw new Error(`[shooter] 拒绝取字节：${id} 不是射手主机`)
  const res = await fetchImpl(id, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`[shooter] subtitle HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
