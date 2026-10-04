import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { applyEvent, EventsProvider, useEvents, type UiEvent } from './EventsProvider.tsx'

const ev = (id: number, title: string): UiEvent => ({ id, type: 't', at: id, title, severity: 'info' })

describe('applyEvent', () => {
  it('prepends new events (newest first)', () => {
    expect(applyEvent([ev(1, 'a')], ev(2, 'b')).map((e) => e.id)).toEqual([2, 1])
  })
  it('a refreshed duplicate replaces its old row and moves to the top', () => {
    const out = applyEvent([ev(2, 'b'), ev(1, 'a')], { ...ev(1, 'a2') })
    expect(out.map((e) => e.id)).toEqual([1, 2])
    expect(out[0].title).toBe('a2')
  })
  it('caps at 200', () => {
    const list = Array.from({ length: 200 }, (_, i) => ev(i + 1, `e${i}`))
    expect(applyEvent(list, ev(999, 'new'))).toHaveLength(200)
  })
})

let onMessage: (m: unknown) => void = () => {}
vi.mock('../hooks/useWs.ts', () => ({
  useWs: (_url: string, cb: (m: unknown) => void) => {
    onMessage = cb
    return () => {}
  },
}))
vi.mock('./acrylic/sonner.tsx', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

describe('transcribe.done / transcribe.error toast suppression', () => {
  it('转成文字已经流进对话框的 ToolCard，不该再弹 sonner toast——但仍落进 bell', async () => {
    let unread = -1
    function Probe() {
      unread = useEvents().unread
      return null
    }
    render(
      <EventsProvider>
        <Probe />
      </EventsProvider>,
    )
    const { toast } = await import('./acrylic/sonner.tsx')

    act(() => onMessage({ type: 'event', event: { id: 1, type: 'transcribe.done', at: 1, title: '转成文字完成', severity: 'info' } }))
    expect(toast.success).not.toHaveBeenCalled()

    act(() => onMessage({ type: 'event', event: { id: 2, type: 'transcribe.error', at: 2, title: '转成文字失败', severity: 'error' } }))
    expect(toast.error).not.toHaveBeenCalled()

    act(() => onMessage({ type: 'event', event: { id: 3, type: 'harvest.error', at: 3, title: '抓取失败', severity: 'error' } }))
    expect(toast.error).toHaveBeenCalledTimes(1)

    expect(unread).toBe(3) // 三条都进了 bell，只是前两条不弹 toast
  })
})
