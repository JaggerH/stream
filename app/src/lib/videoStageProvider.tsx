/**
 * 视频舞台的**唯一实现**：一个共享的 Artplayer 实例 + 它在卡片/详情之间搬家用的 portal 节点。
 *
 * 这段以前内联在 `App.tsx` 里，绑死在 Stream 自己那一页上。工作台面板跑在**另一个浏览器页面**
 * （另一个 React root），要播放就得自己有一份——而"自己写第二份"是这条线上最贵的选择：
 * 两份播放实现漂移了没有任何一处会报错，而播放的缺陷全是静音的。所以抽成一个 Provider，
 * 两个面各挂一份**实例**、共用同一份**代码**。
 *
 * 不能共用实例、只能共用代码：`<video>` 是一个 DOM 元素，跨页面/跨 React root 本来就搬不过去。
 *
 * 舞台不认识应用外壳：路由、收件箱、频道它一概不知道，只吃 `baseUrl`（解析流地址用）和
 * 「哪一条的详情正开着」（`openId`）。后者是**外面告诉它的**，因为"详情开没开"住在页面自己的
 * 状态里（主应用是 `AppView` 的 detailItem，面板是另一棵树），舞台不该去猜。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ArtPlayer } from '../components/ArtPlayer.tsx'
import { useSpeakerMap } from '../hooks/useSpeakerMap.ts'
import { overlayBlurb } from './blurb.ts'
import { InPortal, createHtmlPortalNode } from './portal.ts'
import type { Item as StreamItem } from './types.ts'
import type { VideoMedia } from './videoPlan.ts'
import { VideoStageContext, type VideoStage } from './videoStage.ts'

export function VideoStageProvider({
  baseUrl,
  openId = null,
  onOpenIdChange,
  children,
}: {
  /** 后端地址：解析 dash/file 流、代理媒体都要它。 */
  baseUrl: string
  /** 哪一条的详情此刻开着——**由挂载方给**（见文件头注）。不给 = 没有"详情态"这个概念，
   *  舞台永远只按内联档渲染（面板就是这一档：它的详情是另一个 React root，不共用实例）。 */
  openId?: string | null
  /** 起播时舞台要把"详情态"清掉（内联播放 ≠ 在详情里播）。`openId` 归挂载方所有，所以这一下
   *  只能回请它改，不能自己改。不给 = 没有详情态可清。 */
  onOpenIdChange?: (id: string | null) => void
  children: ReactNode
}) {
  const [activeVideo, setActiveVideo] = useState<{ item: StreamItem; media: VideoMedia } | null>(null)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null)
  const seekRef = useRef<((seconds: number) => void) | null>(null)

  useEffect(() => setVideoSize(null), [activeVideo?.item.id])

  // 分集人物图谱：与影视频道全屏播放器共用同一份实现（useSpeakerMap），这里不再自持一套。
  const speakerMap = useSpeakerMap(activeVideo?.item.id)
  const { blocks: speakerBlocks, activeSpeakers, names: speakerNames } = speakerMap

  const videoNode = useMemo(
    () => (activeVideo ? createHtmlPortalNode({ attributes: { class: 'h-full w-full' } }) : null),
    [activeVideo?.item.id]
  )
  const stage: VideoStage = useMemo(
    () => ({
      activeId: activeVideo?.item.id ?? null,
      openId,
      node: videoNode,
      videoSize,
      play: (item, media) => {
        onOpenIdChange?.(null)
        setActiveVideo({ item, media })
      },
      stop: () => setActiveVideo(null),
      seek: (seconds) => seekRef.current?.(seconds),
    }),
    [activeVideo?.item.id, openId, videoNode, videoSize, onOpenIdChange]
  )

  return (
    <VideoStageContext.Provider value={stage}>
      {children}
      {/* InPortal 把播放器渲染进一个游离的 DOM 节点，真正显示的位置由 <OutPortal> 决定
          （卡片内联 or 详情里）——所以它摆在 children 后面不影响任何排版。 */}
      {activeVideo && videoNode ? (
        <InPortal node={videoNode}>
          <ArtPlayer
            media={activeVideo.media}
            baseUrl={baseUrl}
            onExpand={() => {}}
            onVideoSize={(w, h) => setVideoSize({ w, h })}
            seekRef={seekRef}
            variant={stage.openId === activeVideo.item.id ? 'default' : 'thumb'}
            speakerBlocks={speakerBlocks}
            activeSpeakers={activeSpeakers}
            speakerNames={speakerNames}
            blurb={overlayBlurb(activeVideo.item)}
          />
        </InPortal>
      ) : null}
    </VideoStageContext.Provider>
  )
}
