// validate 否决 → 换成员重试：LlmForTask 的升级策略。
import { describe, it, expect } from 'vitest'
import { makeLlmForTask } from './task.ts'
import { summarizeViaLlm } from './task.ts'
import { LadderError } from '../providers/ladder-trace.ts'
import type { InvokeResult } from '../providers/executor.ts'
import type { ProviderBinding } from '../store/types.ts'
import type { LlmChatInput } from './sources.ts'
import type { ChatResult } from './client.ts'
import type { LadderTrace } from '../providers/ladder-trace.ts'

const input: LlmChatInput = { messages: [{ role: 'user', content: 'q' }] }

/** 假梯子：只有 A/B 两个成员。按 excludeMembers 过滤后，剩下第一个赢；全被排除 → via:null（全员没结果，
 *  照实执行器的语义），不是无限循环地回落到同一个成员——这条决定了升级重试必须能终止。 */
function fakeLadder() {
  const calls: Array<{ ref: string; opts?: { excludeMembers?: string[] } }> = []
  const content: Record<string, string> = { A: 'a-content', B: 'b-content' }
  return {
    calls,
    invoke: async (ref: string, _inp: unknown, opts?: { excludeMembers?: string[] }): Promise<InvokeResult> => {
      calls.push({ ref, opts })
      const excluded = new Set(opts?.excludeMembers ?? [])
      const remaining = ['A', 'B'].filter((m) => !excluded.has(m))
      if (remaining.length === 0) {
        return { strategy: 'sequential', provider: 'llm', value: null, via: null, misses: [], timings: [] } as InvokeResult
      }
      const via = remaining[0]
      return {
        strategy: 'sequential',
        provider: 'llm',
        value: [{ content: content[via], raw: {} } as ChatResult],
        via,
        misses: [],
        timings: [{ member: via, source: via, ms: 5, outcome: 'win' }],
      } as InvokeResult
    },
  }
}

const bindings = { binding: (_id: string): ProviderBinding | null => null, fixed: (_id: string): string | null => 'llm' }

describe('makeLlmForTask — validate 否决换成员重试', () => {
  it('① validate 否 A → 拿到 B 的结果，onLadder 的 trace 含 A 的 rejected 记录', async () => {
    const ladder = fakeLadder()
    const llmForTask = makeLlmForTask({ executor: ladder, bindings })
    let ladderSeen: LadderTrace | undefined
    const out = await llmForTask('llm.chat', input, {
      validate: (r) => r.content === 'b-content',
      onLadder: (l) => { ladderSeen = l },
    })
    expect(out?.content).toBe('b-content')
    expect(ladder.calls).toHaveLength(2)
    expect(ladder.calls[1].opts?.excludeMembers).toEqual(['A'])
    expect(ladderSeen?.via).toBe('B')
    const aRung = ladderSeen?.rungs.find((r) => r.member === 'A')
    expect(aRung?.outcome).toBe('rejected')
  })

  it('② validate 全否 → 返回 null（各调用方原语义收场）', async () => {
    const ladder = fakeLadder()
    const llmForTask = makeLlmForTask({ executor: ladder, bindings })
    const out = await llmForTask('llm.chat', input, { validate: () => false })
    expect(out).toBeNull()
    // A 被否 → 换 B 再试（excludeMembers:['A']）→ B 也被否 → 再换（excludeMembers:['A','B']）→
    // 假梯子全排除后回 via:null，据此终止，不会死循环
    expect(ladder.calls).toHaveLength(3)
    expect(ladder.calls[2].opts?.excludeMembers).toEqual(['A', 'B'])
  })

  it('③ 不传 validate → 单次调用，行为与今天逐字节相同', async () => {
    const ladder = fakeLadder()
    const llmForTask = makeLlmForTask({ executor: ladder, bindings })
    const out = await llmForTask('llm.chat', input)
    expect(out?.content).toBe('a-content')
    expect(ladder.calls).toHaveLength(1)
  })
})

/** 假梯子：content 按成员可配置（用于摘要路「空摘要先换成员再抛」的验证）。 */
function fakeLadderWithContent(content: Record<string, string>) {
  const calls: Array<{ ref: string; opts?: { excludeMembers?: string[] } }> = []
  const members = Object.keys(content)
  return {
    calls,
    invoke: async (ref: string, _inp: unknown, opts?: { excludeMembers?: string[] }): Promise<InvokeResult> => {
      calls.push({ ref, opts })
      const excluded = new Set(opts?.excludeMembers ?? [])
      const remaining = members.filter((m) => !excluded.has(m))
      if (remaining.length === 0) {
        return { strategy: 'sequential', provider: 'llm', value: null, via: null, misses: [], timings: [] } as InvokeResult
      }
      const via = remaining[0]
      return {
        strategy: 'sequential',
        provider: 'llm',
        value: [{ content: content[via], raw: {} } as ChatResult],
        via,
        misses: [],
        timings: [{ member: via, source: via, ms: 5, outcome: 'win' }],
      } as InvokeResult
    },
  }
}

/** 假梯子：每次 invoke 都直接回 via:null（没人产出结果），但仍留下非空 rungs（miss/error）——
 *  用来跟"全被 validate 否决"这条区分：两者 rungs 都非空，只有后者才有 rejected 记录。 */
function fakeLadderAllMiss() {
  const calls: Array<{ ref: string; opts?: { excludeMembers?: string[] } }> = []
  return {
    calls,
    invoke: async (ref: string, _inp: unknown, opts?: { excludeMembers?: string[] }): Promise<InvokeResult> => {
      calls.push({ ref, opts })
      return {
        strategy: 'sequential',
        provider: 'llm',
        value: null,
        via: null,
        misses: [],
        timings: [{ member: 'A', source: 'A', ms: 5, outcome: 'miss' }],
      } as InvokeResult
    },
  }
}

describe('summarizeViaLlm — 空摘要接升级策略', () => {
  it('成员 A 回空 content、成员 B 回正文 → 拿到 B 的摘要，不抛', async () => {
    const ladder = fakeLadderWithContent({ A: '  ', B: '总结正文' })
    const llmForTask = makeLlmForTask({ executor: ladder, bindings })
    const out = await summarizeViaLlm(llmForTask, input)
    expect(out.summary).toBe('总结正文')
    expect(ladder.calls).toHaveLength(2)
    expect(ladder.calls[1].opts?.excludeMembers).toEqual(['A'])
  })

  it('全部成员回空 content → 仍抛「总结生成失败：模型返回空内容」', async () => {
    const ladder = fakeLadderWithContent({ A: '', B: '   ' })
    const llmForTask = makeLlmForTask({ executor: ladder, bindings })
    await expect(summarizeViaLlm(llmForTask, input)).rejects.toThrow(LadderError)
    await expect(summarizeViaLlm(llmForTask, input)).rejects.toThrow('总结生成失败：模型返回空内容')
  })

  it('全员 miss/error（从未答过，零 rejected）→ 抛「LLM 未配置，请在设置中填写」，不是「模型返回空内容」', async () => {
    const ladder = fakeLadderAllMiss()
    const llmForTask = makeLlmForTask({ executor: ladder, bindings })
    await expect(summarizeViaLlm(llmForTask, input)).rejects.toThrow(LadderError)
    await expect(summarizeViaLlm(llmForTask, input)).rejects.toThrow('LLM 未配置，请在设置中填写')
  })
})
