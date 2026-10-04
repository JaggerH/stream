import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DebugBox } from './DebugBox.tsx'
import * as transport from '../lib/transport.ts'

// 钉住 2026-08-07 那次归因错误的真正根因：崩溃的触发条件不是"抽屉 + 全屏 Detail 同时在场"，
// 是 `/api/debug/log` 的 fetch stub 顶层直接返回数组 `[]`（形状不对——真实后端恒返回
// `{ entries: [...] }`，见 src/http/app.ts）。此时 `d` 就是这个数组本身，`d?.entries` 取到的
// 是 `Array.prototype.entries`（函数），真值判断为 true，`setEntries(该函数)` 被 React 当成
// updater 执行，`this` 是 undefined，炸出 `TypeError: Cannot convert undefined or null to
// object`，整棵树被卸空。这条测试不测抽屉/全屏 Detail 的组合——单独挂载 DebugBox、喂它这个
// 畸形响应就足够复现（归因错误的核心就是"以为要那个组合才崩，其实单独挂载喂错形状就已经崩"）。
describe('DebugBox 挂载', () => {
  beforeEach(() => {
    // 顶层裸数组——不是真实后端形状，模拟当年触发崩溃的那个畸形响应。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    vi.spyOn(transport, 'selectTransport').mockReturnValue({
      fetch: vi.fn(),
      openSocket: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
    })
  })

  it('/api/debug/log 返回畸形的裸数组时不崩，只是不采纳这份数据', async () => {
    const { container } = render(<DebugBox baseUrl="" wsUrl="ws://localhost/ws" />)
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0))
    // 给 React 一拍去 flush 那次 setEntries——崩溃会让整棵树被卸成空 <div/>，容器仍有内容就是没崩。
    await new Promise((r) => setTimeout(r, 0))
    expect(container.firstChild).toBeTruthy()
    expect(container.querySelector('.fixed')).toBeTruthy()
  })
})
