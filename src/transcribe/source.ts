import { extractNetdiskAudio, type ExtractAudioTiming } from '../netdisk/extract-audio.ts'
import { isObjectNotFound } from '../netdisk/alist-client.ts'
import type { PlayableHit } from '../netdisk/types.ts'
import type { TranscodeCandidate } from '../media/audio-route.ts'
import { resolveMediaBytes, type MediaBytes, type MediaDeps } from './media.ts'
import type { Media } from '../content/types.ts'

/**
 * What can be transcribed, named as ONE string.
 *
 *  - `<itemId>`            an inbox item (a video-platform item, xhs video, or a netdisk-bound episode)
 *  - `tmdb:<id>`           a bound movie — NOT an inbox item, has no item id at all
 *  - `tmdb:<id>:S01E01`    a bound episode — likewise
 *
 * The point of naming the *thing* instead of passing a media descriptor: resolution is the
 * resolver's job, not the caller's. Before this, `POST /api/transcripts` and MCP `transcribe`
 * both handed the service a `Media[]` — so only the browser could transcribe a netdisk video,
 * because only the browser had the serve-time-projected resolve url. Everything else got
 * `no transcribable media`. A caller that knows *what* it wants shouldn't have to know *where
 * the bytes live*; adding a new source (a local file, a bare URL) is then a resolver, and the
 * transcribe pipeline doesn't change at all.
 */
export type SourceHandle = string

export interface AudioSourceDeps extends MediaDeps {
  /** read a stored inbox item's media by id. Absent = handles never resolve through the store. */
  getItem?: (id: string) => { content?: { media?: Media[] } } | undefined
  /** report WHY a resolution failed. The return contract stays `null` (one bad episode must not
   *  fail the queue), but a swallowed reason is how an ffmpeg timeout got reported to the user as
   *  "no transcribable media" — a sentence that sends you looking for the wrong bug entirely. */
  onError?: (handle: string, err: unknown) => void
  /** per-phase cost of a netdisk extraction (rawUrl / probe / extract / bytes / MB·s⁻¹). Wired to
   *  the log + debug bus so the cost of transcribing an episode is a measurement, not a guess. */
  onTiming?: (handle: string, t: ExtractAudioTiming) => void
  // transcodeCandidates / audioCache 从 MediaDeps 继承——两条腿（本文件主腿 + media.ts legacy 腿）
  // 必须走同一套判路与缓存，声明收在那一层。
}

/**
 * The netdisk mapping leftKey for a handle. The mapping store already keys movies/episodes as
 * `tmdb:…` and followed-stream items as `item:<id>` — so a handle IS a leftKey, give or take
 * the `item:` prefix a bare item id omits.
 */
export function netdiskKeyFor(handle: SourceHandle): string {
  return handle.includes(':') ? handle : `item:${handle}`
}

/**
 * Resolve a handle to audio bytes for transcription.
 *
 * Order is deliberate: the netdisk binding wins over the item's own media. A followed episode
 * that is bound to a netdisk file should transcribe from that file (a real audio track) rather
 * than from whatever poster-only media the normalizer stored.
 *
 * `mediaHint` lets a caller that already holds resolved media (the player, which posts its
 * gated `item.content.media`) skip a store round-trip. It is a shortcut, never a requirement.
 */
export async function resolveAudioSource(
  handle: SourceHandle,
  mediaHint: Media[] | undefined,
  deps: AudioSourceDeps,
): Promise<MediaBytes | null> {
  // 1. netdisk-bound movie/episode/item → pull the audio track off the bound file.
  //    Extraction is network-heavy (a whole audio track over AList→网盘 range reads) and throws on
  //    a file with no audio track; degrade to null so one bad episode can't fail the queue (same
  //    contract as the proxy branches) — but REPORT the reason, never swallow it silently.
  //
  //    (c) item 入口回退：一部作品可挂多条绑定（一有效一残留）。`lookup` 的单条赢家可能正好是残留的坏
  //    绑定；`lookupAll` 给出同 leftKey 的全部候选（健康排前、broken 排后），逐条试——撞
  //    object-not-found（目录被删/移）就标该条 broken 并换下一条。只有 object-not-found 才换绑：ffmpeg
  //    超时 / 无音轨那类**临时故障**是这一条自己的问题，重试同作品其余绑定无益，就地降级 null。
  //    缺 `lookupAll` 的替身（老 mock / 只握 lookup 的注入）退化成单条候选：与 (b) 前的行为一致。
  const nd = deps.netdisk
  if (nd) {
    const key = netdiskKeyFor(handle)
    let candidates: PlayableHit[]
    if (nd.lookupAll) {
      candidates = nd.lookupAll(key)
    } else {
      const h = nd.lookup(key)
      candidates = h ? [h] : []
    }
    if (candidates.length) {
      let lastErr: unknown
      for (const hit of candidates) {
        const path = `${hit.dirPath}/${hit.rightFile}`
        try {
          const out = await extractNetdiskAudio(nd, path, {
            onTiming: (t) => deps.onTiming?.(handle, t),
            transcodeCandidates: deps.transcodeCandidates && (() => deps.transcodeCandidates!(path)),
            cache: deps.audioCache,
          })
          nd.noteResolveOk?.(hit.setId) // 目录还在、解析成功 → 清除该绑定可能残留的 broken 标记
          return out
        } catch (e) {
          lastErr = e
          nd.noteResolveError?.(hit.setId, e) // object-not-found → 标 broken；临时故障内部忽略
          if (!isObjectNotFound(String((e as Error)?.message ?? e))) break // 临时故障：别拖累同作品其余绑定
          // object-not-found：这条目录真没了 → 换同 leftKey 的下一条绑定重试
        }
      }
      deps.onError?.(handle, lastErr)
      return null // 有绑定候选但全解析失败 → 不回落 item 自带 media（绑定优先，同 (b) 前语义）
    }
  }

  // 2. otherwise it must be an inbox item: use the caller's media if it supplied any, else the
  //    stored media. resolveMediaBytes owns the per-provider branches (douyin proxy, any other
  //    (provider, vid) via resolveVideo), the audio leg（`platform`+`track_id` → 播放那条统一漏斗，见
  //    src/audio/track-source.ts）and the legacy resolve-url form.
  const media = mediaHint ?? deps.getItem?.(handle)?.content?.media
  if (!media) return null
  return resolveMediaBytes(media, deps)
}
