// 详情是独立的第二个 IIFE bundle、独立的 React root（见 detail-entry.tsx 头注），
// 也就自带一份独立的 `sonner` 模块实例——`StreamPanel.tsx` 那枚 Toaster 挂在 feed root
// 上，够不着这棵树发的 toast。这条钉住"这棵树自己就能把失败说出来"，不靠别的 root 兜底。
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api } from '../lib/api.ts'
import { toast } from '../components/acrylic/sonner.tsx'
import type { Item } from '../lib/types.ts'

beforeEach(() => {
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
})

afterEach(() => {
  document.body.innerHTML = ''
})

const item: Item = {
  id: 'a', stream_id: 'panel-test', type: 'post', title: '一条详情',
  url: 'https://example.com/a',
  content: { archetype: 'text', text: '正文' },
  timestamp: '2026-08-17T00:00:00Z', fetched_at: '2026-08-17T00:00:00Z',
} as Item

test('详情 root 自己的 toast 真的画得出来（没有 Toaster 时这条会一直挂起超时）', async () => {
  const { mount, unmount } = await import('./detail-entry.tsx')
  const el = document.createElement('div')
  document.body.appendChild(el)

  act(() => {
    mount(el, {
      backend: 'http://127.0.0.1:8900',
      item,
      startMediaIndex: 0,
      autoPlayMedia: false,
      onClose: () => {},
    })
  })
  await waitFor(() => expect(screen.getByText('一条详情')).toBeTruthy())

  // 模拟 ArtPlayer 的失败回执（同一条调用路径：`toast.error('播放失败', …)`）——
  // 不必真的挂视频出错，验的是"这棵树里发的 toast 有地方接"，不是 ArtPlayer 本身。
  act(() => {
    toast.error('播放失败', { description: '一条详情：MEDIA_ERR_NETWORK' })
  })

  await waitFor(() => expect(screen.getByText('播放失败')).toBeTruthy())
  expect(screen.getByText(/一条详情：MEDIA_ERR_NETWORK/)).toBeTruthy()

  act(() => unmount())
})
