// The timeline's audio branch: an archetype-audio item (a podcast episode) must be PLAYABLE from
// the feed row — not render as a dead cover image (the pre-branch behavior this file pins down).
// The row reads the audio stage through a NULLABLE context: PreviewModal mounts PostItemRow
// OUTSIDE the AudioStageContext provider (same trap the videoStage comment in App.tsx warns
// about), so without a stage the row renders as before, minus the play affordance.
import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { PostItemRow } from './PostItemRow.tsx'
import { AudioStageContext, type AudioStage, type AudioTrack } from '../../lib/audioStage.ts'
import { VideoStageContext, type VideoStage } from '../../lib/videoStage.ts'
import type { Item } from '../../lib/types.ts'

const videoStage: VideoStage = { activeId: null, openId: null, node: null, videoSize: null, play: () => {}, stop: () => {}, seek: () => {} }

function makeStage(over: Partial<AudioStage> = {}): AudioStage {
  return {
    current: null, playing: false, duration: 0, activeKind: 'music',
    queues: { music: [], podcast: [] }, queue: [],
    play: () => {}, playQueue: () => {}, playAt: () => {}, toggle: () => {}, seek: () => {}, stop: () => {},
    getVolume: () => 1, setVolume: () => {},
    ...over,
  }
}

const episode: Item = {
  id: 'ep1',
  stream_id: 'podcast-s1',
  type: 'post',
  title: '第 42 期：过夜任务',
  author: '某播客',
  content: {
    archetype: 'audio',
    media: [{ kind: 'audio', url: 'https://cdn.example.com/ep42.mp3', poster: 'https://cdn.example.com/cover.jpg', duration_s: 3600 }],
  },
  timestamp: '2026-07-22T20:00:00.000Z',
  fetched_at: '2026-07-22T20:00:00.000Z',
}

const rowProps = { last: true, onOpen: () => {} }

const renderRow = (ui: ReactElement, stage: AudioStage | null) =>
  render(
    <VideoStageContext.Provider value={videoStage}>
      {stage ? <AudioStageContext.Provider value={stage}>{ui}</AudioStageContext.Provider> : ui}
    </VideoStageContext.Provider>
  )

describe('PostItemRow — timeline audio branch', () => {
  it('renders a play affordance for an audio item and hands the click to the queue producer', () => {
    const onPlayAudio = vi.fn()
    renderRow(<PostItemRow item={episode} {...rowProps} onPlayAudio={onPlayAudio} />, makeStage())
    const play = screen.getAllByLabelText('播放')[0]
    fireEvent.click(play)
    expect(onPlayAudio).toHaveBeenCalledWith(episode)
  })

  it('falls back to a single-track podcast play on the stage when no producer is wired', () => {
    const play = vi.fn()
    renderRow(<PostItemRow item={episode} {...rowProps} />, makeStage({ play }))
    fireEvent.click(screen.getAllByLabelText('播放')[0])
    expect(play).toHaveBeenCalledTimes(1)
    const track = play.mock.calls[0][0] as AudioTrack
    expect(track.id).toBe('ep1')
    expect(track.kind).toBe('podcast')
    expect(track.url).toBe('https://cdn.example.com/ep42.mp3')
  })

  it('shows a pause control for the currently-playing episode and toggles it', () => {
    const toggle = vi.fn()
    const current: AudioTrack = { id: 'ep1', url: 'https://cdn.example.com/ep42.mp3', kind: 'podcast' }
    renderRow(<PostItemRow item={episode} {...rowProps} />, makeStage({ current, playing: true, activeKind: 'podcast', toggle }))
    fireEvent.click(screen.getAllByLabelText('暂停')[0])
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('renders without a play affordance (and without crashing) outside the AudioStage provider — the PreviewModal mount', () => {
    renderRow(<PostItemRow item={episode} {...rowProps} />, null)
    expect(screen.queryByLabelText('播放')).toBeNull()
    expect(screen.getByText('第 42 期：过夜任务')).toBeDefined()
  })
})
