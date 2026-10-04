import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NotificationBell } from './NotificationBell.tsx'
import { EventsTestProvider, type UiEvent } from './EventsProvider.tsx'

const toastSuccess = vi.fn()
const toastError = vi.fn()
// toast 是「复制到底成没成」的唯一反馈——失败必须看得见，所以这里探的是它被怎么叫的，
// 不是"没抛异常"。裸 import 'sonner' 是禁的，被测代码走 acrylic 那份包装。
vi.mock('./acrylic/sonner.tsx', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
  Toaster: () => null,
}))

const evt = (over: Partial<UiEvent> = {}): UiEvent => ({
  id: 1,
  type: 'plugin.target-miss',
  at: new Date(2026, 7, 19, 14, 32, 5).getTime(),
  title: '插件后端没被唤醒：voiceprint',
  body: '这个插件的容器明明在运行……',
  severity: 'error',
  detail: 'service=voiceprint\nreason=not-awake',
  ...over,
})

/** 打开铃铛面板；返回被点的那一条对应的复制按钮。 */
async function openAndFindCopy(events: UiEvent[], dispatchLocal = vi.fn()) {
  render(
    <EventsTestProvider value={{ events, unread: events.length, dispatchLocal }}>
      <NotificationBell />
    </EventsTestProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '通知' }))
  return await screen.findByRole('button', { name: /复制/ })
}

describe('NotificationBell 复制', () => {
  let written: string[]
  beforeEach(() => {
    written = []
    toastSuccess.mockClear()
    toastError.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { written.push(t); return Promise.resolve() } },
    })
  })

  it('每条通知都能复制出一段自带诊断现场的纯文本', async () => {
    fireEvent.click(await openAndFindCopy([evt()]))
    await waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toContain('2026-08-19 14:32:05')
    expect(written[0]).toContain('插件后端没被唤醒：voiceprint')
    expect(written[0]).toContain('reason=not-awake')
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
  })

  it('点复制不会顺带触发这一行的跳转（整行本身是个可点的 button）', async () => {
    const dispatchLocal = vi.fn()
    const row = evt({ type: 'auth.needed', ref: { kind: 'facility', id: 'xhs' } })
    fireEvent.click(await openAndFindCopy([row], dispatchLocal))
    await waitFor(() => expect(written).toHaveLength(1))
    expect(dispatchLocal).not.toHaveBeenCalled()
  })

  it('intervention.* 事件点开 → onOpenSourceRepair(sourceId)', () => {
    const open = vi.fn()
    render(
      <EventsTestProvider value={{ events: [{ id: 1, type: 'intervention.awaiting', at: 1, title: 'xhs-detail：agent 等你点头', severity: 'warn', ref: { kind: 'stream', id: '@s/xhs/xhs-detail' } }] }}>
        <NotificationBell onOpenSourceRepair={open} />
      </EventsTestProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '通知' }))
    fireEvent.click(screen.getByText(/agent 等你点头/))
    expect(open).toHaveBeenCalledWith('@s/xhs/xhs-detail')
  })

  it('legacyActions=false 时 auth.needed 行是 disabled（独立 root 里没人订阅 dispatchLocal）', () => {
    const dispatchLocal = vi.fn()
    const row = evt({ type: 'auth.needed', ref: { kind: 'facility', id: 'xhs' } })
    render(
      <EventsTestProvider value={{ events: [row], unread: 1, dispatchLocal }}>
        <NotificationBell legacyActions={false} />
      </EventsTestProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '通知' }))
    const rowButton = screen.getByText(row.title).closest('button')!
    expect(rowButton.disabled).toBe(true)
    fireEvent.click(rowButton)
    expect(dispatchLocal).not.toHaveBeenCalled()
  })

  it('剪贴板在非安全上下文整个缺席 → 如实报错，绝不静默', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const btn = await openAndFindCopy([evt()])
    expect(() => fireEvent.click(btn)).not.toThrow()
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toMatch(/复制失败/)
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
