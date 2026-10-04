// src/audio/track-source.ts
//
// **一条音轨的字节该去哪儿取** —— 一份判据，两个消费方。
//
// 消费方一：播放（`GET /api/media/tracks/resolve`）。拿到答案去 302 / 代理 / 404。
// 消费方二：转写取字节（`src/transcribe/media.ts`）。拿到同一个答案去下字节。
//
// 为什么必须是同一份：这四档是**按代价排的**（本地文件 → 网盘直链 → 官方源 → 原始直链），
// 任何一个消费方自己抄一遍，抄漏的那档不会报错，只会安静地退化——2026-08-12 转写那条腿就
// 只抄了「网盘 + 原始直链」两档：已经下到本地的照样跑去 CDN 拉（第 1 档），有官方源的播客
// 直接判成「没有可转写的东西」（第 3 档）。两边单看都正常。
//
// 这里**不认识 HTTP**：不产 Response、不产 302，只回答「去哪儿取」+ 一份观测元数据。
import { existsSync } from 'node:fs'
import { servingPolicyFor } from '../media/serving.ts'
import { resolveRungs, type ResolveRung } from '../providers/ladder-trace.ts'
import type { InvokeResult, InvokeMiss } from '../providers/executor.ts'
import type { PlayableHit } from '../netdisk/types.ts'
import { computeTier } from './quality.ts'

/** 这条音轨的字节在哪儿。四档命中其一，或两种「取不到」。 */
export type TrackSource =
  /** 第 1 档 本地归档：已经下载过了，直接读盘（播放侧 302 到 assets 路由）。 */
  | { kind: 'archive'; absPath: string; format: string; assetId: number }
  /** 第 2 档 网盘绑定：对齐层索引命中 → AList 直链。 */
  | { kind: 'netdisk'; url: string }
  /** 第 3 档 官方 provider 梯子产出。带 `headers` = 上游要 Referer 之类，必须带着请求发。 */
  | { kind: 'stream'; url: string; headers?: Record<string, string> }
  /** 第 4 档 回落 normalizer 带来的原始直链（可能命中 `servingPolicyFor` 的服务策略）。 */
  | { kind: 'fallback'; url: string }
  /** 四档全没有。`detail` 是各档的 miss 原因（播放侧 404 body 用它）。 */
  | { kind: 'unresolved'; detail?: string }
  /** 连梯子都没有（providers 没配）。与 `unresolved` 分开：那是"试过了没有"，这是"根本没得试"，
   *  播放侧一个 404 一个 503。**别合并**——合了就分不出"这台机器没配"和"这条真没有"。 */
  | { kind: 'unavailable'; detail: string }

/** 一次解析的**观测事实**：DebugBox 的 `audio-resolve` 频道逐字段渲染它（entry 的组装留在
 *  路由那侧——那是展示，这里只产事实）。 */
export interface AudioResolveFacts {
  platform: string
  id: string
  outcome: 'archive' | 'resolved' | 'unresolved'
  via?: string
  streamMode: 'archive' | 'redirect' | 'proxy' | 'unresolved'
  urlHost?: string
  format?: string
  bitrate?: number
  bitDepth?: number
  sampleRate?: number
  tier?: number
  requestedLevel?: string
  rungs: ResolveRung[]
  totalResolveMs: number
  archive?: { hasRow: boolean; fileExists: boolean }
  misses?: InvokeMiss[]
}

export interface TrackSourceDeps {
  /** 本地归档索引（第 1 档）。缺 = 这台机器没有归档能力，跳过这一档。 */
  audioArchive?: { lookup(ref: { platform: string; id: string }): { assetId: number; absPath: string; format: string; qualityTier: number } | null }
  /** 网盘对齐层（第 2 档）。resolveUrl 失败 → markError 留痕后**静默**落到下一档。 */
  netdisk?: {
    lookup(leftKey: string): PlayableHit | undefined
    resolveUrl(hit: PlayableHit): Promise<string>
    markError(hit: PlayableHit, message: string): void
  }
  /** 官方源梯子（第 3 档）。缺 = `unavailable`。 */
  providers?: { executor: Pick<import('../providers/executor.ts').ProviderExecutor, 'invoke'> }
  /** 这个 platform 该用哪个 Provider（频道槽位优先）。抛 `SlotBrokenError` 由调用方处置
   *  （播放侧 422）——**别在这里吞**：槽位废是显式错误，不是回落理由。缺省 = 裸 platform 键。 */
  providerFor?: (platform: string) => string | { category: 'resolve'; key: string } | null
}

