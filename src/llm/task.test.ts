import { describe, it, expect } from 'vitest'
import {
  makeLlmForTask,
  resolveLadderEndpoint,
  ladderEndpoints,
  summarizeViaLlm,
  llmContentQuiet,
  chatViaLlm,
  type LlmForTask,
} from './task.ts'
import type { InvokeResult } from '../providers/executor.ts'
import type { ProviderBinding, ProviderRecord } from '../store/types.ts'
import type { LlmChatInput } from './sources.ts'

const input: LlmChatInput = {
  messages: [{ role: 'user', content: 'q' }],
  temperature: 0.3,
  tools: [{ type: 'function', function: { name: 'ping' } }],
}

/** A recording fake ladder: captures (ref, input, opts) and replays a canned InvokeResult. */
function fakeLadder(result: InvokeResult | null) {
  const calls: Array<{ ref: string; input: unknown; opts?: { overrides?: Record<string, unknown> } }> = []
  return {
    calls,
    invoke: async (ref: string, inp: unknown, opts?: { overrides?: Record<string, unknown> }) => {
      calls.push({ ref, input: inp, opts })
      return result
    },
  }
}
const seq = (value: unknown): InvokeResult => ({ strategy: 'sequential', provider: 'llm', value, via: 'm', misses: [], timings: [] } as InvokeResult)
const bindings = (map: Record<string, ProviderBinding>) => ({
  binding: (id: string) => map[id] ?? null,
  fixed: (id: string) => map[id]?.providerIds[0] ?? null,
})

describe('makeLlmForTask', () => {
  it('绑定的 params.model 经 executor overrides 下传，input 原样不动', async () => {
    const ladder = fakeLadder(seq([{ content: 'hi', raw: {} }]))
    const llmForTask = makeLlmForTask({
      executor: ladder,
      bindings: bindings({ 'llm.chat': { callsiteId: 'llm.chat', providerIds: ['llm'], params: { model: 'kimi-k2' } } }),
    })
    const out = await llmForTask('llm.chat', input)
    expect(out?.content).toBe('hi')
    expect(ladder.calls).toHaveLength(1)
    expect(ladder.calls[0].ref).toBe('llm')
    // model 走 overrides（成员 params 层），不混进 input——input.model 会压过成员默认，语义不同
    expect(ladder.calls[0].opts).toEqual({ overrides: { model: 'kimi-k2' } })
    expect(ladder.calls[0].input).toEqual(input)
    expect((ladder.calls[0].input as LlmChatInput).model).toBeUndefined()
  })

  it('网盘调用点：model 只走绑定覆盖，绝不塞进 input（旧代码是 {...input, model} 拼进去的）', async () => {
    const ladder = fakeLadder(seq([{ content: '{"spec":1}', raw: {} }]))
    const llmForTask = makeLlmForTask({
      executor: ladder,
      bindings: bindings({ 'netdisk.spec.suggest': { callsiteId: 'netdisk.spec.suggest', providerIds: ['llm'], params: { model: 'nd-mini' } } }),
    })
    const ndInput = { messages: [{ role: 'user' as const, content: '残差' }], temperature: 0 }
    const out = await llmForTask('netdisk.spec.suggest', ndInput)
    expect(out?.content).toBe('{"spec":1}')
    expect(ladder.calls[0].input).toEqual(ndInput)
    expect(ladder.calls[0].opts).toEqual({ overrides: { model: 'nd-mini' } })
  })

  it('绑定选的是哪条行就打哪条（在下拉里换 Provider 不能是空动作）；没绑定才兜底 llm', async () => {
    const ladder = fakeLadder(seq([{ content: 'x', raw: {} }]))
    const llmForTask = makeLlmForTask({
      executor: ladder,
      bindings: bindings({ 'llm.chat': { callsiteId: 'llm.chat', providerIds: ['my-local-llm'] } }),
    })
    await llmForTask('llm.chat', input)
    await llmForTask('llm.summarize', input) // 没有绑定行
    expect(ladder.calls.map((c) => c.ref)).toEqual(['my-local-llm', 'llm'])
  })

  it('tools / temperature 原样穿过', async () => {
    const ladder = fakeLadder(seq([{ content: 'x', raw: {} }]))
    const llmForTask = makeLlmForTask({ executor: ladder, bindings: bindings({}) })
    await llmForTask('llm.chat', input)
    const sent = ladder.calls[0].input as LlmChatInput
    expect(sent.tools).toEqual(input.tools)
    expect(sent.temperature).toBe(0.3)
  })

  it('绑定没有 model（或空串）→ 不传 overrides，成员用自己的 params.model', async () => {
    const ladder = fakeLadder(seq([{ content: 'x', raw: {} }]))
    const llmForTask = makeLlmForTask({
      executor: ladder,
      bindings: bindings({
        'llm.summarize': { callsiteId: 'llm.summarize', providerIds: ['llm'] },
        'llm.chat': { callsiteId: 'llm.chat', providerIds: ['llm'], params: { model: '' } },
      }),
    })
    await llmForTask('llm.summarize', input)
    await llmForTask('llm.chat', input)
    expect(ladder.calls[0].opts).toBeUndefined()
    expect(ladder.calls[1].opts).toBeUndefined()
  })

  it('梯子全 decline（value=null）→ null，不抛', async () => {
    const ladder = fakeLadder(seq(null))
    const llmForTask = makeLlmForTask({ executor: ladder, bindings: bindings({}) })
    await expect(llmForTask('llm.chat', input)).resolves.toBeNull()
  })

  it('行不存在（invoke 返回 null）→ null', async () => {
    const llmForTask = makeLlmForTask({ executor: fakeLadder(null), bindings: bindings({}) })
    await expect(llmForTask('llm.chat', input)).resolves.toBeNull()
  })

  it('非 sequential 结果（行被改成 concurrent）→ null，不当成成功', async () => {
    const ladder = fakeLadder({ strategy: 'concurrent', provider: 'llm', items: [{ content: 'x' }], sources: ['m'], misses: [], timings: [] })
    const llmForTask = makeLlmForTask({ executor: ladder, bindings: bindings({}) })
    await expect(llmForTask('llm.chat', input)).resolves.toBeNull()
  })
})

