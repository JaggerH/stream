import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createHtmlPortalNode } from '../lib/portal.ts'
import { MediaBox } from './acrylic/media-box.tsx'
import { MediaBoxPlayer } from './MediaBoxPlayer.tsx'

class ResizeObserverStub {
  callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    this.callback([{ contentRect: { width: 490 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
    Object.defineProperty(target, 'clientWidth', { value: 490, configurable: true })
  }

  disconnect() {}
}

describe('MediaBox', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Video snaps to a standard 16:9 / 9:16 frame (cover-cropping the poster); the frame sets an
  // inline width + CSS aspect-ratio and derives height from that (no inline height).
  it('snaps a portrait video to a 9:16 frame, capped by videoMaxHeight', () => {
    const { container, rerender } = render(
      <MediaBox kind="video" src="/poster.jpg" naturalWidth={330} naturalHeight={440} maxWidth={520} maxHeight={920} videoMaxHeight={507} />
    )

    // portrait poster -> 9:16 frame; cap 507 -> width 507*9/16 = 285
    const idleBox = container.querySelector('[data-slot="media-box-frame"]') as HTMLElement | null
    expect(idleBox?.style.aspectRatio).toBe('9 / 16')
    expect(idleBox?.style.width).toBe('285px')

    rerender(
      <MediaBox
        kind="video"
        src="/poster.jpg"
        naturalWidth={330}
        naturalHeight={440}
        mediaSize={{ width: 1080, height: 1920 }}
        maxWidth={520}
        maxHeight={920}
        videoMaxHeight={507}
      />
    )

    // real video dims are portrait too -> still a 9:16 frame at 285px
    const playingBox = container.querySelector('[data-slot="media-box-frame"]') as HTMLElement | null
    expect(playingBox?.style.aspectRatio).toBe('9 / 16')
    expect(playingBox?.style.width).toBe('285px')
  })

  it('lets a wide image fill the post width at its own ratio (no letterbox)', () => {
    const { container } = render(<MediaBox src="/wide.jpg" naturalWidth={1350} naturalHeight={1080} />)
    const box = container.querySelector('[data-slot="media-box-frame"]') as HTMLElement | null

    expect(box?.style.width).toBe('490px')
    expect(box?.style.aspectRatio).toBe('1350 / 1080')
  })

  it('caps a tall image height, scaling its width down to 287px', () => {
    const { container } = render(<MediaBox src="/tall.jpg" naturalWidth={1080} naturalHeight={1920} />)
    const box = container.querySelector('[data-slot="media-box-frame"]') as HTMLElement | null

    expect(box?.style.width).toBe('287px')
    expect(box?.style.aspectRatio).toBe('1080 / 1920')
  })

  it('renders the compact thumb player shell', () => {
    const node = createHtmlPortalNode()
    const { container } = render(
      <MediaBoxPlayer node={node} onExpand={() => {}} expandTitle="Expand" />
    )

    expect(container.querySelector('.thumb-player')).toBeTruthy()
    expect(container.querySelector('button')?.getAttribute('title')).toBe('Expand')
    expect(container.querySelector('style')).toBeNull()
  })

  it('clips media and overlays to the rounded upstream frame', () => {
    const { container } = render(<MediaBox src="/poster.jpg" naturalWidth={330} naturalHeight={440} />)
    const frame = container.querySelector('[data-slot="media-box"] > div') as HTMLElement | null

    expect(frame?.className).toContain('overflow-hidden')
    expect(frame?.className).not.toContain('overflow-visible')
  })
})

describe('MediaBox image load retry', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function getImg(container: HTMLElement) {
    const img = container.querySelector('img')
    if (!img) throw new Error('expected an <img> to be in the document')
    return img
  }

  it('does not show the broken-image fallback on the first failed load — it waits to retry', () => {
    const { container } = render(<MediaBox src="https://example.com/a.jpg" maxRetries={2} retryDelayMs={100} />)

    fireEvent.error(getImg(container))

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('remounts a fresh <img> after the backoff delay', () => {
    vi.useFakeTimers()
    const { container } = render(<MediaBox src="https://example.com/a.jpg" maxRetries={2} retryDelayMs={100} />)

    fireEvent.error(getImg(container))
    expect(container.querySelector('img')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(container.querySelector('img')).toBeTruthy()
  })

  it('falls back to the ImageOff placeholder once retries are exhausted', () => {
    vi.useFakeTimers()
    const { container } = render(<MediaBox src="https://example.com/a.jpg" maxRetries={1} retryDelayMs={50} />)

    fireEvent.error(getImg(container)) // attempt 0 -> retry scheduled
    act(() => {
      vi.advanceTimersByTime(50)
    })
    fireEvent.error(getImg(container)) // attempt 1 -> retries exhausted

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('changing src cancels a pending retry and resets to a clean attempt', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <MediaBox src="https://example.com/a.jpg" maxRetries={0} retryDelayMs={100} />
    )

    fireEvent.error(getImg(container))
    expect(container.querySelector('svg')).toBeTruthy()

    rerender(<MediaBox src="https://example.com/b.jpg" maxRetries={0} retryDelayMs={100} />)

    expect(getImg(container).getAttribute('src')).toBe('https://example.com/b.jpg')
    expect(container.querySelector('svg')).toBeNull()
  })
})
