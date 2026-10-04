// harvest_capability —— 采集能力诊断的 MCP 面（spec 2026-07-29 §5：「MCP 侧给一个 tool，
// 同一个返回结构，不另造形状」）。
//
// 这个文件锁的是**形状同一**：MCP 工具的返回体必须和 `POST /api/browser-capability/diagnose`
// 逐字段相等。纯 MCP 用户最可能缺的正是「扩展装了没 / 该装在哪一侧」，而后半句只有 `chrome`
// 候选块答得了——所以 MCP 这一面只给全量那一档，不复刻 HTTP 的两档拆分（拆分的理由是快判要
// 在装机引导里秒回，一次工具调用没有这个约束）。
//
// 另一半是接线：工具的三个输入（relay 现状 / 落盘缓存 / Chrome 候选）都必须来自 boot 上已有的
// 那三处，别在 MCP 侧重算三态判定。

import { describe, it, expect, vi } from 'vitest'
import { buildMcpExtras } from './mcp-extras.ts'
import { toolCatalog, type McpExtras } from './tool-catalog.ts'
import type { StreamService } from './tools.ts'
import { createHttpApp } from '../http/app.ts'
import { summarizeCapability } from '../browser/capability-store.ts'

const fakeService = {} as StreamService

const WIN = { exe: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', side: 'windows', source: 'standard' } as const
const LINUX = { exe: '/usr/bin/google-chrome', side: 'linux', source: 'path' } as const
const CHROME = { selected: null, origin: null, candidates: [WIN, LINUX], mustChoose: true }

const RELAY = { connected: false, since: null }
const CAP = { everSeen: true, lastSeenAt: '2026-07-29T10:00:00.000Z', extVersion: '0.4.1', browser: 'Chrome/131', platform: 'win' }

/** 只带这条链需要的三处：relay 现状 / 落盘缓存 / Chrome 候选。 */
function fakeBoot() {
  const status = vi.fn(() => RELAY)
  const get = vi.fn(() => CAP)
  const chrome = vi.fn(async () => CHROME)
  const boot = {
    extRelay: { status, list: vi.fn(async () => []), closeTab: vi.fn(async () => {}) },
    browserCapability: { get },
    harvestBrowser: { status: chrome, select: vi.fn(async () => CHROME) },
  }
  return { boot: boot as never, status, get, chrome }
}

const tool = (extras: Omit<McpExtras, 'isCommunitySource'>) =>
  toolCatalog(fakeService, { isCommunitySource: () => false, ...extras }).find((t) => t.name === 'harvest_capability')

describe('harvest_capability（工具曲面）', () => {
  it('接了才注册；没接（后端没有 relay）就查无此人，不半残着回一半', () => {
    expect(tool({ harvestCapability: async () => ({ ...summarizeCapability(RELAY, CAP), chrome: CHROME }) })).toBeTruthy()
    expect(tool({})).toBeUndefined()
  })

  it('无参数 —— 只读诊断没有可选项，多一个参数只会让模型猜', () => {
    const t = tool({ harvestCapability: async () => ({ ...summarizeCapability(RELAY, CAP), chrome: CHROME }) })!
    expect(Object.keys(t.schema)).toEqual([])
  })

  it('run 原样下发诊断结构（工具层不再投影一遍）', async () => {
    const t = tool({ harvestCapability: async () => ({ ...summarizeCapability(RELAY, CAP), chrome: CHROME }) })!
    expect(await t.run({})).toEqual({ ...summarizeCapability(RELAY, CAP), chrome: CHROME })
  })
})

describe('harvest_capability = POST /api/browser-capability/diagnose 的同一个结构', () => {
  it('同样的输入，两面逐字段相等（MCP 侧不另造字段）', async () => {
    const { boot } = fakeBoot()
    const extras = buildMcpExtras(boot)
    const viaMcp = await tool(extras)!.run({})

    const app = createHttpApp({
      service: { streamsResource: () => [] },
      itemStore: { get: () => undefined },
      health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
      browserCapability: () => summarizeCapability(RELAY, CAP),
      harvestBrowser: { status: async () => CHROME, select: async () => CHROME },
    } as never)
    const viaHttp = await (await app.request('/api/browser-capability/diagnose', { method: 'POST' })).json()

    expect(viaMcp).toEqual(viaHttp)
  })
})

describe('harvest_capability 的接线', () => {
  it('三处输入都来自 boot（relay 现状 / 落盘缓存 / Chrome 候选），三态判定不在 MCP 侧重算', async () => {
    const { boot, status, get, chrome } = fakeBoot()
    const extras = buildMcpExtras(boot)
    const body = await extras.harvestCapability!()
    expect(status).toHaveBeenCalled()
    expect(get).toHaveBeenCalled()
    expect(chrome).toHaveBeenCalled()
    // 没连 + everSeen → disconnected（"掉线了"，不是"没装"）——判定来自 summarizeCapability。
    expect(body.state).toBe('disconnected')
    expect(body.chrome).toEqual(CHROME)
  })

  it('构造时不去摸文件系统 —— 只有真调用了才枚举 Chrome 候选', () => {
    const { boot, chrome } = fakeBoot()
    buildMcpExtras(boot)
    expect(chrome).not.toHaveBeenCalled()
  })
})
