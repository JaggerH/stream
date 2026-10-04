import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { createKernel, quiesceKernel } from '../context.ts'
import { llmPlugin } from './llm.ts'
import type { ProviderService } from './provider.ts'
import type { Stores } from './storage.ts'
import type { CredentialsService } from './credentials.ts'
import type { LlmForTask } from '../../llm/task.ts'
import type { ChatResult } from '../../llm/client.ts'
import type { LadderTrace } from '../../providers/ladder-trace.ts'

/** 假 provider/stores/credentials 三域：只给 `ctx.llm`（inject: ['provider','stores','credentials']）
 *  真正会解引用的那几个字段，其余用不到的一概不搭——挂真实全链（provider.test.ts 那套）会把
 *  `llmForTask` 焊死在真实 executor 上，没法在测试里控制"这次返回什么/带不带 usage"。 */
function fakeProviderPlugin(forTask: LlmForTask) {
  return {
    name: 'fake-provider',
    apply(ctx: Context) {
      ctx.provide('provider', {
        llmForTask: forTask,
        providerBindings: { binding: () => null, fixed: () => null },
      } as unknown as ProviderService)
    },
  }
}

function fakeStoresPlugin() {
  return {
    name: 'fake-stores',
    apply(ctx: Context) {
      ctx.provide('stores', {
        channels: { getProvider: () => null },
      } as unknown as Stores)
    },
  }
}

function fakeCredentialsPlugin() {
  return {
    name: 'fake-credentials',
    apply(ctx: Context) {
      ctx.provide('credentials', {
        tokenProvider: { token: () => null },
      } as unknown as CredentialsService)
    },
  }
}

async function mount(dataDir: string, cacheDbName: string, forTask: LlmForTask, onDebug?: (entry: import('../../debug.ts').DebugEntry) => void) {
  mkdirSync(dataDir, { recursive: true })
  const kernel = createKernel()
  await kernel.plugin(fakeProviderPlugin(forTask))
  await kernel.plugin(fakeStoresPlugin())
  await kernel.plugin(fakeCredentialsPlugin())
  await kernel.plugin(llmPlugin, { cacheDb: join(dataDir, cacheDbName), onDebug })
  return kernel
}

