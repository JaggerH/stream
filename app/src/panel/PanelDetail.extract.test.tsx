// 面板详情页的「转成文字」入口——钉的是**三档能力发现**（还没拉到 / 拉到了 / 拉不到）各自
// 画出什么。三档里有两档画出来一模一样（按钮不出现），而它们必须由**不同的原因**产生：
// 「还没拉到」是暂时的，拉到就该出现；「拉到了但这条不支持」是结论，永远不出现。
// 分不开的表现是一个时有时无的按钮，或者一个点了必失败的入口——两种都不会有任何一处报错。
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { PanelDetail } from './PanelDetail.tsx'
import { api } from '../lib/api.ts'
import { setAskChatSink } from '../lib/askExtract.ts'
import type { Item } from '../lib/types.ts'

beforeEach(() => {
  localStorage.clear()
  // 详情里那条 source-blind 的富化会真发请求；这里不验它。
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
})

/** 一条图文（gallery + 图片）：它的转成文字分支是 ocr，所以"支不支持"完全由 caps.ocr 说了算。 */
function galleryItem(): Item {
  return {
    id: 'g1',
    stream_id: 'panel-test',
    type: 'post',
    title: '一条图文',
    url: 'https://example.com/g1',
    content: { archetype: 'gallery', text: '配图说明', media: [{ kind: 'image', url: 'https://example.com/1.jpg' }] },
    timestamp: '2026-08-17T00:00:00Z',
    fetched_at: '2026-08-17T00:00:00Z',
  } as unknown as Item
}

function kindsWith(branches: { stt?: boolean; ocr?: boolean; article?: boolean }) {
  return { items: [{ kind: 'extract', branches }] }
}

function renderDetail(seed?: { stt: boolean; ocr: boolean; article: boolean }) {
  return render(
    <PanelDetail item={galleryItem()} startMediaIndex={0} autoPlayMedia={false} extractCaps={seed} onClose={() => {}} />,
  )
}

const extractButton = () => screen.queryByRole('button', { name: /转成文字/ })

test('能力拉到了、这条也支持 → 「转成文字」出现', async () => {
  vi.spyOn(api.conversions, 'kinds').mockResolvedValue(kindsWith({ ocr: true }) as never)
  renderDetail()
  await waitFor(() => expect(extractButton()).toBeTruthy())
})

test('能力拉到了、但这条这一档没配 → 不出现（这是结论，不是"还没拉到"）', async () => {
  vi.spyOn(api.conversions, 'kinds').mockResolvedValue(kindsWith({ ocr: false, stt: true }) as never)
  renderDetail()
  await waitFor(() => expect(screen.getByText('一条图文')).toBeTruthy())
  await waitFor(() => expect(api.conversions.kinds).toHaveBeenCalled())
  expect(extractButton()).toBeNull()
})

// 这一条是三档区分的核心：拉回来之前**不许**亮按钮（亮了就是点了必失败），
// 拉回来之后必须自己补上（不补就成了"这条永远不能转成文字"的假结论）。
test('还没拉到 → 不出现；拉到了 → 同一次挂载里自己补上', async () => {
  let resolveKinds!: (v: unknown) => void
  const pending = new Promise((resolve) => { resolveKinds = resolve })
  vi.spyOn(api.conversions, 'kinds').mockReturnValue(pending as never)

  renderDetail()
  await waitFor(() => expect(screen.getByText('一条图文')).toBeTruthy())
  expect(extractButton()).toBeNull() // 还没拉到：不亮

  resolveKinds(kindsWith({ ocr: true }))
  await waitFor(() => expect(extractButton()).toBeTruthy()) // 拉到了：补上
})

test('能力拉不到 → 不出现（宁可不亮，也不亮一个点了必失败的入口）', async () => {
  vi.spyOn(api.conversions, 'kinds').mockRejectedValue(new Error('后端没起'))
  renderDetail()
  await waitFor(() => expect(screen.getByText('一条图文')).toBeTruthy())
  await waitFor(() => expect(api.conversions.kinds).toHaveBeenCalled())
  expect(extractButton()).toBeNull()
})

// 列表那棵树已经拉过了，就别再拉第二次——那一次网络往返正是"按钮晚半拍才冒出来"的来源。
test('列表递来种子 → 挂载即出现，且不再自己拉一次', async () => {
  vi.spyOn(api.conversions, 'kinds').mockResolvedValue(kindsWith({}) as never)
  renderDetail({ stt: false, ocr: true, article: false })
  await waitFor(() => expect(extractButton()).toBeTruthy())
  expect(api.conversions.kinds).not.toHaveBeenCalled()
})

// 按钮点得动，而且走的是全站唯一那份 `lib/askExtract.ts`。面板这一档接的是壳递进来的对话
// 通道（`entry.tsx` 的 onAskChat），所以点下去应该是"发进对话"，而不是起一条后台转换。
test('点「转成文字」把这条发进对话', async () => {
  vi.spyOn(api.conversions, 'kinds').mockResolvedValue(kindsWith({ ocr: true }) as never)
  const start = vi.spyOn(api.conversions, 'start').mockResolvedValue({} as never)
  const sink = vi.fn()
  setAskChatSink(sink)
  renderDetail()
  await waitFor(() => expect(extractButton()).toBeTruthy())

  fireEvent.click(extractButton()!)

  await waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
  expect(sink.mock.calls[0][0]).toMatchObject({ kind: 'send' })
  expect((sink.mock.calls[0][0] as { text: string }).text).toContain('extract')
  expect((sink.mock.calls[0][0] as { text: string }).text).toContain('g1')
  // 不许再顺手起一条后台转换——那就是同一件事被做了两遍（一遍没人看得见）。
  expect(start).not.toHaveBeenCalled()
  setAskChatSink(undefined)
})
