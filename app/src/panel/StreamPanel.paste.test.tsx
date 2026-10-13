import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { api } from '../lib/api.ts'
import { detailBundle } from './detailBundle.ts'

// detailBundle.load 换成源码级的 detail-entry（理由见 StreamPanel.test.tsx 顶上那段）。
beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [] })
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
  const detailEntry = await import('./detail-entry.tsx')
  vi.spyOn(detailBundle, 'load').mockResolvedValue(detailEntry)
})

/** jsdom 没有 ClipboardEvent 构造器的 clipboardData，手工挂一个只读的 getData。 */
function paste(target: EventTarget, text: string): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } })
  act(() => { target.dispatchEvent(e) })
  return e
}

test('在页面上粘贴一段带链接的分享文案 → 打开那条的详情', async () => {
  vi.spyOn(api, 'recognizeLink').mockResolvedValue({ url: 'https://www.xiaohongshu.com/explore/1', package: 'p', platform: 'xhs' })
  vi.spyOn(api, 'mediaFromUrl').mockResolvedValue({ platform: 'xhs', title: '周末去哪', text: '正文在这', media: [] })
  render(<StreamPanel />)
  await waitFor(() => expect(api.channelItems).toHaveBeenCalled())

  paste(document.body, '【周末去哪】 http://xhslink.com/a/1，复制本条信息打开小红书')

  await waitFor(() => expect(screen.getByText('正文在这')).toBeTruthy())
  expect(api.recognizeLink).toHaveBeenCalledWith(expect.anything(), 'http://xhslink.com/a/1')
})

test('光标在输入框里时是普通粘贴，不接管', async () => {
  const recognize = vi.spyOn(api, 'recognizeLink')
  render(<StreamPanel />)
  const input = document.createElement('input')
  document.body.appendChild(input)

  const e = paste(input, 'https://example.com/a')

  expect(e.defaultPrevented).toBe(false)
  expect(recognize).not.toHaveBeenCalled()
  input.remove()
})

test('取不到就说出来，不打开空详情', async () => {
  vi.spyOn(api, 'recognizeLink').mockResolvedValue({ url: 'https://www.douyin.com/video/1', package: 'p', platform: 'douyin' })
  vi.spyOn(api, 'mediaFromUrl').mockResolvedValue({ platform: 'unknown', media: [], error: '扩展没连上' })
  render(<StreamPanel />)
  await waitFor(() => expect(api.channelItems).toHaveBeenCalled())

  paste(document.body, 'https://www.douyin.com/video/1')

  await waitFor(() => expect(screen.getByText(/扩展没连上/)).toBeTruthy())
  expect(detailBundle.load).not.toHaveBeenCalled()
})

test('粘贴的不是链接：提示一句', async () => {
  const recognize = vi.spyOn(api, 'recognizeLink')
  render(<StreamPanel />)
  await waitFor(() => expect(api.channelItems).toHaveBeenCalled())

  paste(document.body, '一段普通文字')

  await waitFor(() => expect(screen.getByText('粘贴的内容里没有链接')).toBeTruthy())
  expect(recognize).not.toHaveBeenCalled()
})
