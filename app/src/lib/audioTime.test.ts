import { describe, expect, it, vi } from 'vitest'
import { createAudioTimeStore } from './audioTime.ts'

describe('audio time store', () => {
  it('does not notify for ticks that stay inside the same second', () => {
    const store = createAudioTimeStore()
    store.set(3) // already playing inside second 3
    const seen = vi.fn()
    store.subscribe(seen)

    // <audio> fires timeupdate ~4x/sec; four ticks inside second 3 are one second of playback
    store.set(3.1)
    store.set(3.4)
    store.set(3.7)
    store.set(3.9)

    expect(seen).not.toHaveBeenCalled()
  })

  it('notifies once per whole second crossed', () => {
    const store = createAudioTimeStore()
    const seen = vi.fn()
    store.subscribe(seen)

    store.set(0.5) // still second 0 — the published seed
    store.set(1.2) // → second 1
    store.set(1.8)
    store.set(2.1) // → second 2

    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('notifies on a backwards jump even within the same second (seek / new track reset)', () => {
    const store = createAudioTimeStore()
    store.set(42)
    const seen = vi.fn()
    store.subscribe(seen)

    store.set(0)

    expect(seen).toHaveBeenCalledTimes(1)
    expect(store.get()).toBe(0)
  })

  it('get() returns the last PUBLISHED value so a snapshot never changes without a notification', () => {
    const store = createAudioTimeStore()
    store.set(5)
    const before = store.get()

    store.set(5.4) // same second → no notification, so the snapshot must not move either
    expect(store.get()).toBe(before)

    store.set(6.1)
    expect(store.get()).toBe(6.1)
  })

  it('stops notifying after unsubscribe', () => {
    const store = createAudioTimeStore()
    const seen = vi.fn()
    const off = store.subscribe(seen)
    off()

    store.set(9)

    expect(seen).not.toHaveBeenCalled()
  })
})
