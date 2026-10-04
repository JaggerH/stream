import { describe, expect, it } from 'vitest'
import { unblockOptionsFor } from './unblock.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { LadderTrace } from '../providers/ladder-trace.ts'

function m(id: string, ref?: string, provisions?: string[]): SourceManifest {
  return {
    id, title: id,
    runtime_config: ref ? { ref, fields: {}, provisions } : undefined,
  } as unknown as SourceManifest
}

// `groq-stt` 是**消费方**（用那把 key 干活，自己补不了它），`groq-create-key` 是能补的那条。
// 两条声明同一个 ref——这正是 selfProvisionRecipesFor 要靠 provisions 区分的形状。
const MANIFESTS = [m('groq-stt', 'groq'), m('groq-create-key', 'groq', ['apiKey'])]

describe('unblockOptionsFor', () => {
  it('miss 的成员 + 有 recipe 能补 → 给出选项', () => {
    const trace: LadderTrace = { via: null, rungs: [{ member: 'groq', source: 'groq-stt', ms: 1, outcome: 'miss' }] }
    expect(unblockOptionsFor(trace, MANIFESTS)).toMatchObject([{ member: 'groq', sourceId: 'groq-create-key', ref: 'groq' }])
  })

  // miss 和 error 方向相反：前者去配置，后者去查故障。把 error 也当成"缺配置"，
  // 会让 agent 在一个上游挂了的时候去劝用户重新申请 key——指错方向的建议比没有建议更坏。
  it('error 的成员不给选项', () => {
    const trace: LadderTrace = { via: null, rungs: [{ member: 'groq', source: 'groq-stt', ms: 1, outcome: 'error' }] }
    expect(unblockOptionsFor(trace, MANIFESTS)).toEqual([])
  })

  it('已经有人赢了就不提议（via 非空）', () => {
    const trace: LadderTrace = { via: 'openai', rungs: [{ member: 'groq', source: 'groq-stt', ms: 1, outcome: 'miss' }] }
    expect(unblockOptionsFor(trace, MANIFESTS)).toEqual([])
  })

  it('miss 但没有 recipe 能补 → 空', () => {
    const trace: LadderTrace = { via: null, rungs: [{ member: 'x', source: 'x-stt', ms: 1, outcome: 'miss' }] }
    expect(unblockOptionsFor(trace, [m('x-stt', 'x')])).toEqual([])
  })

  // 产出 key 的那条 recipe 自己也可能作为成员上梯子。它 miss 时提议"跑它自己去补它自己"
  // 是一句废话，但**不能因此把整个 ref 静音**：同一个 ref 下另一条（如 read）仍该被提出来。
  it('弃权的就是那条能补的 recipe 自己时，不把它提给用户', () => {
    const trace: LadderTrace = { via: null, rungs: [{ member: 'groq', source: 'groq-create-key', ms: 1, outcome: 'miss' }] }
    expect(unblockOptionsFor(trace, MANIFESTS)).toEqual([])
  })

  // 同一个 ref 的两档（两个成员都缺同一把 key）只提一次——同一句建议说两遍是噪音。
  it('两个成员缺同一个 ref 时只提一次', () => {
    const trace: LadderTrace = {
      via: null,
      rungs: [
        { member: 'groq', source: 'groq-stt', ms: 1, outcome: 'miss' },
        { member: 'groq-2', source: 'groq-stt', ms: 1, outcome: 'miss' },
      ],
    }
    expect(unblockOptionsFor(trace, MANIFESTS)).toHaveLength(1)
  })

  it('rungs 为空（根本没调用）→ 空，不抛', () => {
    expect(unblockOptionsFor({ via: null, rungs: [] }, MANIFESTS)).toEqual([])
  })
})
