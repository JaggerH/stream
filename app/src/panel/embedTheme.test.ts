/**
 * 外接面板的明暗推送。钉三个时机（load / 宿主翻转 / 子页来要）都发同一形状的消息，
 * targetOrigin 是 embed URL 的 origin，停止后不再发。
 */
import { afterEach, expect, test, vi } from 'vitest'
import { publishThemeToFrame, THEME_MESSAGE_TYPE, THEME_REQUEST_TYPE } from './embedTheme.ts'
import { HOST_DARK_ATTRIBUTE } from './hostTheme.ts'

const EMBED_URL = 'https://monitor.example.com/?strategy=x'

function mountFrame(): { frame: HTMLIFrameElement; postMessage: ReturnType<typeof vi.fn> } {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const postMessage = vi.fn()
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage }, configurable: true })
  return { frame, postMessage }
}

afterEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute(HOST_DARK_ATTRIBUTE)
})

test('posts the theme to the frame origin on load, host flip and request; stops after cleanup', async () => {
  const { frame, postMessage } = mountFrame()
  const stop = publishThemeToFrame(frame, EMBED_URL)

  // subscribeHostDark 一订阅就回调一次，所以刚挂上就有一发（此时 contentWindow 已在）。
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: THEME_MESSAGE_TYPE, dark: false }),
    'https://monitor.example.com',
  )

  frame.dispatchEvent(new Event('load'))
  expect(postMessage).toHaveBeenCalledTimes(2)

  document.body.setAttribute(HOST_DARK_ATTRIBUTE, '')
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(3))
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: THEME_MESSAGE_TYPE, dark: true, background: expect.any(String) }),
    'https://monitor.example.com',
  )

  window.dispatchEvent(new MessageEvent('message', { data: { type: THEME_REQUEST_TYPE }, source: frame.contentWindow as Window }))
  expect(postMessage).toHaveBeenCalledTimes(4)

  // 别的窗口来的同名消息不理。
  window.dispatchEvent(new MessageEvent('message', { data: { type: THEME_REQUEST_TYPE }, source: window }))
  expect(postMessage).toHaveBeenCalledTimes(4)

  stop()
  frame.dispatchEvent(new Event('load'))
  window.dispatchEvent(new MessageEvent('message', { data: { type: THEME_REQUEST_TYPE }, source: frame.contentWindow as Window }))
  expect(postMessage).toHaveBeenCalledTimes(4)
})

test('an unparsable embed URL publishes nothing', () => {
  const { frame, postMessage } = mountFrame()
  const stop = publishThemeToFrame(frame, 'not a url')
  frame.dispatchEvent(new Event('load'))
  expect(postMessage).not.toHaveBeenCalled()
  stop()
})
