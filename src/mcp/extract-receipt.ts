// src/mcp/extract-receipt.ts
//
// extract 交给模型的那份回执 **= 一次投影，不是那条 ConversionRecord 本身**。
//
// ## 为什么必须投影
//
// 库里那条记录是给排查用的：`id` / `inputId` / 四个时间戳 / `timing` 的分阶段墙钟 /
// `ladder` 的梯子明细 / `result.detail.media` 的整份媒体描述符（抖音那条分享链接单条就
// 500+ 字符，加上 poster 签名 URL 又是 300+）。**模型一格都用不上**，而它们每次调用都
// 原样进上下文。
//
// 而这条工具**天生要被调好几次**：转写在跑要轮询，画面文字层在抽还要轮询（见
// extract-frames-layer.ts）。活体 2026-08-30 一轮就调了 5 次——5 份完整记录，其中 4 份
// 连 `result` 都没有，纯粹是一堆 id 和时间戳在刷屏。
//
// 所以：**没落定的那几次只回身份和状态**（几十字节），落定那次才给正文。
//
// ## 留下的每一格都要有消费者
//
// | 格 | 谁在用 |
// |---|---|
// | `status` / `item` | 模型：还要不要再调一次 |
// | `waiting_for` / `note` | 模型：在等什么、现在别下结论（extract-frames-layer.ts） |
// | `snapshot` | 卡片：标题 / 来源 / 缩略图 / 原文链接（`ExtractCard` 的 ItemHead） |
// | `result.text` / `format` / `branch` | 模型读正文；卡片标分支 |
// | `result.digested` / `digest_failed` / `full_text_chars` / `next_step` | 窄回执三格（extract-digest.ts） |
// | `result.detail.segments` | 带时间轴的转写（只有转写分支有；digest 档已被剥掉） |
// | `on_screen_text` | 画面上的字（extract-frames-layer.ts） |
// | `error` | 失败原因 |
// | `unblock` | 模型：这次失败是不是"缺配置"，以及**能不能当场提议补上** |
//
// **加一格之前先回答"谁在用"**——答不出来就是又一份白烧的上下文。全份记录仍在
// `get_conversions({item})`，排查不受影响。
//
// `ladder` 仍然整个剥掉：`unblock` 是它的**结论**，不是它的转发。梯子明细是给排查用的，
// 模型拿到只会照着一堆 member/ms 编故事。

import { unblockOptionsFor, type UnblockOption } from '../auth/unblock.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { LadderTrace } from '../providers/ladder-trace.ts'

/** 投影出来的回执。字段全可选：不同状态给的格子不一样，这正是投影的意义。 */
export interface ExtractReceipt {
  status: string
  item: string
  snapshot?: unknown
  result?: unknown
  on_screen_text?: unknown
  waiting_for?: unknown
  note?: unknown
  error?: unknown
  /**
   * 这次没出结果是因为**缺配置**，而且有一条 recipe 能自助补上。
   *
   * 可以直接问用户要不要现在补——补完这次转换就能成。**别只说"你没配 key"然后收工**：
   * 用户多半根本不知道这个能力可以由你去开通。
   *
   * 不出现 = 没有可自助补的东西（或者失败根本不是缺配置），那就别提。
   */
  unblock?: UnblockOption[]
}

/** `result` 里留下的那几格（其余丢掉——`detail.media` 是大头）。 */
function slimResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result
  const r = result as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['text', 'format', 'branch', 'digested', 'digest_failed', 'full_text_chars', 'next_step']) {
    if (r[k] !== undefined) out[k] = r[k]
  }
  // `detail` 只留时间轴。`detail.media` 是整份媒体描述符（直链 + 签名 poster + 页面地址），
  // 模型读它一个字都不会用到，而它常常比正文还长。
  const detail = r.detail
  if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>
    const kept: Record<string, unknown> = {}
    if (d.segments !== undefined) kept.segments = d.segments
    if (d.lang !== undefined) kept.lang = d.lang
    if (Object.keys(kept).length > 0) out.detail = kept
  }
  return out
}

/**
 * 把一份 extract 回执压成模型面那份。
 *
 * @param receipt - `applyFramesLayer` 之后的那份（可能是 ConversionRecord，也可能是
 *   frames 层合成的「等画面文字」小对象，还可能是 `{status:'error', error}`）。
 *   非对象一律原样退回——这条路上不许抛。
 * @param handle - 这次 extract 的句柄；回执里必须带着它，模型轮询时要照抄。
 * @param manifests - 算 `unblock` 用（`unblockOptionsFor`）。**从入参传进来，不在这里 import
 *   一个全局单例**：那会让这份纯投影变成有依赖的东西，测试就难写了。也**不给默认值**——
 *   一个"缺席就当没有 manifest"的默认参数会让这一格在接错线时静默地永不出现，而那和
 *   "这次失败本来就不是缺配置"长得一模一样。
 */
export function slimExtractReceipt(
  receipt: unknown,
  handle: string,
  manifests: readonly SourceManifest[],
): unknown {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return receipt
  const r = receipt as Record<string, unknown>
  const out: ExtractReceipt = { status: typeof r.status === 'string' ? r.status : 'unknown', item: handle }
  if (r.waiting_for !== undefined) out.waiting_for = r.waiting_for
  if (r.note !== undefined) out.note = r.note
  // 没落定就到此为止：身份 + 状态 +「在等什么」+ 一个**只有名字的** snapshot。
  // 名字留着是因为卡片这一档也要说清"在等哪一条"；`url` / `poster` 不留——那两个签名 URL
  // 加起来 800+ 字符，而这一档每轮都要重来一次，正文却一个字都还没有。
  if (out.status === 'running' || out.status === 'queued') {
    const snap = r.snapshot
    if (typeof snap === 'object' && snap !== null && !Array.isArray(snap)) {
      const s = snap as Record<string, unknown>
      out.snapshot = { ...(s.title !== undefined ? { title: s.title } : {}), ...(s.source !== undefined ? { source: s.source } : {}) }
    }
    return out
  }
  if (r.snapshot !== undefined) out.snapshot = r.snapshot
  if (r.result !== undefined) out.result = slimResult(r.result)
  if (r.on_screen_text !== undefined) out.on_screen_text = r.on_screen_text
  if (r.error !== undefined) out.error = r.error
  // 只在**失败且真有东西可补**时带这一格——回执的既有风格就是按状态给格子。空数组不要出现：
  // 那是一格白烧的上下文，而且会让模型以为"我看过了、没有"从而多说一句废话。
  if (out.status === 'error' && isLadderTrace(r.ladder)) {
    const unblock = unblockOptionsFor(r.ladder, manifests)
    if (unblock.length > 0) out.unblock = unblock
  }
  return out
}

/** 库里读回来的 `ladder` 是 `parseJson` 的产物，可能是老行的 undefined、也可能是别的形状。
 *  验一下再喂给判据——这条路上不许抛。 */
function isLadderTrace(v: unknown): v is LadderTrace {
  return typeof v === 'object' && v !== null && Array.isArray((v as { rungs?: unknown }).rungs)
}
