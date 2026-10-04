import type { IncomingMessage } from 'node:http'
import { createWriteStream } from 'node:fs'
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { owned } from '../http/owned-outbound.ts'

/** 临时目录前缀。孤儿回收按它识别自己的东西，绝不碰别人的临时文件。 */
const TMP_PREFIX = 'stream-prefetch-'

/** 比这更老的预取目录必是孤儿：预取只对 ≤512MiB 的容器做（见 audio-route.ts 的阈值），
 *  4 连接下两三分钟必然落定；一小时还在，只可能是进程死在了半路（OOM-kill / 容器重启——
 *  容器 /tmp 过 restart 不清，只有 recreate 才清）。正常收尾是 finally 里的 cleanup()，
 *  这一道只兜崩溃。 */
const ORPHAN_TTL_MS = 60 * 60 * 1000

/** 每次预取前顺手扫一遍陈年孤儿。best-effort：扫不动不影响本次预取。 */
async function sweepOrphans(parent: string): Promise<void> {
  const names = await readdir(parent).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((n) => n.startsWith(TMP_PREFIX))
      .map(async (n) => {
        const p = join(parent, n)
        const st = await stat(p).catch(() => null)
        if (st && Date.now() - st.mtimeMs > ORPHAN_TTL_MS) await rm(p, { recursive: true, force: true }).catch(() => {})
      }),
  )
}

/**
 * 把一个远端容器**并行分块拉到本地临时文件**，让 ffmpeg 去读本地而不是读远端。
 *
 * 为什么值得：网盘 CDN 是**按连接限速**的，不是带宽不够。实测夸克转码档直链（百花杀 S01E18，
 * 104MiB）同一个 32MiB 区间：
 *
 *     1 条连接 → 1.04 MiB/s      4 条 → 5.29 MiB/s      8 条 → 7.89 MiB/s
 *
 * 近乎线性。而 ffmpeg 直接对着远端流抽音轨只用一条连接，还会把容器**读将近两遍**
 * （实测 200.2MiB / 104.0MiB = 1.92×，估计是在交织的多条音轨间来回 seek）。两个因子叠起来
 * 就是那 100 秒。预取到本地把它们一起消掉：并行拿满带宽，本地重复读不要钱。
 *
 * 出站必须走 `owned`——内嵌 RSSHub 进程级 patch 了 `globalThis.fetch` 和 `node:http`，
 * 无 Referer 时强塞 self-origin Referer，而这条链要带自定 Referer 打网盘 CDN，走错通道就是 412。
 * 见 docs/ARCHITECTURE.md「进程出站 HTTP 归属」。
 */
export interface PrefetchResult {
  /** 落地的本地文件路径，喂给 ffmpeg */
  path: string
  bytes: number
  ms: number
  /** 实际用了几条连接（服务端不认 Range 时退化成 1） */
  connections: number
  /** 用完删掉临时目录。**调用方必须在 finally 里调**，否则临时盘只涨不落。 */
  cleanup: () => Promise<void>
}

export interface PrefetchOpts {
  /** 总字节数。判决那边已经从网盘拿到了（档位 size），不必再 HEAD 一次。 */
  size: number
  /** 取这条链所需的请求头（网盘转码档要 cookie+referer）。 */
  headers?: Record<string, string>
  /**
   * 并发连接数。默认 4：实测 8 条能到 7.9MiB/s、4 条 5.3MiB/s，但这是**别人的 CDN**，
   * 收益已经拿到 5 倍，没必要为剩下那点去顶人家的并发上限。
   */
  connections?: number
  /** 临时文件落在哪。默认系统临时目录。 */
  dir?: string
  signal?: AbortSignal
}

/** 服务端忽略了 Range（回 200 而不是 206）——只有退回单连接整拉才是对的。 */
const NO_RANGE = '[prefetch] no-range'

/** 各段的字节区间 [start, end]（HTTP Range 含右端）。 */
export function chunkRanges(size: number, n: number): Array<[number, number]> {
  if (size <= 0) return []
  const per = Math.ceil(size / n)
  const out: Array<[number, number]> = []
  for (let start = 0; start < size; start += per) out.push([start, Math.min(start + per, size) - 1])
  return out
}

