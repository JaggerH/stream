import { createContext, useContext } from 'react'
import type { HtmlPortalNode } from 'react-reverse-portal'
import type { VideoMedia } from './videoPlan.ts'
import type { Item } from './types.ts'

/** Coordinates a single shared Artplayer instance that moves between the list card
 *  (inline play) and the detail modal (expanded) via react-reverse-portal — one
 *  `<video>` element, so the thumb→modal handoff continues playback with no reload.
 *
 *  - `activeId`   — the item whose video is currently mounted (inline or in modal)
 *  - `openId`     — the item whose modal is open (so the card hides its OutPortal and
 *                   the modal claims the node — the node can only mount in one place)
 *  - `node`       — the portal node to render via <OutPortal> wherever it should show
 *  - `play/stop`  — start inline playback for an item / tear the player down */
export interface VideoStage {
  activeId: string | null
  openId: string | null
  node: HtmlPortalNode | null
  /** the active stream's real pixel size (cover poster ≠ stream ratio), once known */
  videoSize: { w: number; h: number } | null
  play: (item: Item, media: VideoMedia) => void
  stop: () => void
  /** seek the active player to a timestamp (seconds)。
   *
   *  **当前没有消费方**：唯一那个（详情页转写档的「点一段跳过去」）2026-08-12 已撤销。留着是
   *  因为它是 VideoStage 上唯一的定位手段，删了下一个要跳播的人得从头造。别照着旧注释去找
   *  那个面板——它不在了。 */
  seek: (seconds: number) => void
}

export const VideoStageContext = createContext<VideoStage | null>(null)

export function useVideoStage(): VideoStage {
  const v = useContext(VideoStageContext)
  if (!v) throw new Error('useVideoStage must be used inside <VideoStageContext.Provider>')
  return v
}
