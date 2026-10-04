import type { TrackRef } from './resolver.ts'
import type { DownloadResolve } from './queue.ts'
import { computeTier } from './quality.ts'
import { mapDownloadItem, type DownloadItem } from './download-item.ts'
import type { ProviderExecutor } from '../providers/executor.ts'
import type { ProviderBindings } from '../providers/bindings.ts'

/**
 * 下载队列解析一条曲目时要用的 Provider 面。**惰性取**，见 `makeResolveDownload` 头注。
 * 用 `Pick` 而不是自己写一份结构类型：那样两边会各自漂移，而漂移的表现是编译期沉默。
 */
export interface DownloadProviderSurface {
  providerExecutor: Pick<ProviderExecutor, 'invoke'>
  providerBindings: Pick<ProviderBindings, 'dispatch'>
}

/** 直链音频的判据：item 自带的 pageUrl 就指着一个音频文件（播客的常态）。 */
const AUDIO = /\.(mp3|m4a|aac|flac|ogg|opus|wav)(\?|$)/i

/**
 * 「这条曲目的可下载网址是什么」——下载队列唯一的解析口。
 *
 * **Provider 面经 thunk 惰性取，不是构造时的实例**：队列住存储域，Provider 执行器住 provider
 * 域，后者在装配序上晚得多。装配期解引用有两种下场，都很坏：TDZ 当场崩，或者（更常见）
 * 闭包抓住一个 `undefined` 之后每次解析静默失败——症状是启动后前几分钟音频下载解析不出网址、
 * 之后自愈、零报错。
 *
 * 所以 thunk 答不出来时**显式抛**而不是回 `{ audio: null }`：后者会被队列当成"这首歌没资源"
 * 记进终态，把一个装配序问题伪装成一条内容缺失。抛出去由队列的 catch 记 `last_error` 并重排，
 * 下一轮 provider 域已经在了，自然就好——但账本上留着"那一次为什么没成"。
 */
export function makeResolveDownload(
  provider: () => DownloadProviderSurface | undefined,
): (ref: TrackRef) => Promise<DownloadResolve> {
  return async (ref) => {
    // 按 platform 派发——和播放侧（`src/audio/track-source.ts`）同一条路：哪家平台由哪条行取，
    // 取决于装了谁的包（行的 serveKeys 里带平台键）。源码不认识任何平台。
    // `fallback:false`：兜底行拿不到"这条曲目怎么下"的语义，落空就该诚实地走下一档。
    // 只有要靠 provider 域取行的那一档（ref 带 id + platform）才需要 provider() 在场；
    // 纯 pageUrl 直链（播客常态）不该被 provider 域是否装载挡住——provider() 拿不到时，
    // 只要还有 pageUrl 这条退路就直接走它，不抛；真正无路可退（既拿不到 provider、
    // 也没有 pageUrl 直链）才抛，交给队列按装配序重排。
    const directLink = ref.pageUrl && AUDIO.test(ref.pageUrl) ? ref.pageUrl : undefined
    if (ref.id && ref.platform) {
      const p = provider()
      if (!p && !directLink) {
        throw new Error('[stream] Provider 执行器还没挂上（provider 域未装载），这一轮下载解析不了')
      }
      if (p) {
        const providerId = p.providerBindings.dispatch('music.track.download', ref.platform, undefined, { fallback: false })
        if (providerId) {
          const res = await p.providerExecutor.invoke(providerId, ref.id)
          const raw = res && res.strategy === 'sequential' ? res.value : null
          const item = (Array.isArray(raw) ? raw[0] : raw) as DownloadItem | null
          const resolved = mapDownloadItem(item)
          // surface the resolve ladder to the debug box even when nothing resolved
          const missReason = new Map((res?.misses ?? []).map((m) => [m.member, m.reason]))
          const rungs = (res?.timings ?? []).map((t) => ({
            member: t.member, ms: t.ms, outcome: t.outcome,
            ...(t.outcome === 'win' ? {} : { reason: missReason.get(t.member) }),
          }))
          const via = res?.strategy === 'sequential' ? (res.via ?? undefined) : undefined
          const tier = item ? computeTier({ format: item.format, bitDepth: item.bitDepth }) : undefined
          return {
            audio: resolved,
            via, tier, rungs,
          }
        }
      }
    }
    if (directLink) {
      return { audio: { url: directLink, format: (directLink.match(AUDIO)?.[1] ?? 'mp3').toLowerCase() } }
    }
    return { audio: null }
  }
}