export interface TrackSourceOpts {
  /** 请求档位。缺省 / `auto` = 不覆盖梯子的 member level；给具体值才覆盖。 */
  quality?: string
  /** normalizer 带来的原始直链（第 4 档）。没有 = 梯子空手就是真的 unresolved。 */
  fallbackUrl?: string
}

export interface ResolvedTrack {
  source: TrackSource
  /** 记进 debug 总线的那条事实。`undefined` = 这一档不记（providers 没配 / 缺 id 的早退）。 */
  debug?: AudioResolveFacts
}

/** 读这条 url 的 host，读不出就 undefined（debug 字段，坏 url 不该让解析失败）。 */
function hostOf(url: string): string | undefined {
  try { return new URL(url).host } catch { return undefined }
}

/** 从赢家 item 上读音质，宽容——item 形状随源而变（目录 enclosure vs 合成型 resolver），
 *  常常只带其中几个字段。别名：常见解析器返回体的字段别名 `br`(bps)/`sr`/`bd`/`type`；format 兜底看
 *  扩展名。诚实——读不到就留 undefined，不猜。 */
export function resolvedQuality(item: Record<string, unknown> | null, url: string): {
  format?: string; bitrate?: number; bitDepth?: number; sampleRate?: number
} {
  const posNum = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const it = item ?? {}
  const extFmt = url.split('?')[0]?.match(/\.([a-z0-9]{2,4})$/i)?.[1]?.toLowerCase()
  const format = (typeof it.format === 'string' && it.format) || (typeof it.type === 'string' && it.type) || extFmt || undefined
  // `br`（常见解析器返回体的字段别名）is bits/s (e.g. 320000); normalize to kbps. A plain `bitrate` is already kbps.
  const brRaw = posNum(it.br)
  const bitrate = posNum(it.bitrate) ?? (brRaw ? (brRaw > 10000 ? Math.round(brRaw / 1000) : brRaw) : undefined)
  return {
    format: typeof format === 'string' ? format.toLowerCase() : undefined,
    bitrate,
    bitDepth: posNum(it.bitDepth) ?? posNum(it.bd),
    sampleRate: posNum(it.sampleRate) ?? posNum(it.sr),
  }
}

/**
 * 这条音轨（`platform` + `id`）此刻该从哪儿取字节。四档顺序**按代价排**，先命中先返回：
 *
 *   1. 本地归档（有行且文件真在）→ `archive`
 *   2. 网盘绑定（leftKey = `platform:id`，正是付费闸门 `paid-playability.ts` 查绑定用的那个键）→ `netdisk`
 *   3. 官方 provider 梯子 → `stream`
 *   4. 调用方给的原始直链 → `fallback`
 *
 * `id` 缺失时前两档没法查（它们按 `platform:id` 索引），梯子也没有输入 → `unresolved`。
 */
