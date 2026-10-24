import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

// —— 认领的视频链接：先问一句（转写 / 下载 / 仅看），面板不做意图猜测 ——

/** 抖音视频那一路的桩：认领 + from-url 带回可下载的视频媒体。 */
function mockDouyinVideo() {
  vi.spyOn(api, 'recognizeLink').mockResolvedValue({ url: 'https://www.douyin.com/video/1', package: 'p', platform: 'douyin' })
  vi.spyOn(api, 'mediaFromUrl').mockResolvedValue({
    platform: 'douyin',
    title: '一条抖音',
    author: '某作者',
    media: [{ kind: 'video', url: 'https://cdn.test/x.mp4', poster: 'https://cdn.test/p.jpg' }],
  })
  // 转写按钮亮不亮读能力发现（stt 可用）；详情树开档要查一次缓存（默认没有）。
  vi.spyOn(api.conversions, 'kinds').mockResolvedValue({ items: [{ kind: 'extract', branches: { stt: true } }] } as never)
  vi.spyOn(api.conversions, 'latest').mockResolvedValue(null)
}

/** 详情 bundle 换成只记 opts 的假件：这里验「递过去什么」，详情自己画什么在 PanelDetail 那边。 */
function fakeDetailBundle() {
  const mountSpy = vi.fn()
  vi.spyOn(detailBundle, 'load').mockResolvedValue({ mount: mountSpy, unmount: vi.fn() })
  return mountSpy
}

test('认领的视频 → 弹确认框；点「转成文字」→ 详情带 autoExtract', async () => {
  mockDouyinVideo()
  const mountSpy = fakeDetailBundle()
  render(<StreamPanel />)
  await waitFor(() => expect(api.channelItems).toHaveBeenCalled())

  paste(document.body, 'https://www.douyin.com/video/1')

  await waitFor(() => expect(screen.getByTestId('paste-action-modal')).toBeTruthy())
  expect(screen.getByText('一条抖音')).toBeTruthy()
  expect(mountSpy).not.toHaveBeenCalled() // 问着呢，还没开详情

  fireEvent.click(screen.getByTestId('paste-action-transcribe'))

  await waitFor(() => expect(mountSpy).toHaveBeenCalled())
  expect((mountSpy.mock.calls[0][1] as { autoExtract?: boolean }).autoExtract).toBe(true)
})

test('确认框里点卡片 = 仅查看详情（autoExtract 不带）', async () => {
  mockDouyinVideo()
  const mountSpy = fakeDetailBundle()
  render(<StreamPanel />)
  await waitFor(() => expect(api.channelItems).toHaveBeenCalled())

  paste(document.body, 'https://www.douyin.com/video/1')
  await waitFor(() => expect(screen.getByTestId('paste-action-modal')).toBeTruthy())

  fireEvent.click(screen.getByTestId('paste-action-card'))

  await waitFor(() => expect(mountSpy).toHaveBeenCalled())
  expect((mountSpy.mock.calls[0][1] as { autoExtract?: boolean }).autoExtract).toBe(false)
})

test('ESC 关掉确认框 = 取消，什么都不开', async () => {
  mockDouyinVideo()
  const mountSpy = fakeDetailBundle()
  render(<StreamPanel />)
  await waitFor(() => expect(api.channelItems).toHaveBeenCalled())

  paste(document.body, 'https://www.douyin.com/video/1')
  await waitFor(() => expect(screen.getByTestId('paste-action-modal')).toBeTruthy())

  fireEvent.keyDown(window, { key: 'Escape' })

  await waitFor(() => expect(screen.queryByTestId('paste-action-modal')).toBeNull())
  expect(mountSpy).not.toHaveBeenCalled()
})

test('stt 没配 → 「转成文字」置灰但还在（说得出为什么不能点）', async () => {
  mockDouyinVideo()
  vi.spyOn(api.conversions, 'kinds').mockResolvedValue({ items: [{ kind: 'extract', branches: { stt: false } }] } as never)
  fakeDetailBundle()
  render(<StreamPanel />)
  await waitFor(() => expect(api.channelItems).toHaveBeenCalled())

  paste(document.body, 'https://www.douyin.com/video/1')

  await waitFor(() => expect(screen.getByTestId('paste-action-modal')).toBeTruthy())
  expect((screen.getByTestId('paste-action-transcribe') as HTMLButtonElement).disabled).toBe(true)
})