describe('summarizeViaLlm', () => {
  it('走 llm.summarize 调用点，返回 trim 后的正文', async () => {
    const seen: string[] = []
    const out = await summarizeViaLlm(async (id) => { seen.push(id); return { content: '  要点  ', raw: {} } }, input)
    expect(out.summary).toBe('要点')
    expect(seen).toEqual(['llm.summarize'])
  })

  it('梯子无结果（未配置/全 decline）→ 抛「未配置」，文案不变', async () => {
    await expect(summarizeViaLlm(async () => null, input)).rejects.toThrow('LLM 未配置，请在设置中填写')
  })

  it('模型返回空内容 → 抛「返回空内容」，不当成一份空摘要落库', async () => {
    await expect(summarizeViaLlm(async () => ({ content: '   ', raw: {} }), input)).rejects.toThrow('模型返回空内容')
    await expect(summarizeViaLlm(async () => ({ content: null, raw: {} }), input)).rejects.toThrow('模型返回空内容')
  })
})

describe('llmContentQuiet（抽名路：拿不到就算了，绝不抛）', () => {
  it('拿到正文就原样返回', async () => {
    const seen: string[] = []
    const out = await llmContentQuiet(async (id) => { seen.push(id); return { content: '林简七', raw: {} } }, 'llm.summarize', input)
    expect(out).toBe('林简七')
    expect(seen).toEqual(['llm.summarize'])
  })

  it('梯子无结果 → null（簇留匿名，不硬认）', async () => {
    await expect(llmContentQuiet(async () => null, 'llm.summarize', input)).resolves.toBeNull()
  })

  it('调用抛错（HTTP 挂 / 行配置炸）→ null，不把异常捅进转写流程', async () => {
    await expect(
      llmContentQuiet(async () => { throw new Error('boom') }, 'llm.summarize', input),
    ).resolves.toBeNull()
  })

  it('只有 tool_calls、content 为 null → null', async () => {
    await expect(llmContentQuiet(async () => ({ content: null, raw: {} }), 'llm.summarize', input)).resolves.toBeNull()
  })
})