export async function resolveTrackSource(
  platform: string,
  id: string | undefined,
  opts: TrackSourceOpts,
  deps: TrackSourceDeps,
): Promise<ResolvedTrack> {
  // 归档探针（miss 时也要留在 entry 上：有行但文件没了 = "明明下过却还在打 CDN" 的铁证）
  let probe: { hasRow: boolean; fileExists: boolean } | undefined
  if (deps.audioArchive && id) {
    const a = deps.audioArchive.lookup({ platform, id })
    probe = { hasRow: !!a, fileExists: !!(a && existsSync(a.absPath)) }
    if (a && probe.fileExists) {
      return {
        source: { kind: 'archive', absPath: a.absPath, format: a.format, assetId: a.assetId },
        debug: {
          platform, id, outcome: 'archive', via: 'archive', streamMode: 'archive',
          format: a.format, tier: a.qualityTier, rungs: [], totalResolveMs: 0, archive: probe,
        },
      }
    }
  }
  // 网盘直链档（archive 之后、官方源之前）。失败静默回落官方源（markError 留痕）。
  if (deps.netdisk && id) {
    const hit = deps.netdisk.lookup(`${platform}:${id}`)
    if (hit) {
      try {
        const url = await deps.netdisk.resolveUrl(hit)
        return {
          source: { kind: 'netdisk', url },
          debug: {
            platform, id, outcome: 'resolved', via: 'alist', streamMode: 'redirect',
            urlHost: hostOf(url), rungs: [], totalResolveMs: 0, archive: probe,
          },
        }
      } catch (e) {
        deps.netdisk.markError(hit, String((e as Error).message))
      }
    }
  }
  if (!deps.providers) return { source: { kind: 'unavailable', detail: 'providers not configured' } }
  if (!id) return { source: { kind: 'unresolved', detail: 'song id required' } }
  // 官方取歌：按 platform 选 resolve Provider（serves 声明分发，业务层不认具体平台/Source）。
  // 命中哪条行由 platform 键决定；播客等无 provider 认领 → 下面 !url 分支走 fallback 回落。
  // 音质：quality 缺省=auto=梯子最高档（不覆盖 member level）；给具体值才覆盖。洞用裸 id 填。
  const quality = opts.quality
  const invokeOpts = quality && quality !== 'auto' ? { overrides: { level: quality } } : undefined
  const startedAt = performance.now()
  const providerId = deps.providerFor?.(platform) ?? { category: 'resolve' as const, key: platform }
  const res = await deps.providers.executor.invoke(providerId, id, invokeOpts)
  const totalResolveMs = Math.round(performance.now() - startedAt)
  // 源成员产出数组（adapter 契约）——顺次结果取首元素。目录路由项带 enclosure_url（无 headers，
  // 直接热链）；合成型 resolver 可带 url + Referer headers（要代理）。
  const raw = res && res.strategy === 'sequential' ? res.value : null
  const item = (Array.isArray(raw) ? raw[0] : raw) as
    | ({ enclosure_url?: string; url?: string; headers?: Record<string, string> } & Record<string, unknown>)
    | null
  const url = item?.enclosure_url ?? item?.url
  // executor ladder → debug rungs (timings ⋈ miss reasons); shared with video-resolve.
  const rungs = resolveRungs(res)
  const requestedLevel = quality || 'auto'
  if (!url) {
    // 没有 resolve Provider 认领这个 platform（或成员全 decline）→ 回落原始直链。通用兜底，
    // 不写死平台名；没有直链才算真的 unresolved。
    const fallback = opts.fallbackUrl
    if (fallback) {
      // 送法查服务策略表（src/media/serving.ts）：表外保持直发；表内改走代理（**看得见**上游的
      // 拒绝，见那份文件头注）。这里只把结论记进 streamMode，怎么送由消费方按 kind 决定。
      return {
        source: { kind: 'fallback', url: fallback },
        debug: {
          platform, id, outcome: 'resolved', via: 'fallback',
          streamMode: servingPolicyFor(fallback) ? 'proxy' : 'redirect',
          urlHost: hostOf(fallback), rungs, totalResolveMs, archive: probe, misses: res?.misses,
        },
      }
    }
    const detail = (res?.misses ?? []).map((m) => `${m.member}: ${m.reason}`).join('; ')
    return {
      source: { kind: 'unresolved', detail: detail || undefined },
      debug: { platform, id, outcome: 'unresolved', streamMode: 'unresolved', requestedLevel, rungs, totalResolveMs, archive: probe, misses: res?.misses },
    }
  }
  const q = resolvedQuality(item, url)
  const headers = item?.headers && Object.keys(item.headers).length > 0 ? item.headers : undefined
  return {
    source: { kind: 'stream', url, ...(headers ? { headers } : {}) },
    debug: {
      platform, id, outcome: 'resolved',
      via: (res?.strategy === 'sequential' ? res.via : undefined) ?? undefined,
      streamMode: headers ? 'proxy' : 'redirect',
      urlHost: hostOf(url),
      ...q, tier: computeTier(q), requestedLevel, rungs, totalResolveMs, archive: probe,
      misses: res?.misses,
    },
  }
}