/** 发一个 GET 并跟随重定向（CDN 常见），返回响应流。 */
async function get(
  url: string, headers: Record<string, string> | undefined, signal: AbortSignal | undefined, redirects = 3,
): Promise<IncomingMessage> {
  const u = new URL(url)
  const send = u.protocol === 'https:' ? owned.httpsGet : owned.httpGet
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    send(u, { headers, signal }, resolve).on('error', reject)
  })
  const status = res.statusCode ?? 0
  if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
    res.resume() // 排空重定向 body，socket 才放得掉
    return get(new URL(res.headers.location, u).toString(), headers, signal, redirects - 1)
  }
  return res
}

/** 一段 Range 请求 → 写进本地文件的对应偏移。 */
async function pullRange(
  url: string, [start, end]: [number, number], headers: Record<string, string> | undefined,
  path: string, signal: AbortSignal | undefined,
): Promise<void> {
  const res = await get(url, { ...headers, Range: `bytes=${start}-${end}` }, signal)
  // 206 之外一律不能往偏移里写：回 200 意味着整条流回来了，按段偏移写会把整个文件重复写进
  // 每一段的位置，落一个内容错乱、大小还正确的文件——最难查的那种坏。
  if (res.statusCode !== 206) {
    res.resume()
    throw new Error(res.statusCode === 200 ? NO_RANGE : `[prefetch] range ${start}-${end} 返回 ${res.statusCode}`)
  }
  await pipeline(res, createWriteStream(path, { flags: 'r+', start }))
}

/** 整条流拉一次（服务端不认 Range 时的退路）。 */
async function pullWhole(
  url: string, headers: Record<string, string> | undefined, path: string, signal: AbortSignal | undefined,
): Promise<void> {
  const res = await get(url, headers, signal)
  if (res.statusCode !== 200) {
    res.resume()
    throw new Error(`[prefetch] 整拉返回 ${res.statusCode}`)
  }
  await pipeline(res, createWriteStream(path))
}

/**
 * 并行分块拉一个 URL 到本地临时文件。
 *
 * 服务端不认 Range 就退回单连接整拉——慢，但正确。其余任何失败都会清掉临时目录并抛出，
 * 交给调用方决定是否回落到「直接对着远端流抽」。
 */
export async function prefetchToFile(url: string, opts: PrefetchOpts): Promise<PrefetchResult> {
  const t0 = Date.now()
  const parent = opts.dir ?? tmpdir()
  await sweepOrphans(parent) // 崩溃留下的半截预取（正常收尾在 finally，兜不住 OOM-kill）
  const dir = await mkdtemp(join(parent, TMP_PREFIX))
  const path = join(dir, 'container')
  const cleanup = () => rm(dir, { recursive: true, force: true })
  try {
    // 先把文件撑到目标大小：各段要按偏移并行写，`r+` 要求文件已存在且够长。
    const fh = await open(path, 'w')
    await fh.truncate(opts.size)
    await fh.close()

    const ranges = chunkRanges(opts.size, Math.max(1, opts.connections ?? 4))
    let connections = ranges.length
    // allSettled 而不是 all：要退回整拉时必须等所有段都停笔——一段还在按偏移写、这边就开始
    // 从头重写，会交叉写出一个大小正确、内容错乱的文件。
    const settled = await Promise.allSettled(ranges.map((r) => pullRange(url, r, opts.headers, path, opts.signal)))
    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    if (failures.length) {
      const hard = failures.find((f) => (f.reason as Error).message !== NO_RANGE)
      if (hard) throw hard.reason
      connections = 1
      await pullWhole(url, opts.headers, path, opts.signal) // 'w' 从头写，覆盖所有半成品
    }
    const { size: bytes } = await stat(path)
    return { path, bytes, ms: Date.now() - t0, connections, cleanup }
  } catch (e) {
    await cleanup()
    throw e
  }
}
