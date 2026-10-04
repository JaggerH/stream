import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NowPlayingBar } from './NowPlayingBar.tsx'
import { AudioStageContext, useAudioStage, type AudioStage, type AudioTrack } from '../lib/audioStage.ts'
import { AudioTimeContext, createAudioTimeStore } from '../lib/audioTime.ts'
import type { Connection } from '../lib/api.ts'

vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, api: { ...actual.api, lyrics: vi.fn(async () => ({ targetType: 'lyrics', key: '', result: null })) } }
})

const seenTimes: number[] = []
vi.mock('./acrylic/audio-player.tsx', () => ({
  AudioPlayer: (props: { currentTime: number }) => {
    seenTimes.push(props.currentTime)
    return null
  },
}))
vi.mock('./acrylic/audio-player-stage.tsx', () => ({ AudioPlayerStage: () => null }))
vi.mock('./QueueSheet.tsx', () => ({ QueueSheet: () => null }))

const TRACK: AudioTrack = { id: 't1', url: 'u', kind: 'music', title: 'T', author: 'A' }

const STAGE: AudioStage = {
  current: TRACK, playing: true, duration: 100, activeKind: 'music',
  queues: { music: [TRACK], podcast: [] }, queue: [TRACK],
  play: vi.fn(), playQueue: vi.fn(), playAt: vi.fn(), toggle: vi.fn(), seek: vi.fn(), stop: vi.fn(),
  getVolume: () => 0.5, setVolume: vi.fn(),
}

/** Stands in for every other AudioStage consumer in the app (the music list rows, the timeline
 *  rows, Navbar, the sidebar). It must NOT re-render when playback time advances — that whole-tree
 *  re-render at ~4Hz was the allocation flood behind the "内存只涨不降" report. */
function StageConsumer({ onRender }: { onRender: () => void }) {
  useAudioStage()
  onRender()
  return null
}

describe('playback time is not broadcast through the stage context', () => {
  it('advancing time re-renders the now-playing bar but no other stage consumer', async () => {
    seenTimes.length = 0
    const conn: Connection = { baseUrl: '' }
    const store = createAudioTimeStore()
    const onRender = vi.fn()

    await act(async () => {
      render(
        <AudioStageContext.Provider value={STAGE}>
          <AudioTimeContext.Provider value={store}>
            <StageConsumer onRender={onRender} />
            <NowPlayingBar conn={conn} />
          </AudioTimeContext.Provider>
        </AudioStageContext.Provider>,
      )
    })
    const rendersAfterMount = onRender.mock.calls.length

    await act(async () => { store.set(1.1) })
    await act(async () => { store.set(2.2) })
    await act(async () => { store.set(3.3) })

    expect(onRender.mock.calls.length).toBe(rendersAfterMount)
    expect(seenTimes.at(-1)).toBe(3.3)
  })
})