describe('chatViaLlm（搜索 agent 的 LLM 关节）', () => {
  it('走 llm.chat 调用点，把整个 ChatResult 交回去（tool_calls 也在）', async () => {
    const seen: Array<{ id: string; input: LlmChatInput }> = []
    const result = { content: 'ok', toolCalls: [{ id: 'c1' }], raw: {} }
    const out = await chatViaLlm(async (id, inp) => { seen.push({ id, input: inp }); return result }, input)
    expect(out).toBe(result)
    expect(seen[0].id).toBe('llm.chat')
    expect(seen[0].input.temperature).toBe(0.3)
    expect(seen[0].input.tools).toEqual(input.tools)
  })

  it('梯子无结果 → 抛「LLM 未配置」（搜索 agent 的轨迹里要看得见这一步失败）', async () => {
    await expect(chatViaLlm(async () => null, input)).rejects.toThrow('LLM 未配置')
  })
})

/** 一条 llm variant 行（只填 resolveLadderEndpoint 读的字段）。 */
const row = (id: string, members: ProviderRecord['members'], options: Record<string, unknown> = {}): ProviderRecord => ({
  id, label: id, description: '', category: 'llm', serves: ['*'], strategy: 'sequential', members,
  contract: null, options, system: true,
})
/** rows + bindings → resolveLadderEndpoint 的 deps。token 只认得 llm:kimi。 */
const ladderDeps = (rows: ProviderRecord[], bound: Record<string, ProviderBinding> = {}) => ({
  getProvider: (id: string) => rows.find((r) => r.id === id) ?? null,
  bindings: bindings(bound),
  getSettings: () => undefined,
  token: (n: string) => (n === 'llm:kimi' ? 'sk-kimi' : null),
})
const kimi = { source: 'llm-openai', name: 'kimi', params: { baseUrl: 'https://k/v1', model: 'm-k', tokenName: 'llm:kimi' } }

