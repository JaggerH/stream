import type { InvokeResult } from '../providers/executor.ts'
import type { SlotContext } from '../providers/bindings.ts'
import type { VideoFormat, VideoResolved } from './play.ts'

/**
 * 「把这个平台的这个 id 解析成可播放的东西」——`video.resolve` 调用点的唯一一条派发 + 调用。
 *
 * 三个消费方共用它：播放/DASH 路由（`src/http/app.ts`）、转写取音轨（`src/transcribe/media.ts`）、
 * 抽帧取画面（`src/media/video-source.ts`）。**别各写各的**：这三处曾经各自拼一遍 dispatch +
 * invoke + 取第一个元素，于是「抽帧那处只会拼一种 id 形状」这类错只在一条路上出现，另外两条
 * 照常好使——两边单看都正常的那种静默错位。
 *
 * `fallback: true` 是保持等价：没有哪条具名行接 `<platform>-video` 时，照旧落 resolve 的兜底行。
 * 派发抛 `SlotBrokenError`（频道槽位填了但全坏）时**照原样抛出去**——那是显式意图坏了，
 * 调用点要把它翻译成 422，不能在这里吞成 null。
 *
 * 可选的第五参 `sink`：调用点想看**这一次**的整份 `InvokeResult`（谁 miss 了、miss 里有没有
 * 「内容不可用」标记）就传一个空对象进来，返回前写进 `sink.last`。返回值 `VideoResolved | null`
 * 里没有这份信息，而三个消费方都要按请求读它：播放路由靠它把"作品被删"和"解析器坏了"分成
 * 404 / 502 两档、并按请求决定记不记 DebugBox（`diag=1` 的复读不记）；转写 / 抽帧靠它把成员的
 * 失败原话抛给调用方（`memberFailureReason`）。横切回调做不到"按请求"，所以这里没有。
 */
export interface VideoResolverDeps {
  executor: { invoke(ref: { category: 'resolve'; key: string } | string, input: unknown): Promise<InvokeResult | null> }
  bindings?: {
    dispatch(callsiteId: string, key: string, ctx: SlotContext | undefined, opts: { fallback: boolean }): string | null
  }
}

export type VideoResolver = (
  platform: string,
  vid: string,
  format: VideoFormat,
  slotCtx?: SlotContext,
  /** 传了就把这一次的 `InvokeResult`（可能为 null：没有行匹配）写进 `sink.last`。 */
  sink?: { last?: InvokeResult | null },
) => Promise<VideoResolved | null>

/** 顺次梯子的第一个解析结果（成员的合同是 `[VideoResolved]`，梯子取第一个元素）。
 *  没人胜出 / 没有行匹配 → null。 */
export function firstResolved(res: InvokeResult | null): VideoResolved | null {
  return res && res.strategy === 'sequential' && Array.isArray(res.value)
    ? ((res.value[0] as VideoResolved) ?? null)
    : null
}

/**
 * 这一次解析里「成员真的失败了」的那句原话——转写 / 抽帧靠它把"作品被删 / 私密"（站方原话）和
 * "解析器坏了"（容器报错）**抛**给调用方，而不是吞成一个说不出理由的 null。
 *
 * 判据是结构字段不是字符串：`unavailable` 优先（站方明确说"这件没有"，`ContentUnavailableError`），
 * 其次任何成员**抛过**的 miss（带 `stack` / `retryable` / `blocked`）。成员 decline（返回 null、
 * 「我没有这个」）不算失败——那才是「没有东西可取」，调用方照旧落 null。没有 miss / 全是 decline
 * → undefined。
 */
export function memberFailureReason(res: InvokeResult | null | undefined): string | undefined {
  const misses = res?.misses ?? []
  const failed = misses.find((m) => m.unavailable)
    ?? misses.find((m) => m.stack !== undefined || m.retryable || m.blocked)
  return failed?.reason || undefined
}

export function makeVideoResolver(deps: VideoResolverDeps): VideoResolver {
  return async (platform, vid, format, slotCtx, sink) => {
    const key = `${platform}-video`
    const providerId = deps.bindings?.dispatch('video.resolve', key, slotCtx, { fallback: true })
    const res = await deps.executor.invoke(providerId ?? { category: 'resolve', key }, { vid, format })
    if (sink) sink.last = res
    return firstResolved(res)
  }
}
