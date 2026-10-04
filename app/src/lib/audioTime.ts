import { createContext, useContext, useSyncExternalStore } from 'react'

/** Playback position, kept OUT of `AudioStage` on purpose.
 *
 *  The <audio> element fires `timeupdate` ~4x/sec. Putting that number in the app-wide
 *  AudioStageContext value re-rendered every consumer — the whole music list, the whole
 *  timeline (~9000 nodes), Navbar, sidebar — four times a second, purely to move a progress
 *  bar nobody else reads. The garbage that churn produced is what made the tab's memory climb
 *  and never visibly drop (measured: 48MB → 125MB while playing, straight back to 46MB on
 *  pause — allocation flood, not a leak).
 *
 *  So time travels on its own subscription channel instead: only components that actually
 *  display it (the now-playing bar) subscribe, and only whole-second changes are published —
 *  the bar's clock is `m:ss` and AudioPlayerStage interpolates its karaoke clock with its own
 *  rAF loop between updates (it resyncs only on jumps > 0.75s), so sub-second fidelity here
 *  buys nothing. Same reasoning that already keeps `volume` in a ref (see audioStage.ts). */
export interface AudioTimeStore {
  /** the last PUBLISHED position in seconds — safe as a useSyncExternalStore snapshot */
  get(): number
  /** feed a raw `timeupdate` position; publishes only when the whole second changes or the
   *  position jumps backwards (a seek, or the reset when a new track loads) */
  set(seconds: number): void
  subscribe(listener: () => void): () => void
}

export function createAudioTimeStore(): AudioTimeStore {
  let published = 0
  const listeners = new Set<() => void>()
  return {
    get: () => published,
    set: (seconds) => {
      if (Math.floor(seconds) === Math.floor(published) && seconds >= published) return
      published = seconds
      for (const l of listeners) l()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const AudioTimeContext = createContext<AudioTimeStore | null>(null)

/** Subscribe to the current playback position. Only call this where the number is actually
 *  rendered — every caller re-renders once per second of playback. */
export function useAudioTime(): number {
  const store = useContext(AudioTimeContext)
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.get : ZERO,
  )
}

const NOOP_SUBSCRIBE = () => () => {}
const ZERO = () => 0
