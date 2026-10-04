import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AuthPanel } from './AuthPanel.tsx'

describe('AuthPanel', () => {
  it('opens the QR modal from the notification centre and shows the QR after re-login', async () => {
    const send = vi.fn()
    // AuthPanel takes injectable transport for testability: initialNeeds + an event bus + send
    const bus = new EventTarget()
    render(<AuthPanel initialNeeds={[]} send={send} subscribe={(cb) => { const h = (e: any) => cb(e.detail); bus.addEventListener('msg', h); return () => bus.removeEventListener('msg', h) }} />)
    bus.dispatchEvent(new CustomEvent('msg', { detail: { type: 'auth-needed', facility: 'xhs', need: { facility: 'xhs', label: '小红书', login: 'qr', since: 't', lastReason: 'r' } } }))
    // Clicking that bell row dispatches `open-auth-panel` — that is what opens the modal.
    bus.dispatchEvent(new CustomEvent('msg', { detail: { type: 'open-auth-panel', facility: 'xhs' } }))
    // Facility label still comes from the tracked need, so the title reads 小红书, not "xhs".
    // Awaiting it also flushes the auth-needed render, so the badge assertions below are not
    // vacuously true (querying before React commits would pass even with the badge present).
    expect(await screen.findByText(/小红书 · 重新登录/)).toBeTruthy()
    // The bell is the ONLY entry point: an auth-needed frame must not paint a second,
    // always-on-screen surface. The same event already reaches the user as a toast + a bell row.
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('登录已失效')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /重新登录/ }))
    expect(send).toHaveBeenCalledWith({ type: 'login-start', facility: 'xhs' })
    bus.dispatchEvent(new CustomEvent('msg', { detail: { type: 'login-challenge', facility: 'xhs', qr: 'data:image/png;base64,AAA' } }))
    expect((await screen.findByAltText(/登录二维码/) as HTMLImageElement).src).toContain('data:image/png;base64,AAA')
  })

  /**
   * 打开面板并送进一张码，返回事件总线，便于继续推第二张。
   *
   * **两次 dispatch 之间必须等一次渲染提交**：面板靠 `selectedRef` 判断这条 challenge 是不是
   * 当前打开的 facility 的，而那个 ref 要等 `open-auth-panel` 引起的 setState 提交之后才更新。
   * 同步连发两条，第二条会被当成"别的 facility 的"丢掉，图永远不出现。
   */
  async function openWithQr(qr = 'data:image/png;base64,AAA') {
    const send = vi.fn()
    const bus = new EventTarget()
    render(<AuthPanel initialNeeds={[]} send={send} subscribe={(cb) => { const h = (e: any) => cb(e.detail); bus.addEventListener('msg', h); return () => bus.removeEventListener('msg', h) }} />)
    bus.dispatchEvent(new CustomEvent('msg', { detail: { type: 'open-auth-panel', facility: 'xhs' } }))
    await screen.findByRole("dialog")
    bus.dispatchEvent(new CustomEvent('msg', { detail: { type: 'login-challenge', facility: 'xhs', qr } }))
    return { bus, send }
  }

  it('平台又要一张码时说清楚「不是你扫错了」', async () => {
    // 活体 2026-07-29：xhs 在第一次扫码之后再压一张（设备/异地验证）。不说这一句，用户只会
    // 对着一张看起来一样的图重复扫，以为是自己的问题。
    const { bus } = await openWithQr()
    expect(await screen.findByAltText(/登录二维码/)).toBeTruthy()
    expect(screen.queryByText(/不是你扫错了/)).toBeNull() // 第一张不该说这句
    bus.dispatchEvent(new CustomEvent('msg', { detail: { type: 'login-challenge', facility: 'xhs', qr: 'data:image/png;base64,BBB', again: true } }))
    expect(await screen.findByText(/请再扫一次（不是你扫错了）/)).toBeTruthy()
    expect((await screen.findByAltText(/登录二维码/) as HTMLImageElement).src).toContain('BBB')
  })

  it('「在浏览器里完成」把标签放到用户面前 —— 渲染不了的验证步骤的唯一明路', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    await openWithQr()
    fireEvent.click(await screen.findByRole('button', { name: /在浏览器里完成/ }))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/facilities/xhs/focus'),
      expect.objectContaining({ method: 'POST' }),
    )
    vi.unstubAllGlobals()
  })

  it('OAuth provider 需要人时展示 hint，而不是当作错误', async () => {
    // src/http/auth-login.ts 把 provider 的每个事件按 login-${kind} 广播，needsHuman → login-needsHuman。
    const { bus } = await openWithQr()
    bus.dispatchEvent(new CustomEvent('msg', { detail: { type: 'login-needsHuman', facility: 'xhs', hint: '浏览器里似乎在等你操作一下（可能是指纹或二次验证）' } }))
    expect(await screen.findByText(/浏览器里似乎在等你操作一下/)).toBeTruthy()
    // 这是引导，不是失败——不该走 setError 那条呈现
    expect(screen.queryByText(/登录失败/)).toBeNull()
  })

  it('还没开登录标签时明确说出来，别让用户以为点了没反应', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409 }) as Response))
    await openWithQr()
    fireEvent.click(await screen.findByRole('button', { name: /在浏览器里完成/ }))
    expect(await screen.findByText(/先点「重新登录」/)).toBeTruthy()
    vi.unstubAllGlobals()
  })
})