describe('resolveLadderEndpoint', () => {
  it('取梯子上第一个钥匙+model 齐全的自足成员', () => {
    const ep = resolveLadderEndpoint('llm.chat', ladderDeps([
      row('llm', [{ source: 'llm-openai', name: 'nokey', params: { baseUrl: 'https://a/v1', model: 'm-a', tokenName: 'llm:nokey' } }, kimi]),
    ]))
    expect(ep).toEqual({ baseUrl: 'https://k/v1', apiKey: 'sk-kimi', model: 'm-k' })
  })

  it('绑定的 model 覆盖盖过成员默认', () => {
    const ep = resolveLadderEndpoint('llm.chat', ladderDeps(
      [row('llm', [kimi])],
      { 'llm.chat': { callsiteId: 'llm.chat', providerIds: ['llm'], params: { model: 'chat-model' } } },
    ))
    expect(ep?.model).toBe('chat-model')
  })

  it('绑定指向另一条 llm 行 → 解析那条行的成员（换 Provider 对流式聊天同样生效）', () => {
    const other = row('my-local-llm', [{ source: 'llm-openai', name: 'local', params: { baseUrl: 'https://local/v1', model: 'qwen', tokenName: 'llm:kimi' } }])
    const ep = resolveLadderEndpoint('llm.chat', ladderDeps(
      [row('llm', [kimi]), other],
      { 'llm.chat': { callsiteId: 'llm.chat', providerIds: ['my-local-llm'] } },
    ))
    expect(ep?.baseUrl).toBe('https://local/v1')
  })

  it('options.exclude 排除掉的成员跳过，落到下一个（与 executor 的寻址键同一条规矩）', () => {
    const excludedFirst = row(
      'llm',
      [
        { source: 'llm-openai', name: 'kimi-a', params: { baseUrl: 'https://a/v1', model: 'm-a', tokenName: 'llm:kimi' } },
        { source: 'llm-openai', name: 'kimi-b', params: { baseUrl: 'https://b/v1', model: 'm-b', tokenName: 'llm:kimi' } },
      ],
      { exclude: ['kimi-a'] },
    )
    expect(resolveLadderEndpoint('llm.chat', ladderDeps([excludedFirst]))?.baseUrl).toBe('https://b/v1')
    // 没有实例名时寻址键 = 源 id，同样按它排除
    const noName = row('llm', [{ source: 'llm-openai', params: { baseUrl: 'https://a/v1', model: 'm-a', tokenName: 'llm:kimi' } }], { exclude: ['llm-openai'] })
    expect(resolveLadderEndpoint('llm.chat', ladderDeps([noName]))).toBeNull()
  })

  it('指名某个成员 → 用它，不再是第一个（抽屉里换模型走的就是这条）', () => {
    const deps = ladderDeps([
      row('llm', [
        kimi,
        { source: 'llm-openai', name: 'kimi2', params: { baseUrl: 'https://k2/v1', model: 'm-k2', tokenName: 'llm:kimi' } },
      ]),
    ])
    expect(resolveLadderEndpoint('llm.chat', deps, 'kimi2')?.model).toBe('m-k2')
    expect(resolveLadderEndpoint('llm.chat', deps)?.model).toBe('m-k') // 不指名还是第一个
  })

  it('指名的成员已经不在（被删/钥匙没了）→ 回落第一个，不是报错', () => {
    // 会话里存着一个过期的选择时，代价该是"换个模型接着答"，不是这条会话从此打不开。
    const deps = ladderDeps([row('llm', [kimi])])
    expect(resolveLadderEndpoint('llm.chat', deps, 'gone')?.model).toBe('m-k')
  })

  it('没有可用成员 / 行不存在 → null（调用方据此回 503）', () => {
    expect(resolveLadderEndpoint('llm.chat', ladderDeps([row('llm', [])]))).toBeNull()
    expect(resolveLadderEndpoint('llm.chat', ladderDeps([]))).toBeNull() // 绑定指向的行没了
    expect(
      resolveLadderEndpoint('llm.chat', ladderDeps([row('llm', [{ source: 'llm-openai', params: { baseUrl: 'https://a/v1', tokenName: 'llm:kimi' } }])])),
    ).toBeNull() // 有 key 无 model
  })

  it('跳过 auto 段 / 组合成员 / 非 llm-openai 源（这些形状不支持流式端点解析）', () => {
    const ep = resolveLadderEndpoint('llm.chat', ladderDeps([
      row('llm', [
        { mode: 'auto', provides: 'llm' },
        { provider: 'other' },
        { source: 'some-other-llm', name: 'x', params: { baseUrl: 'https://x/v1', model: 'm', tokenName: 'llm:kimi' } },
        kimi,
      ]),
    ]))
    expect(ep?.baseUrl).toBe('https://k/v1')
  })

  // 成员不自带端点就没有别处可查了（`connectionId` → LlmSettings 连接表那条腿已退役）：跳过它，
  // 继续往后找下一个齐全的成员。这条守的是"退役之后不会静默解析出一个半成品端点"。
  it('成员没有 baseUrl → 跳过它，不去别处补', () => {
    const ep = resolveLadderEndpoint('llm.chat', {
      getProvider: () => row('llm', [
        { source: 'llm-openai', params: { model: 'm', tokenName: 'llm:half' } }, // 缺端点
        { source: 'llm-openai', params: { baseUrl: 'https://ok/v1', model: 'm2', tokenName: 'llm:ok' } },
      ]),
      bindings: bindings({ 'llm.chat': { callsiteId: 'llm.chat', providerIds: ['llm'] } }),
      token: (n) => (n === 'llm:ok' ? 'sk-ok' : 'sk-half'),
    })
    expect(ep).toEqual({ baseUrl: 'https://ok/v1', apiKey: 'sk-ok', model: 'm2' })
  })
})

