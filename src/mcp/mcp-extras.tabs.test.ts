import { describe, it, expect, vi } from 'vitest'
import { buildMcpExtras } from './mcp-extras.ts'

// 「close 是命令」要端到端可用，AI 就得能：认出组里有哪些 tab（list）、并在一轮走完时
// 主动关掉某个（close）。这两个原语 + 已修的 cdp_look（interactive 留 tab 并返回 tabId
// = open）合起来闭环。扩展侧 close 按出身分流：用户拖入的只 detach，绝不销毁。
//
// 走的是统一 cdp facade：target:'chrome' 落到 cdp_pages 的 chromeTabs/chromeCloseTab 分支
// （cdp-router.ts）。

function fakeBoot() {
  const relay = {
    list: vi.fn(async () => [
      { tabId: 42, url: 'https://a.example/x', title: 'A' },
      { tabId: 9, url: 'https://b.example/y', title: 'B' },
    ]),
    closeTab: vi.fn(async () => {}),
  }
  return { boot: { extRelay: relay } as never, relay }
}

describe('cdp_pages(target:chrome) —— 枚举会话组内的 tab（AI 靠它认目标，不靠猜）', () => {
  it('返回组内每个 tab 的 {tabId,url,title}', async () => {
    const { boot } = fakeBoot()
    const extras = buildMcpExtras(boot)
    await expect(extras.cdpPages!({ target: 'chrome' })).resolves.toEqual({
      pages: [
        { tabId: 42, url: 'https://a.example/x', title: 'A' },
        { tabId: 9, url: 'https://b.example/y', title: 'B' },
      ],
    })
  })

  it('走 relay 的 list op（组外 tab 由扩展侧保证不出现）', async () => {
    const { boot, relay } = fakeBoot()
    await buildMcpExtras(boot).cdpPages!({ target: 'chrome' })
    expect(relay.list).toHaveBeenCalled()
  })
})

describe('cdp_pages(target:chrome, close) —— 收工是命令，不是强制清理', () => {
  it('按显式 tabId 关（AI 一轮走完主动发 / 用户也能手动关）', async () => {
    const { boot, relay } = fakeBoot()
    const extras = buildMcpExtras(boot)
    await expect(extras.cdpPages!({ target: 'chrome', close: 42 })).resolves.toEqual({ closed: 42 })
    expect(relay.closeTab).toHaveBeenCalledWith(42)
  })

  it('关不掉（已被用户手动关掉等）如实抛错，不假装成功', async () => {
    const relay = {
      list: vi.fn(async () => []),
      closeTab: vi.fn(async () => {
        throw new Error('refuse to close tab 77: not in the session tab group')
      }),
    }
    const extras = buildMcpExtras({ extRelay: relay } as never)
    await expect(extras.cdpPages!({ target: 'chrome', close: 77 })).rejects.toThrow(/not in the session tab group/)
  })
})
