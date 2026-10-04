// 贴文的派生层：一条 Item → 渲染它需要的全部事实（媒体、视频、音频轨、标题、摘要、
// 动作条可见性…）。列表行(PostItemRow)和瀑布流卡片(PostCard)共用这一份——它就是
// "两种布局只有排版不同、其余完全一样"这句话在代码里的落点。各算各的一定会漂。
//
// 它是 hook 不是纯函数：要读 enrichment 缓存(useEnrichmentValue)和音频舞台
// (useAudioStageOptional)。prefetch 的那个 ref 故意留在组件里——它绑的是根节点的元素类型，
// 两种布局的根节点不同。
import { faviconUrl, LOCAL } from './api.ts'
import type { Item as StreamItem } from './types.ts'
import { hasCommentThread } from './enrich.ts'
import type { ItemActionView } from '@item/actions.ts'
import {
  mediaPreviews,
  normalizePostTitle,
  postSummary,
  quotedPost,
  videoDownloadUrl,
  type MediaPreview,
  type QuotedPost,
} from './feedPresent.ts'
import { useAudioStageOptional } from './audioStage.ts'
import { toTrack } from './audioTrack.ts'
import type { AudioTrack } from './audioStage.ts'
import { useEnrichmentValue } from './preload.ts'
import { sourceIconFallbackUrl } from './sourceIcon.ts'
import { playableVideo, type VideoMedia } from './videoPlan.ts'

export interface PostPresentation {
  media: MediaPreview[]
  firstMedia?: MediaPreview
  /** 只有解析出可播放流(dash/file)的才非空——它 gate 的是**内联播放**。 */
  video: VideoMedia | null
  /** 更宽的"这条就是个视频"标志：feed 里的视频(如 xhs)只带封面、流要等打开才解析，
   *  此时 video 是 null，但它必须读作视频而不是普通图片。 */
  isVideoNote: boolean
  audioTrack: AudioTrack | null
  audioPlaying: boolean
  onAudioActivate?: () => void
  /** 有意义的标题，没有则 ''。 */
  title: string
  /** 本帖自己说的话。转发帖的转发语为空时是 ''——那段字归 `quoted` 那半，见 postSummary。 */
  summary: string
  /** 被转发/回复的原帖，两种布局都把它画成引用块。null = 这条不是转发。 */
  quoted: QuotedPost | null
  /** `''` 表示没有头像——用作 `<img src>` 前必须自行判空。 */
  avatar: string
  commentCount?: number
  hasComments: boolean
  videoDl: string
  canDownload: boolean
  /** 这条上的可点动作（包声明、后端投影成 `item.actions`）；空 = 不画动作按钮。 */
  actions: ItemActionView[]
}

export function usePostPresentation(
  item: StreamItem,
  { onPlayAudio }: { onPlayAudio?: (item: StreamItem) => void } = {}
): PostPresentation {
  const preloaded = useEnrichmentValue(item)
  const media = mediaPreviews(item, preloaded?.article)
  const firstMedia = media[0]
  const video = playableVideo(item.content?.media)
  const isVideoNote =
    item.content?.archetype === 'video' || (item.content?.media ?? []).some((m) => m.kind === 'video')
  // 通过 NULLABLE hook 读舞台——PreviewModal 在 provider 外面挂这一层，那里必须照常渲染，
  // 只是没有播放能力。
  const audioStage = useAudioStageOptional()
  const audioTrack = audioStage && !video && !isVideoNote ? toTrack(item, LOCAL.baseUrl, 'podcast') : null
  // 只是 audioPlaying 和 onAudioActivate 的中间量，不进返回值——没有消费者的字段会让读的人
  // 以为"外面有人靠它做判断"，而 audioPlaying 已经把这件事说完了。
  const audioCurrent = !!audioTrack && audioStage?.current?.id === item.id
  const audioPlaying = audioCurrent && !!audioStage?.playing
  const onAudioActivate =
    !audioTrack || !audioStage
      ? undefined
      : () => {
          if (audioCurrent) audioStage.toggle()
          else if (onPlayAudio) onPlayAudio(item)
          else audioStage.play(audioTrack)
        }
  const title = normalizePostTitle(item)
  const summary = postSummary(item, preloaded?.article)
  const quoted = quotedPost(item)
  // 头像三级回退：真实作者头像 → 订阅源品牌图标（域名先取后端投影的 source_site——包的 homepage，
  // 没有再查 SOURCE_META 静态表；同源所有行共享同一个
  // URL → 浏览器缓存真正命中，每源 1 次请求；表里全是合法域名，不会像 item.url 那样是相对路径
  // 打到 /api/media/image 上成片 404）→ 内容页 favicon（仅绝对 URL，见 faviconUrl 自身的防御）。
  const avatar =
    item.author_avatar ||
    sourceIconFallbackUrl(item.stream_id, undefined, item.source_site?.domain) ||
    faviconUrl(LOCAL.baseUrl, item.url)
  const commentCount = item.comment_count ?? preloaded?.total
  const hasComments = hasCommentThread(item) || typeof commentCount === 'number'
  const downloadName =
    item.title?.trim() || (typeof item.author === 'string' ? item.author : '') || 'download'
  const videoDl = videoDownloadUrl(video, LOCAL.baseUrl, downloadName)
  const canDownload = !!videoDl

  return {
    // playableVideo/faviconUrl return `| undefined`; the interface commits to `null`/`string`
    // (a nicer contract for consumers) — coalesce here only, at the boundary. Both undefined and
    // null/'' are falsy, so every existing `!video` / `avatar ?` check downstream is unaffected.
    media, firstMedia, video: video ?? null, isVideoNote,
    audioTrack, audioPlaying, onAudioActivate,
    title, summary, quoted, avatar: avatar ?? '', commentCount, hasComments,
    videoDl, canDownload, actions: item.actions ?? [],
  }
}
