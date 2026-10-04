/**
 * 注册表自身的完整性。**与真实 MCP 工具面的双向差集不在这里** —— 那条守卫住在 Stream 主仓
 * （`src/mcp/dsh-ui-registry-parity.test.ts`），因为只有那边能拿到真的工具名单。
 */
import { describe, expect, it } from 'vitest'
import { customRows, registryRows, wireToolName, slotKeyFor, STREAM_MCP_SERVER_NAME } from '../src/registry.ts'
import { CARDS } from '../src/client/index.tsx'

describe('渲染注册表', () => {
  it('每一行形状合法：tool 非空、treatment 二选一、why 说得出理由', () => {
    expect(registryRows.length).toBeGreaterThan(0)
    for (const row of registryRows) {
      expect(typeof row.tool, JSON.stringify(row)).toBe('string')
      expect(row.tool).not.toBe('')
      expect(['custom', 'generic']).toContain(row.treatment)
      // 「不该吃定制卡」这条结论的全部执行力就在这句理由上；一句空话等于没登记。
      expect(row.why.length, row.tool).toBeGreaterThan(10)
    }
  })

  it('没有重复的工具名', () => {
    const names = registryRows.map((r) => r.tool)
    expect(new Set(names).size).toBe(names.length)
  })

  it('custom 行逐个都有对应组件（对不上 = 一个静默回落通用卡的死注册）', () => {
    for (const row of customRows) expect(CARDS[row.tool], row.tool).toBeTypeOf('function')
  })

  it('CARDS 里不多出表外的组件（多出来的那个永远不会被 apply 注册）', () => {
    const customNames = new Set(customRows.map((r) => r.tool))
    for (const tool of Object.keys(CARDS)) expect(customNames.has(tool), tool).toBe(true)
  })

  it('wire 名的形状钉死 —— server 名和 Stream 生成 DSH profile 时写的必须逐字一致', () => {
    expect(STREAM_MCP_SERVER_NAME).toBe('stream')
    expect(wireToolName('extract')).toBe('mcp__stream__extract')
  })

  it('slot key 使用 Stream MCP 前缀', () => {
    expect(slotKeyFor({ tool: 'extract' })).toBe('mcp__stream__extract')
  })
})
