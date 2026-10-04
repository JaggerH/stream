import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NowPlayingBar } from './NowPlayingBar.tsx'
import { AudioStageContext, type AudioStage, type AudioTrack } from '../lib/audioStage.ts'
import { AudioTimeContext, createAudioTimeStore } from '../lib/audioTime.ts'
import type { Connection } from '../lib/api.ts'

// api.lyrics resolves to "no match" so the async fetch never mutates state — isolates this test
// to the object-identity bug (the `track` prop passed to AudioPlayerStage), not lyrics fetching.
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return { ...actual, api: { ...actual.api, lyrics: vi.fn(async () => ({ targetType: 'lyrics', key: '', result: null })) } }
})

const capturedTracks: unknown[] = []
vi.mock('./acrylic/audio-player-stage.tsx', () => ({
  AudioPlayerStage: (props: { track: unknown }) => {
    capturedTracks.push(props.track)
    return null
  },
}))
// AudioPlayer only needs to render `actions` so the test can click the "Now Playing" button.
vi.mock('./acrylic/audio-player.tsx', () => ({
  AudioPlayer: (props: { actions?: React.ReactNode }) => <div>{props.actions}</div>,
}))
vi.mock('./QueueSheet.tsx', () => ({ QueueSheet: () => null }))

// A single shared AudioTrack instance: in the real app, `stage.current` is React state that
// keeps the SAME object reference across re-renders until the track actually changes (see
// App.tsx's `audioStage = useMemo(() => ({ current: audioTrack, ... }))`, where `audioTrack`
// only changes via setAudioTrack). Reusing one object here (instead of building a fresh one per
// makeStage() call) is what makes this test faithfully reproduce that — a fresh object per call
// would invalidate `useMemo`'s deps for a reason the real app never has.
const SHARED_TRACK: AudioTrack = { id: 't1', url: 'u', kind: 'music', title: 'T', author: 'A' }

function makeStage(overrides: Partial<AudioStage> = {}): AudioStage {
  return {
    current: SHARED_TRACK, playing: true, duration: 100, activeKind: 'music',
    queues: { music: [SHARED_TRACK], podcast: [] }, queue: [SHARED_TRACK],
    play: vi.fn(), playQueue: vi.fn(), playAt: vi.fn(), toggle: vi.fn(), seek: vi.fn(), stop: vi.fn(),
    getVolume: () => 0.5, setVolume: vi.fn(),
    ...overrides,
  }
}

describe('NowPlayingBar stage track identity', () => {
  it('passes the SAME track object to AudioPlayerStage across re-renders when only the time ticks', async () => {
    capturedTracks.length = 0
    const conn: Connection = { baseUrl: '' }
    const stage = makeStage()
    const store = createAudioTimeStore()

    const { getByLabelText } = render(
      <AudioStageContext.Provider value={stage}>
        <AudioTimeContext.Provider value={store}>
          <NowPlayingBar conn={conn} />
        </AudioTimeContext.Provider>
      </AudioStageContext.Provider>,
    )
    await act(async () => { fireEvent.click(getByLabelText('Now Playing')) })
    expect(capturedTracks).toHaveLength(1)

    // Simulate two more <audio> `timeupdate` ticks — the same song, just the position advancing.
    // `current` (the AudioTrack) is untouched, so the AudioPlayerStage `track` prop it produces
    // should be referentially stable across these re-renders.
    await act(async () => { store.set(1) })
    await act(async () => { store.set(2) })

    expect(capturedTracks.length).toBeGreaterThanOrEqual(3)
    const [first, ...rest] = capturedTracks
    for (const t of rest) expect(t).toBe(first)
  })
})
