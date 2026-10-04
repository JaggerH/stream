// 网盘音频文件的时长探测。归档器判「这一集源站还在不在」的主证据——标题会被规避字和错编号
// 搅浑，时长是内容自带的、不受命名影响（设计见 docs/TODO.md「下架判定假阳性」那条）。
//
// 只读文件头：ffmpeg 的 HTTP reader 自己做 range 请求，拿到 mp3 的 Xing/Info 帧或 CBR 码率就
// 收工，不会把整集拉下来。探到的值按「路径 + 字节数」缓存——文件没变就永不重探（改了名字但
// 字节数和路径不变的，时长也不会变；真换了文件字节数必变）。
import type Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireMediaTool } from '../../media/ffmpeg-bin.ts'

const exec = promisify(execFile)

/** ffprobe 单次探测的上限。夸克直链偶发 412（凭证过期，见 memory「夸克登录态两类故障签名」），
 *  卡住比探失败更糟——超时即失败，调用方降级成「待定」，绝不因此判下架。 */
const PROBE_TIMEOUT_MS = 30_000

export interface DurationProbe {
  /** 秒，取整。null = 探测失败（凭证/网络/编码问题），调用方必须当「未知」而不是 0。 */
  durationS: number | null
}

/** key 用「路径 + 字节数」：换了内容字节数必变，改了目录路径必变，两者都没变则时长必相同。 */
const cacheKey = (path: string, size: number) => `${size}:${path}`

/** netdisk.db 的 durations 表。行不存在 = 没探过（undefined）；duration_s 为 NULL = 探过但失败
 *  （负缓存，返回 null）——两者的区别是「要不要再探」，不能混。 */
export class DurationCache {
  private readonly byKey: Database.Statement
  private readonly upsert: Database.Statement

  constructor(db: Database.Database) {
    this.byKey = db.prepare('SELECT duration_s FROM durations WHERE key = ?')
    this.upsert = db.prepare('INSERT OR REPLACE INTO durations (key, duration_s) VALUES (?, ?)')
  }
  get(filePath: string, size: number): number | null | undefined {
    const row = this.byKey.get(cacheKey(filePath, size)) as { duration_s: number | null } | undefined
    return row === undefined ? undefined : row.duration_s
  }
  set(filePath: string, size: number, durationS: number | null): void {
    this.upsert.run(cacheKey(filePath, size), durationS)
  }
}

/** 从一个可直接 GET 的 URL 探时长。失败（含超时）一律返回 null，不抛——一条探不到不该掀翻整轮。 */
export async function probeDurationAt(
  url: string,
  run: typeof exec = exec,
  /** 用哪个 ffprobe。缺省走全仓唯一的解析点（`src/media/ffmpeg-bin.ts`）；这台机器上没有它时
   *  解析会抛，被下面的 catch 收成 null——即「探不到」，调用方据此判「待定」，绝不判下架。
   *  单测显式传名字，免得用例的成败取决于开发机上装没装 ffprobe。 */
  bin: () => string = () => requireMediaTool('ffprobe'),
): Promise<number | null> {
  try {
    const { stdout } = await run(
      bin(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url],
      { timeout: PROBE_TIMEOUT_MS },
    )
    const secs = Number(String(stdout).trim())
    return Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null
  } catch {
    return null
  }
}

export interface DurationDeps {
  /** 网盘路径 → 可直接 GET 的直链（AlistClient.rawUrl）。 */
  rawUrl: (path: string) => Promise<string>
  cache: DurationCache
  probe?: (url: string) => Promise<number | null>
  log?: (m: string) => void
}

/** 取一个网盘文件的时长：先查缓存（含「探过但失败」的负缓存），未命中才真探。 */
export async function durationOf(file: { path: string; size: number }, deps: DurationDeps): Promise<number | null> {
  const hit = deps.cache.get(file.path, file.size)
  if (hit !== undefined) return hit
  let durationS: number | null = null
  try {
    durationS = await (deps.probe ?? probeDurationAt)(await deps.rawUrl(file.path))
  } catch {
    durationS = null // 取直链本身就失败（412/对象不存在）——同样只当未知
  }
  if (durationS === null) deps.log?.(`[reconcile] 时长探测失败，按未知处理：${file.path}`)
  deps.cache.set(file.path, file.size, durationS)
  return durationS
}

/**
 * 一次 sync 允许发起的**新**探测上限（缓存命中不计）。绑定同步是同步 HTTP 请求路径——一个
 * 600 集的播客首轮全探会把请求拖到十分钟级。超预算的文件本轮就当"没时长"，走文件名规则链
 * （时长是增强不是替换），缓存只增不减，几轮之后收敛到稳态零探测；归档器每晚扫来源目录时
 * 也在填同一份缓存，实际收敛更快。
 */
export const SYNC_PROBE_BUDGET = 200

/**
 * 一批文件 → 路径 → 时长（秒）。**探不到的不进结果**（未知 ≠ 0，见 DurationProbe 头注）。
 * 逐个串行——探测走网盘直链，并发拉高只会招限流，而缓存命中后整轮几乎不发请求。
 */
export async function durationsFor(
  files: { path: string; size: number }[],
  deps: DurationDeps & { budget?: number },
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const budget = deps.budget ?? Number.POSITIVE_INFINITY
  let fresh = 0
  for (const f of files) {
    if (deps.cache.get(f.path, f.size) === undefined) {
      if (fresh >= budget) continue // 预算用尽：本轮不探，也不当"探过了"落负缓存
      fresh++
    }
    const durationS = await durationOf(f, deps)
    if (durationS !== null) out.set(f.path, durationS)
  }
  return out
}
