import type { TranscodeCandidate } from '../media/audio-route.ts'
import { netdiskBackendOf, NETDISK_PLAY_SERVING } from './backend.ts'
import type { NetdiskPlayCapability } from './play-capability.ts'

interface Deps {
  netdisk?: { fileId: (path: string) => Promise<string> }
  netdiskPlay?: Pick<NetdiskPlayCapability, 'supports' | 'stream'>
  /** 取档位直链要带的 cookie（夸克缺了就 412）。没有 → 档位仍列出，但拉不动。 */
  credentialProvider?: { cookieString: (domain: string) => Promise<string | null | undefined> }
  /** 有候选连探测都问不出大小时报一声——它们会被判路丢掉、于是回落原盘，这个回落必须可见。 */
  onUnknownSize?: (unknown: number, total: number) => void
}

/**
 * 网盘文件路径 → 它的可播转码档（抽音轨判路里「更小的容器」候选，见 src/media/audio-route.ts）。
 *
 * 和播放走的是**同一次** `netdisk.play` 解析：播放取最好那档，这里问的是「每档多大」。
 * 网盘没有转码能力 / 没登录态 / 解析失败 → 空数组，判路少一类候选而已，不是错误。
 *
 * 候选带上取它所需的请求头——判路选中之后 ffmpeg 要直接拉这条链，凭证必须跟着候选走，
 * 不能让 media/ 那层去认识"夸克要 referer"这种事。
 *
 * 抽成一处是因为有两个调用方（转写管线、`/api/media/netdisk-audio-list` 那个把判决摊开的端点），
 * 而它们必须看到**同一批**候选——否则那个端点报的就不是真正会发生的事。
 */
/**
 * 一条直链**整档**多少字节——网盘没报大小时用它问出来。
 *
 * 为什么必须问：判路 `pickAudioContainer` 只在「大小已知」的候选里比大小，没报大小的候选被
 * 静默丢弃、于是回落原盘。实测代价（`tmdb:261471:S03E01`，夸克按需转码、抽音时转码档还没就绪）：
 * 真实传了 **13.2 GiB 原盘**，而正确答案是那个 **115.6 MiB** 的转码档——**114 倍**。
 *
 * 用 `Range: bytes=0-0` 而不是 HEAD：夸克这类 CDN 对 HEAD 的支持不稳，而 range 是播放本来就要
 * 用的能力。206 读 `content-range` 的总数；服务端无视 range 直接 200 就退回 `content-length`。
 * 任何失败一律返回 undefined——**绝不猜**：转码档并不保证比原盘小（实测 `tmdb:261391:S03E02`
 * 有个 4.1GB 的转码档 > 3.4GB 的原盘），猜错就是把 13GiB 的坑换成 7.6GiB 的坑。
 */
export async function probeContentLength(
  url: string,
  headers: Record<string, string> | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<number | undefined> {
  try {
    const res = await fetchImpl(url, { headers: { ...(headers ?? {}), range: 'bytes=0-0' } })
    if (!res.ok && res.status !== 206) return undefined
    const cr = res.headers.get('content-range')
    const total = cr?.match(/\/(\d+)\s*$/)?.[1]
    if (total) return Number(total)
    const len = res.headers.get('content-length')
    // 200 = 服务端无视了 range，content-length 就是整档
    if (res.status === 200 && len) return Number(len)
    return undefined
  } catch {
    return undefined
  }
}

/** 给没报大小的候选补上真实大小（并发探测）。探不到的保持 undefined —— 继续留在判路之外。 */
export async function fillCandidateSizes(
  candidates: TranscodeCandidate[],
  probe: (url: string, headers?: Record<string, string>) => Promise<number | undefined>
): Promise<TranscodeCandidate[]> {
  return Promise.all(
    candidates.map(async (c) =>
      c.sizeBytes != null ? c : { ...c, sizeBytes: await probe(c.url, c.headers) }
    )
  )
}

export function transcodeCandidatesFor(deps: Deps): (path: string) => Promise<TranscodeCandidate[]> {
  return async (path) => {
    const backend = netdiskBackendOf(path)
    if (!backend || !deps.netdisk || !deps.netdiskPlay?.supports(backend)) return []
    const stream = await deps.netdiskPlay.stream(backend, await deps.netdisk.fileId(path))
    if (!stream?.renditions?.length) return []
    const serving = NETDISK_PLAY_SERVING[backend]
    const cookie = serving ? await deps.credentialProvider?.cookieString(serving.cookieDomain) : undefined
    const headers = serving ? { ...serving.headers, ...(cookie ? { cookie } : {}) } : undefined
    const withHeaders = stream.renditions.map((r) => ({ ...r, headers }))
    // 网盘没报大小的档位在这里问一次真实字节数——否则它们会被判路当作「不可比」丢掉，
    // 一路回落到几 GiB 的原盘（见 probeContentLength 头注里那次 114 倍的实测）。
    const filled = await fillCandidateSizes(withHeaders, (url, h) => probeContentLength(url, h))
    const unknown = filled.filter((c) => c.sizeBytes == null).length
    if (unknown) deps.onUnknownSize?.(unknown, filled.length)
    return filled
  }
}
