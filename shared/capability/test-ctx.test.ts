import { describe, expect, it } from 'vitest'
import { fakeCapabilityContext } from './test-ctx.js'
import type { ToolDef } from './types.js'

function makeToolDef(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'echo',
    description: 'echoes',
    parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => ({}),
    ...overrides,
  }
}

describe('fakeCapabilityContext', () => {
  it('registerTools 累加进 tools 数组', () => {
    const ctx = fakeCapabilityContext()
    ctx.registerTools([makeToolDef({ name: 'a' })])
    ctx.registerTools([makeToolDef({ name: 'b' })])
    expect(ctx.tools.map((t) => t.name)).toEqual(['a', 'b'])
  })

  it('dispose() 逆序调用 onDispose 登记的函数', async () => {
    const ctx = fakeCapabilityContext()
    const order: number[] = []
    ctx.onDispose(() => {
      order.push(1)
    })
    ctx.onDispose(() => {
      order.push(2)
    })
    ctx.onDispose(() => {
      order.push(3)
    })
    await ctx.dispose()
    expect(order).toEqual([3, 2, 1])
  })

  it('dataDir 默认给一个临时目录，可用 opts.dataDir 覆盖；destructiveGate 默认 none', () => {
    const ctx = fakeCapabilityContext()
    expect(ctx.dataDir.length).toBeGreaterThan(0)
    expect(ctx.destructiveGate).toBe('none')

    const ctx2 = fakeCapabilityContext({ dataDir: '/tmp/fixed', destructiveGate: 'host' })
    expect(ctx2.dataDir).toBe('/tmp/fixed')
    expect(ctx2.destructiveGate).toBe('host')
  })

  it('provide/require 与 log 落进各自的表', () => {
    const ctx = fakeCapabilityContext()
    ctx.provide('svc', 1)
    expect(ctx.require('svc')).toBe(1)
    expect(ctx.services.get('svc')).toBe(1)

    ctx.log.info('hi')
    ctx.log.warn('uh oh')
    expect(ctx.logs.info).toEqual(['hi'])
    expect(ctx.logs.warn).toEqual(['uh oh'])
  })
})