describe('ladderEndpoints', () => {
  it('列出全部可用成员（行内顺序），钥匙缺失和 exclude 掉的都不进表', () => {
    const rows = [
      row(
        'llm',
        [
          { source: 'llm-openai', name: 'nokey', params: { baseUrl: 'https://a/v1', model: 'm-a', tokenName: 'llm:nokey' } },
          kimi,
          { source: 'llm-openai', name: 'kimi2', params: { baseUrl: 'https://k2/v1', model: 'm-k2', tokenName: 'llm:kimi' } },
          { source: 'llm-openai', name: 'dropped', params: { baseUrl: 'https://d/v1', model: 'm-d', tokenName: 'llm:kimi' } },
        ],
        { exclude: ['dropped'] },
      ),
    ]
    expect(ladderEndpoints('llm.chat', ladderDeps(rows)).map((e) => [e.member, e.endpoint.model])).toEqual([
      ['kimi', 'm-k'],
      ['kimi2', 'm-k2'],
    ])
  })

  // 寻址键必须唯一指回一个成员——重名时留谁全看遍历顺序，那会话里存的那个键就没有确定含义。
  it('同名成员只留第一个', () => {
    const dup = row('llm', [kimi, { ...kimi, params: { ...kimi.params, model: 'm-dup' } }])
    expect(ladderEndpoints('llm.chat', ladderDeps([dup])).map((e) => e.endpoint.model)).toEqual(['m-k'])
  })

  it('第一项 = resolveLadderEndpoint 不指名时给的那个（下拉的默认项和实际默认不能是两回事）', () => {
    const deps = ladderDeps([row('llm', [kimi, { source: 'llm-openai', name: 'kimi2', params: { baseUrl: 'https://k2/v1', model: 'm-k2', tokenName: 'llm:kimi' } }])])
    expect(ladderEndpoints('llm.chat', deps)[0]?.endpoint).toEqual(resolveLadderEndpoint('llm.chat', deps))
  })

  it('行不存在 / 没有可用成员 → 空表（前端据此整格不画）', () => {
    expect(ladderEndpoints('llm.chat', ladderDeps([]))).toEqual([])
    expect(ladderEndpoints('llm.chat', ladderDeps([row('llm', [])]))).toEqual([])
  })
})

describe('chatViaLlm 的失败措辞', () => {
  it('**梯子上有人试过但全失败 → 说清谁怎么了**，不许一律说成「未配置」', async () => {
    const forTask: LlmForTask = async (_id, _input, opts) => {
      opts?.onLadder?.({
        via: null,
        rungs: [
          { member: 'deepseek', source: 'llm-openai', ms: 12, outcome: 'error', reason: 'HTTP 402 Insufficient Balance' },
          { member: 'zhipu', source: 'llm-openai', ms: 9, outcome: 'error', reason: 'HTTP 429 余额不足' },
        ],
      })
      return null
    }
    // 活体 2026-09-02：三个成员全欠费，而这句话说的是「去设置里填」——把人指去改一份本来就
    // 填对了的配置，真因一个字都不出现，白跑一轮验收。
    await expect(chatViaLlm(forTask, { messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /deepseek: error（HTTP 402 Insufficient Balance）/,
    )
  })

  it('一个成员都没试过（rungs 为空）才是真的「未配置」', async () => {
    const forTask: LlmForTask = async (_id, _input, opts) => {
      opts?.onLadder?.({ via: null, rungs: [] })
      return null
    }
    await expect(chatViaLlm(forTask, { messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/未配置/)
  })
})
