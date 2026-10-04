/**
 * URL-to-content fetch: auto-detect the platform, fetch the content, return
 * normalized media. Powers the stream_fetch_url MCP tool 和 HTTP 门
 * `GET /api/media/from-url`（旧名 `/api/enrich?source=url`：url 和 link 是同义词、产出却毫无
 * 关系，那个名字骗过三个人，所以改叫 media/from-url——门本身不能删，仓库外有消费方在打它）。
 *
 * Supported: 已装包认领的平台（每家站的知识住在它自己的包里，宿主不认识任何站）、
 * 图片 / 视频直链。
 *
 * 先认领、再派发、最后才落宿主分支（spec 2026-09-26-link-recognition §5）：认领函数
 * （`recognizeLinkSync`，吃各包的 `stream.links`）说这条链接是哪个平台，`content.enrich` 调用点按
 * `<platform>-link` 找具名行（`deps.resolveByLink`），命中就整件事交给它；没命中才走下面宿主自己的
 * 直链分支。
 */

import { emitLinkDebug, recognizeLinkSync } from '../links/recognize.ts'

import { SlotBrokenError, type ProviderBindings, type SlotContext } from '../providers/bindings.ts'
import type { ProviderExecutor } from '../providers/executor.ts'
import { providerItems } from '../providers/invoke-types.ts'

// ─── Types ──────────────────────────────────────────────────────────

export interface FetchedMedia {
  kind: 'video' | 'image'
  url: string
  poster?: string
  duration_s?: number
  /** direct-download URL that returns the file bytes */
  download_url?: string
}

export interface FetchUrlResult {
  /** 谁产出的这一条：认领了这个站的那条行自报其名，宿主自己的分支报 `image`/`video`/`unknown`。 */
  platform: string
  title?: string
  author?: string
  author_avatar?: string
  media: FetchedMedia[]
  /** extracted plain text (note body, comment summary, OCR output) */
  text?: string
  /** raw info dump for the caller to inspect */
  raw?: unknown
  /** error message when the fetch itself failed */
  error?: string
}

// ─── Platform detection ────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i
const VIDEO_EXT_RE = /\.(mp4|webm|mov|avi)(\?|$)/i

/** 宿主自己认得的那几档（只有直链）；包认领的平台不在这里——它们在 `resolveByLink` 那一步就被接走了。 */
type Platform = 'image' | 'video' | 'unknown'

function detectPlatform(url: string): Platform {
  if (IMAGE_EXT_RE.test(url)) return 'image'
  if (VIDEO_EXT_RE.test(url)) return 'video'
  return 'unknown'
}

// ─── Direct-link fetchers ──────────────────────────────────────────

async function fetchDirectImage(url: string): Promise<FetchUrlResult> {
  return {
    platform: 'image',
    media: [{ kind: 'image', url }],
  }
}

async function fetchDirectVideo(url: string): Promise<FetchUrlResult> {
  return {
    platform: 'video',
    media: [{ kind: 'video', url }],
  }
}

// ─── Public entry ─────────────────────────────────────────────────

/** `content.enrich` 的派发键：`<platform>-link`，平台来自认领函数。没人认领 → null。 */
export function linkDispatchKeyOf(url: string): string | null {
  const ref = recognizeLinkSync(url)
  return ref ? `${ref.platform}-link` : null
}

/**
 * **兼容层**（spec 2026-09-26-link-recognition §6）：老写法的包把域名直接写进 `serveKeys`
 * （`"<站>.com"`），这里还按老规矩给出那两个键——完整主机，再退一档到 apex（两段标签）。
 * 只在 `<platform>-link` 派发不到时才试，命中会在 debug bus 留痕，好看见还有谁在用老写法。
 * 触发移除的条件记在 docs/TODO.md。
 */
export function legacyHostKeysOf(url: string): string[] {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return [] }
  if (!host) return []
  const parts = host.split('.')
  const apex = parts.length > 2 ? parts.slice(-2).join('.') : host
  return apex === host ? [host] : [host, apex]
}

export interface FetchUrlDeps {
  /**
   * 「有没有哪条具名行认领这条链接」——按 `<platform>-link`（兼容层再按老主机键）问
   * `content.enrich` 调用点。
   *
   * **兜底行那一档不传它**（`src/kernel/plugins/provider.ts` 的 builtin `fetch-url` 成员）：
   * 兜底行自己就是这个函数，传了就是递归。派发侧也已经 `fallback:false`，两道都挡着。
   */
  resolveByLink?: (url: string) => Promise<FetchUrlResult | null>
}