describe('llmPlugin', () => {
  it('forTask 成功一次、raw 带 usage → 账本记一笔 metered', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'stream-llm-')), 'data')
    const chatResult: ChatResult = { content: 'hi', raw: { usage: { prompt_tokens: 10, completion_tokens: 5 } } }
    const forTask: LlmForTask = async (_id, _input, opts) => {
      opts?.onLadder?.({ via: 'member-a', rungs: [] })
      return chatResult
    }
    const kernel = await mount(dataDir, 'cache.db', forTask)
    const result = await kernel.llm.forTask('llm.chat', { messages: [] } as never)
    expect(result?.content).toBe('hi')
    const rows = kernel.llm.usage.aggregate()
    expect(rows).toHaveLength(1)
    expect(rows[0].calls).toBe(1)
    expect(rows[0].promptTokens).toBe(10)
    expect(rows[0].completionTokens).toBe(5)
    expect(rows[0].usageUnreported).toBe(0)
    await quiesceKernel(kernel)
  })

  it('raw 无 usage → 记 usage_unreported，不是 metered', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'stream-llm-')), 'data')
    const chatResult: ChatResult = { content: 'hi', raw: {} }
    const forTask: LlmForTask = async () => chatResult
    const kernel = await mount(dataDir, 'cache.db', forTask)
    await kernel.llm.forTask('llm.chat', { messages: [] } as never)
    const rows = kernel.llm.usage.aggregate()
    expect(rows).toHaveLength(1)
    expect(rows[0].usageUnreported).toBe(1)
    expect(rows[0].promptTokens).toBe(0)
    await quiesceKernel(kernel)
  })

  it('null 结果（没打出去/没人答）不记账', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'stream-llm-')), 'data')
    const forTask: LlmForTask = async () => null
    const kernel = await mount(dataDir, 'cache.db', forTask)
    const result = await kernel.llm.forTask('llm.chat', { messages: [] } as never)
    expect(result).toBeNull()
    expect(kernel.llm.usage.aggregate()).toHaveLength(0)
    await quiesceKernel(kernel)
  })

  it('ladder.rungs 里有 rejected 档 → 每档各落一笔 rejected_unmetered（member 用该档自己的，不是最终赢家）', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'stream-llm-')), 'data')
    const chatResult: ChatResult = { content: 'hi', raw: { usage: { prompt_tokens: 10, completion_tokens: 5 } } }
    const forTask: LlmForTask = async (_id, _input, opts) => {
      opts?.onLadder?.({
        via: 'member-b',
        rungs: [
          { member: 'member-a', source: 'llm-openai', ms: 12, outcome: 'rejected' },
          { member: 'member-b', source: 'llm-openai', ms: 8, outcome: 'win' },
        ],
      })
      return chatResult
    }
    const kernel = await mount(dataDir, 'cache.db', forTask)
    await kernel.llm.forTask('llm.summarize', { messages: [] } as never)
    const rows = kernel.llm.usage.aggregate()
    expect(rows).toHaveLength(1)
    expect(rows[0].calls).toBe(2) // 1 条 metered（最终结果）+ 1 条 rejected_unmetered
    expect(rows[0].rejectedUnmetered).toBe(1)
    expect(rows[0].promptTokens).toBe(10)
    expect(rows[0].completionTokens).toBe(5)
    await quiesceKernel(kernel)
  })

  it('每次完成都发一条 channel:llm 的 debug entry，含 callsiteId（成功 / null 两种结局都发）', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'stream-llm-')), 'data')
    const entries: import('../../debug.ts').DebugEntry[] = []
    const forTask: LlmForTask = async (_id, _input, opts) => {
      opts?.onLadder?.({ via: 'member-a', rungs: [] })
      return { content: 'hi', raw: { usage: { prompt_tokens: 10, completion_tokens: 5 } } }
    }
    const kernel = await mount(dataDir, 'cache.db', forTask, (e) => entries.push(e))
    await kernel.llm.forTask('llm.chat', { messages: [] } as never)
    expect(entries).toHaveLength(1)
    expect(entries[0].channel).toBe('llm')
    expect(entries[0].fields.find((f) => f.label === 'callsiteId')?.value).toBe('llm.chat')
    expect(entries[0].fields.find((f) => f.label === 'member')?.value).toBe('member-a')
    expect(entries[0].ok).toBe(true)

    // null 结局也要发——不能因为没打出去就悄悄不吭声。
    const forTaskNull: LlmForTask = async (_id, _input, opts) => {
      opts?.onLadder?.({ via: null, rungs: [] })
      return null
    }
    const kernel2 = await mount(dataDir, 'cache2.db', forTaskNull, (e) => entries.push(e))
    await kernel2.llm.forTask('llm.chat', { messages: [] } as never)
    expect(entries).toHaveLength(2)
    expect(entries[1].ok).toBe(false)
    await quiesceKernel(kernel)
    await quiesceKernel(kernel2)
  })

  it('调用方自己传的 onLadder 仍被调用（包装不吞回调）', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'stream-llm-')), 'data')
    const forTask: LlmForTask = async (_id, _input, opts) => {
      opts?.onLadder?.({ via: 'member-b', rungs: [] })
      return { content: 'x', raw: {} }
    }
    const kernel = await mount(dataDir, 'cache.db', forTask)
    const captured: { seen: LadderTrace | null } = { seen: null }
    await kernel.llm.forTask('llm.chat', { messages: [] } as never, { onLadder: (l) => { captured.seen = l } })
    expect(captured.seen?.via).toBe('member-b')
    await quiesceKernel(kernel)
  })
})
