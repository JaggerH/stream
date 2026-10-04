// src/mcp/dsh-ui-registry-parity.test.ts
//
// 钉数字守卫：**Stream 的 MCP 工具面** 和 **DSH UI 插件的渲染注册表**
// （`hosts/dsh/registry-table.json`）必须逐格对上。
//
// 为什么必须写成一条双向差集，而不是"记得同步一下"：
//   - MCP 多一个工具、表没登记 → 那个工具在工作台里永远回落通用卡。**没有任何一处会喊**
//     （不是错误，只是一张更差的卡），和 AGENTS.md「加了一份名单」那一节里被漏掉四次的
//     形状完全一样。
//   - 表里多一个、MCP 已经删了 → 插件在注册一个永远等不到调用的 key。同样安静。
//
// 表是 JSON（不是 TS）正因为它有两个消费端：那个包自己（决定注册哪几个渲染器）和这条测试。
// 路径从 `repoRoot`（被测模块自己导出的根）拼，**不信 cwd** —— `vitest --root <worktree>`
// 不改 cwd，用 `process.cwd()` 会去扫另一棵树（AGENTS.md worktree 纪律第 2 条）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../http/build-identity.ts'
import { createMcpServer, type McpExtras } from './server.ts'
import type { StreamServiceLike } from './tools.ts'

const TABLE_PATH = join(repoRoot, 'hosts', 'dsh', 'registry-table.json')

interface RegistryRow {
  tool: string
  treatment: 'custom' | 'generic'
  why: string
  /** `'stream'` = 来自一个**可选能力包**（`stream add @streamapp/<x>`）的动词：同样从 8900 的
   *  `/api/mcp` 出来、wire 名也一样，但用户没装那个包时它不存在（见 registry.ts）。 */
  server?: 'stream'
}

function readAllRows(): RegistryRow[] {
  return (JSON.parse(readFileSync(TABLE_PATH, 'utf8')) as { tools: RegistryRow[] }).tools
}

/**
 * 只有**核心面**那一半参与双向差集。
 *
 * 可选能力包的动词（`server: 'stream'`）必须排除：它们只有在用户 `stream add` 装了那个包、
 * 后端把它 mount 上之后才在工具面上，而这条测试造的是一个没装任何可选包的 `createMcpServer`。
 * 把它们算进来会得到一条**必红的假警报**（"表里有而 MCP 已经没有"），久了就会有人把整条
 * 差集关掉——那才是真正的损失。它们另有一条守卫（见下）。
 */
function readTable(): RegistryRow[] {
  return readAllRows().filter((r) => r.server !== 'stream')
}

