import { describe, it, expect, beforeEach, vi } from 'vitest'
import { syncFromPopup } from './sync-now.ts'

/**
 * 这一组守的是一件**只在界面上才看得见**的事：同步跑完，按钮旁边那行「last 12:34:56」要动。
 *
 * 它为什么需要测试：`runSync` 只把 `lastSync` 写进 chrome.storage，popup 没有 storage 监听器，
 * 所以时间戳全靠这一步重读。漏掉它不会报错、不会变红，只是那行字永远停在打开 popup 的那一刻
 * ——用户读到的是"同步没成功"。曾经这一步挂在一个恒为 false 的字段上，症状正是如此。
 */

let stored: Record<string, unknown> = {}

beforeEach(() => {
  stored = { config: { baseUrl: 'http://127.0.0.1:8900', domains: [], autoSync: true } }
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: stored[k] }),
        set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
      },
    },
  })
})

const configNow = () => stored.config as Record<string, unknown>

describe('syncFromPopup', () => {
  it('【核心】同步跑完必须重读配置 —— 时间戳靠它才会动', async () => {
    // 后台那一轮把 lastSync 写进了 storage（这里直接模拟那个副作用）
    const send = vi.fn(async () => {
      Object.assign(configNow(), { lastSync: 1_700_000_000_000 })
      return { reason: 'nudged', counts: { 'quark.cn': 3 } }
    })
    const { outcome, config } = await syncFromPopup({ send })
    expect(outcome).toEqual({ reason: 'nudged', counts: { 'quark.cn': 3 } })
    expect(config.lastSync).toBe(1_700_000_000_000)
  })

  it('【核心】relay_down 那种"没叫动"的结局也要重读 —— 重读不许挂任何条件', async () => {
    // 判据不能是"这一轮成功了吗"：那正是回归的形状（挂在一个条件上，条件永远不成立）。
    const send = vi.fn(async () => {
      Object.assign(configNow(), { lastSync: 42 })
      return { reason: 'relay_down', counts: {} }
    })
    const { config } = await syncFromPopup({ send })
    expect(config.lastSync).toBe(42)
  })

  it('后台不可达（sendMessage reject）→ 看得见的失败，不是卡住的按钮', async () => {
    const send = vi.fn(async () => { throw new Error('Could not establish connection') })
    const { outcome, config } = await syncFromPopup({ send })
    expect('error' in outcome && outcome.error).toContain('background unreachable')
    // 即使这一轮什么都没发生，配置也照读——保持"重读无条件"这一条不被特例侵蚀
    expect(config.baseUrl).toBe('http://127.0.0.1:8900')
  })

  it('后台回了个空 → 同样是看得见的失败', async () => {
    const { outcome } = await syncFromPopup({ send: async () => undefined })
    expect('error' in outcome && outcome.error).toContain('no response from the extension background')
  })
})
