// 面板详情页的「转成文字」入口——钉的是**三档能力发现**（还没拉到 / 拉到了 / 拉不到）各自
// 画出什么。三档里有两档画出来一模一样（按钮不出现），而它们必须由**不同的原因**产生：
// 「还没拉到」是暂时的，拉到就该出现；「拉到了但这条不支持」是结论，永远不出现。
// 分不开的表现是一个时有时无的按钮，或者一个点了必失败的入口——两种都不会有任何一处报错。
//
// 动作本身（2026-10-24 起）是**面板原生**：切到右栏「转写」档 + 直接 POST /api/conversions
// （曾经发一句话进对话——转写稿在前端没有归宿才那么做；现在有了转写档，见 TranscriptPanel 头注）。
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { PanelDetail } from './PanelDetail.tsx'
import { api } from '../lib/api.ts'
import type { Conversion, Item } from '../lib/types.ts'

beforeEach(() => {
  localStorage.clear()
  // 详情里那条 source-blind 的富化会真发请求；这里不验它。
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
  // 转写档开档的缓存查询：默认「没有转过」。各测试按需覆盖。
  vi.spyOn(api.conversions, 'latest').mockResolvedValue(null)
  // 没配 STT key 的环境里 kinds 会 503——默认拒绝，能力相关测试各自覆盖成可用。
  vi.spyOn(api.conversions, 'kinds').mockRejectedValue(new Error('未配置'))
  vi.spyOn(api.conversions, 'start').mockResolvedValue({} as never)
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

function convRecord(over: Partial<Conversion> = {}): Conversion {
  return {
    id: 'cv_1',
    kind: 'extract',
    itemId: 'g1',
    status: 'queued',
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
    ...over,
  } as Conversion
}

function renderDetail(seed?: { stt: boolean; ocr: boolean; article: boolean }, autoExtract?: boolean) {
  return render(
    <PanelDetail
      item={galleryItem()}
      startMediaIndex={0}
      autoPlayMedia={false}
      autoExtract={autoExtract}
      extractCaps={seed}
      onClose={() => {}}
    />,
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

// 点「转成文字」是面板原生：切到「转写」档 + POST /api/conversions。
// 曾经钉的是"发进对话"（askExtract）——转写档落地后那是历史行为，别改回去。
test('点「转成文字」→ 起一条 extract 转换，右栏切到「转写」档', async () => {
  renderDetail({ stt: false, ocr: true, article: false })
  const start = vi.spyOn(api.conversions, 'start').mockResolvedValue(
    convRecord({ status: 'running', timing: { totalMs: 0, stages: [{ name: 'ocr:fetch', ms: 300 }] } }),
  )

  fireEvent.click(extractButton()!)

  await waitFor(() => expect(start).toHaveBeenCalled())
  expect(start.mock.calls[0][1]).toBe('extract')
  expect(start.mock.calls[0][2]).toBe('g1')
  // 右栏已经切到转写档：运行中那一面画出来了（不是「开始转写」的未启动面）。
  await waitFor(() => expect(screen.getByTestId('transcript-running')).toBeTruthy())
})

test('autoExtract：开出来就切转写档并启动转换（粘贴确认框那条路）', async () => {
  const start = vi.spyOn(api.conversions, 'start').mockResolvedValue(
    convRecord({ status: 'queued', queuePos: 2 }),
  )
  renderDetail({ stt: false, ocr: true, article: false }, true)

  await waitFor(() => expect(start).toHaveBeenCalled())
  // 排队面：位置号 + 取消（取消的 DELETE 不在这个测试里点——排队记录被删的回执走另一条路）。
  await waitFor(() => expect(screen.getByTestId('transcript-queued')).toBeTruthy())
  expect(screen.getByText(/前面还有 2 条/)).toBeTruthy()
})

test('缓存命中：开档直接是全文，不重新计费', async () => {
  const start = vi.spyOn(api.conversions, 'start')
  vi.spyOn(api.conversions, 'latest').mockResolvedValue(
    convRecord({
      status: 'done',
      result: { text: '这是转出来的全文', format: 'plain', branch: 'ocr' },
    }),
  )
  renderDetail({ stt: false, ocr: true, article: false })
  await waitFor(() => expect(screen.getByTestId('panel-tab-transcript')).toBeTruthy())
  fireEvent.click(screen.getByTestId('panel-tab-transcript'))

  await waitFor(() => expect(screen.getByTestId('transcript-done')).toBeTruthy())
  expect(screen.getByText('这是转出来的全文')).toBeTruthy()
  expect(start).not.toHaveBeenCalled()
})

test('转换失败 → 说人话 + 重试', async () => {
  vi.spyOn(api.conversions, 'latest').mockResolvedValue(
    convRecord({ status: 'error', error: { code: 'asr_failed', message: '音频取不下来' } }),
  )
  renderDetail({ stt: false, ocr: true, article: false })
  await waitFor(() => expect(screen.getByTestId('panel-tab-transcript')).toBeTruthy())
  fireEvent.click(screen.getByTestId('panel-tab-transcript'))

  await waitFor(() => expect(screen.getByTestId('transcript-error')).toBeTruthy())
  expect(screen.getByText(/音频取不下来/)).toBeTruthy()

  const start = vi.spyOn(api.conversions, 'start').mockResolvedValue(convRecord({ status: 'queued' }))
  fireEvent.click(screen.getByRole('button', { name: /重试/ }))
  await waitFor(() => expect(start).toHaveBeenCalled())
})

test('canExtract 为假的条目：不开转写档、不查缓存', async () => {
  const latest = vi.spyOn(api.conversions, 'latest').mockResolvedValue(null)
  renderDetail({ stt: true, ocr: false, article: false }) // gallery 吃 ocr；stt 不亮
  await waitFor(() => expect(screen.getByText('一条图文')).toBeTruthy())
  expect(latest).not.toHaveBeenCalled()
  expect(screen.queryByTestId('panel-tab-transcript')).toBeNull()
})