/** 每一格能力都填上，好让 catalog 把它对应的工具都注册出来（注册门就是 extras 在不在）。 */
const allExtras = {
  contentSearch: async () => [],
  purchaseDecide: async () => ({}),
  priceSearch: async () => [],
  inboxSearch: () => ({ items: [], returned: 0, matched: 0 }),
  videoSearch: async () => ({}),
  videoResolve: async () => [], // 活体上无条件转发（mcp-extras.ts），fixture 缺格 = 差集看不见 video_resolve

  extract: () => ({}),
  identify: () => ({}),
  conversions: { list: () => ({ items: [] }) },
  speakers: () => ({ segments: [], hasSpeakers: false }),
  resolve: {
    resolveIntent: () => ({}),
    classifyIntent: () => ({ targetType: 't', key: 'k' }),
    resolveTarget: async () => ({}),
    listSources: () => [],
  },
  netdisk: {
    bindings: () => [],
    browse: async () => ({}),
    residue: async () => ({}),
    previewSpec: async () => ({}),
    applySpec: async () => ({}),
    // `reconcileOpen` 是**逐成员门控**的（`if (nd.reconcileOpen)`），不像同组其他工具那样
    // 整组随 `extras.netdisk` 一起注册。所以它必须在这份 fixture 里出现，否则这条双向差集
    // 看不见它——表里漏登记也照样绿，而活体上它是注册着的。凡是加了自己那道门的工具，
    // 都得往这儿补一格。
    reconcileOpen: async () => ({}),
    transcribeFile: async () => ({}), // 同上：自带一道门（`if (nd.transcribeFile)`）
    reconcileStatus: async () => ({}),
    reconcileDecide: () => ({}),
    reconcileExecute: async () => ({}),
    reconcileUndoRun: async () => ({}),
    sync: async () => ({}),
    shareVerify: async () => ({}), // 自带一道门（`if (nd.shareVerify)`）——追更没装配就没有它
    follow: async () => ({}), //      同上（`if (nd.follow)`）
    adjudicate: async () => ({}), //  同上（`if (nd.adjudicate)`）——裁决器没装配就没有它
    revokeAdjudication: async () => ({}), // 同上（`if (nd.revokeAdjudication)`）
  },
  cdpLook: async () => ({}),
  cdpShot: async () => ({ shot: null }),
  cdpAct: async () => ({ status: 'done' }),
  cdpPages: async () => ({ pages: [] }),
  // enumerate 也要填：它是 searchAgent 的子字段，注册门是「这一格在不在」——fixture 缺格
  // 差集就看不见 enumerate_candidates（和上面 videoResolve 记的是同一个坑）。
  searchAgent: { start: () => ({}), get: () => ({}), enumerate: () => ({}) },
  webSearch: async () => ({ hits: [] }),
  readUrl: async () => ({ text: '' }),
  harvestCapability: async () => ({}),
  capabilityStatus: () => ({ capabilities: [] }),
  // 写那一半的注册门是**两格一起**（`if (extras.provisionConfigSlot && extras.configProvisionerFor)`）
  // ——少填一格差集就看不见 provision_capability_key。
  provisionConfigSlot: async () => ({ status: 'done' }),
  configProvisionerFor: () => null,
  events: { list: () => [] },
  appearances: { query: () => [] },
  intents: { dossier: () => null, create: () => ({}), list: () => [] },
  wishlist: { add: () => ({ id: 'w1' }) },
} as unknown as McpExtras

/**
 * MCP 面**实际注册**了哪些工具名。
 *
 * 刻意走 `createMcpServer` 而不是 `toolCatalog`：catalog 之外还有 bespoke 注册
 * （`stream_subscribe`、`intent_dossier`），照 catalog 推会漏掉它们，而且下一个 bespoke
 * 工具加进来时这条测试会毫无反应——那正是它要防的事。
 */
function mcpToolNames(): string[] {
  const server = createMcpServer({} as StreamServiceLike, allExtras)
  const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
  // SDK 换了内部字段名的话，下面的差集会变成"MCP 一个工具都没有"这种荒谬的红。先在这里
  // 断掉，好让失败讯息说的是真话（读不到了），而不是一屏假的"表里全是多余项"。
  expect(registered, 'MCP SDK 的 _registeredTools 读不到了——换字段名了，这条测试要跟着改').toBeTypeOf('object')
  return Object.keys(registered as Record<string, unknown>)
}

describe('DSH UI 渲染注册表 ↔ Stream MCP 工具面', () => {
  it('MCP 有而表没登记的：一个都不许有', () => {
    const listed = new Set(readTable().map((r) => r.tool))
    const missing = mcpToolNames().filter((n) => !listed.has(n))
    expect(
      missing,
      `这些工具没登记进 hosts/dsh/registry-table.json —— 逐个回答"定制卡 / 通用卡即可(写理由)"`,
    ).toEqual([])
  })

  it('表里有而 MCP 已经没有的：一个都不许有', () => {
    const actual = new Set(mcpToolNames())
    const stale = readTable()
      .map((r) => r.tool)
      .filter((n) => !actual.has(n))
    expect(stale, '这些工具已经不在 MCP 面上了，表要跟着删（custom 行还要连组件一起删）').toEqual([])
  })

  it('表本身没有重复行', () => {
    const names = readTable().map((r) => r.tool)
    expect(names.length).toBe(new Set(names).size)
  })
})
