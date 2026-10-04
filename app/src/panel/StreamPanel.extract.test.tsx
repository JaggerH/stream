// 列表那棵树把「转成文字」能力发现的结果当**种子**递给详情那棵树（详情是第二个 React root、
// 第二份 JS 运行时，context 过不去，见 PanelDetail.tsx 头注 §3）。
//
// 这里钉的是递什么：**只递已经拉到的那一份**。递一份"还没拉到"的全 false 过去，详情那棵树
// 会把它当结论——按钮永远不出现，而且没有任何一处会报错。
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { StreamPanel } from './StreamPanel.tsx'
import { api } from '../lib/api.ts'
import { detailBundle } from './detailBundle.ts'
import { setAskChatSink } from '../lib/askExtract.ts'
import type { ExtractCapabilities } from '../lib/extract.ts'
import type { Item } from '../lib/types.ts'

const mountSpy = vi.fn()

function item(id: string, title: string): Item {
  return {
    id, stream_id: 'panel-test', type: 'post', title,
    url: `https://example.com/${id}`,
    content: { archetype: 'text', text: '正文' },
    timestamp: '2026-08-17T00:00:00Z', fetched_at: '2026-08-17T00:00:00Z', published_at: '2026-08-17T00:00:00Z',
  } as unknown as Item
}

beforeEach(() => {
  mountSpy.mockReset()
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [item('a', '第一条')] })
  // 详情 bundle 换成一个只记 opts 的假件：这条验的是"递过去的是什么"，不是详情自己画得对不对
  // （那在 PanelDetail.extract.test.tsx）。
  vi.spyOn(detailBundle, 'load').mockResolvedValue({ mount: mountSpy, unmount: vi.fn() })
})

/** 开页 → 等能力发现那一拉走完（成功或失败都算走完）→ 点开详情，回传 mount 收到的 opts。 */
async function openDetailAfterCapsSettle(): Promise<{ extractCaps?: ExtractCapabilities }> {
  render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一条')).toBeTruthy())
  await waitFor(() => expect(api.conversions.kinds).toHaveBeenCalled())
  // 让那一拉的 then/catch 和它引起的重渲染都落地，再点——否则"还没拉到"和"拉到了"会按机器快慢分叉。
  await act(async () => { await Promise.resolve() })

  fireEvent.click(screen.getByText('第一条'))
  await waitFor(() => expect(mountSpy).toHaveBeenCalled())
  return mountSpy.mock.calls[0][1] as { extractCaps?: ExtractCapabilities }
}

test('能力已经拉到 → 把它当种子递给详情那棵树', async () => {
  vi.spyOn(api.conversions, 'kinds').mockResolvedValue({ items: [{ kind: 'extract', branches: { ocr: true } }] } as never)
  const opts = await openDetailAfterCapsSettle()
  expect(opts.extractCaps).toEqual({ stt: false, ocr: true, article: false })
})

test('能力还没拉到就开详情 → 不递种子（让详情自己去拉，别把"未知"当结论传下去）', async () => {
  vi.spyOn(api.conversions, 'kinds').mockReturnValue(new Promise(() => {}) as never)
  const opts = await openDetailAfterCapsSettle()
  expect(opts.extractCaps).toBeUndefined()
})

test('能力拉失败 → 同样不递种子（下一棵详情树自己重拉，不把整个面板会话钉死）', async () => {
  vi.spyOn(api.conversions, 'kinds').mockRejectedValue(new Error('后端没起'))
  const opts = await openDetailAfterCapsSettle()
  expect(opts.extractCaps).toBeUndefined()
})

// 同一个"两份 JS 运行时"的坑，第二格：对话通道。转成文字按钮画在**详情**那棵树里，而通道是
// 壳装进主 bundle 的——不顺着 mount 递过去，详情那边永远读到 undefined，点了会静悄悄地
// 走"这一页没有对话面"那条拒绝路，而 toast 画在详情那份看不见的 sonner 上。活体撞过一次，见 askChatSink()。
test('对话通道也要递给详情那棵树（不递 = 转成文字点了什么都不发生）', async () => {
  vi.spyOn(api.conversions, 'kinds').mockResolvedValue({ items: [{ kind: 'extract', branches: { ocr: true } }] } as never)
  const sink = vi.fn()
  setAskChatSink(sink)
  const opts = await openDetailAfterCapsSettle() as { askChat?: (t: string) => void }
  expect(opts.askChat).toBe(sink)
  setAskChatSink(undefined)
})