/**
 * 「这条链接有没有具名行认领」——`content.enrich` 按 `<platform>-link` 派发。两个调用方（HTTP 门
 * `/api/media/from-url` 与 MCP `stream_fetch_url`）共用这一份，别各抄一遍。
 *
 * `<platform>-link` 派发不到时再按老主机键（`legacyHostKeysOf`）试一次——已经发到 npm 的旧版包还把
 * 域名写在 `serveKeys` 里；命中就用，并在 debug bus 的 `links` 频道留一条（行 id + 键），看得见还有谁在
 * 用老写法。
 *
 * **`fallback: false`**：兜底行就是 `fetchUrl` 自己，放它进来就是递归。`dispatch` 抛的
 * SlotBrokenError 一路原样上抛（`fetchUrl` 也不接），门面映 422。
 */
export function makeResolveByLink(
  bindings: Pick<ProviderBindings, 'dispatch'>,
  executor: Pick<ProviderExecutor, 'invoke'>,
  ctx: SlotContext | undefined,
): NonNullable<FetchUrlDeps['resolveByLink']> {
  /** 交给一条已派发到的行。交出结果 → 它；认领了却一个成员都没交出结果 → 抛成员原话；什么都没说 → null。 */
  const runRow = async (providerId: string, url: string): Promise<FetchUrlResult | null> => {
    const res = await executor.invoke(providerId, { url })
    // providerItems 统一解三种策略的信封（sequential 的 value / concurrent、expand 的 items），
    // 别手拆——手拆只认 value，并发行会被当成没结果。
    const value = res ? providerItems(res)[0] : undefined
    if (value) return value as FetchUrlResult
    // 认领了却一个成员都没交出结果（超时 / 扩展断了 / 成员抛错）：执行器把失败记成 miss、回空信封。
    // 这里不能当「没人认领」往下落——那会落到宿主兜底那句「不是支持的媒体来源」，把一次暂时失败
    // 说成永久不支持。抛出成员原话，`fetchUrl` 接住映成 `{error}`。
    const miss = res?.misses.find((m) => m.reason)
    if (miss) throw new Error(miss.reason)
    return null
  }
  return async (url) => {
    const key = linkDispatchKeyOf(url)
    const providerId = key ? bindings.dispatch('content.enrich', key, ctx, { fallback: false }) : null
    if (providerId) return runRow(providerId, url)
    for (const legacy of legacyHostKeysOf(url)) {
      const legacyRow = bindings.dispatch('content.enrich', legacy, ctx, { fallback: false })
      if (!legacyRow) continue
      emitLinkDebug({
        key: legacyRow,
        title: '按老主机键派发',
        summary: `行 ${legacyRow} 仍按主机键 ${legacy} 认领 ${url}——声明它的包该发一个带 stream.links 的新版（键改成 <platform>-link）`,
        ok: true,
      })
      const hit = await runRow(legacyRow, url)
      if (hit) return hit
    }
    return null
  }
}

export async function fetchUrl(url: string, deps: FetchUrlDeps): Promise<FetchUrlResult> {
  if (deps.resolveByLink) {
    try {
      const hit = await deps.resolveByLink(url)
      if (hit) return hit
    } catch (e) {
      // 槽位坏了不是「这次抓取失败」，是配置层的事：原样上抛，让门面映成 422（与其他 dispatch 路由一致）。
      if (e instanceof SlotBrokenError) throw e
      // 认领了却失败，和"没人认领"是两件事：前者要把上游原话带出去，后者才该往下走宿主分支。
      return { platform: 'unknown', media: [], error: (e as Error).message }
    }
  }

  switch (detectPlatform(url)) {
    case 'image':
      return fetchDirectImage(url)
    case 'video':
      return fetchDirectVideo(url)
    default:
      // **说出来。** 这里不回空成功（`{platform:'unknown', media:[]}`）：调用方分不清
      // 「这页没有可下载的媒体」和「这个门根本不认识这类地址」——实测助手拿它去读一个
      // GitHub 页面，连打三次、每次拿回空、每次不知道为什么，最后步数用尽也没给出答案。
      // 读网页正文是另一件事，那条路叫 read_url。
      return {
        platform: 'unknown',
        media: [],
        error: '这个地址不是支持的媒体来源（已装包认领的平台 / 图片视频直链）；要读网页正文请用 read_url',
      }
  }
}
