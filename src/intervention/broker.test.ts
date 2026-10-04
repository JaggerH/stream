import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InterventionBroker, classifyLlmError, type BrokerDeps } from './broker.ts'
import { InterventionRunStore } from './run-store.ts'
import { ObservationLedger } from '../replay/observation-ledger.ts'
import type { LlmForTask } from '../llm/task.ts'
import type { EventInput } from '../events/store.ts'

const mk = (llm: LlmForTask | undefined) => {
  const store = new InterventionRunStore(':memory:')
  const observations = new ObservationLedger(mkdtempSync(join(tmpdir(), 'obs-')))
  const notes: EventInput[] = []
  const broker = new InterventionBroker({ store, observations, llm: () => llm, notify: (e) => notes.push(e), log: () => {} })
  return { store, observations, notes, broker }
}
const scene = { side: 'browser' as const, url: 'https://x.com/s?q=1', elements: [{ name: '搜索', rect: { x: 0, y: 0, w: 1, h: 1 } }] }
const known = [{ id: 'x/home', features: [{ kind: 'url' as const, pattern: 'https://x.com/' }] }]

describe('InterventionBroker · proposeState', () => {
  it('没配 LLM → run error(llm_unconfigured) + 一条通知 + 一行日志，不抛', async () => {
    const { store, notes, broker } = mk(undefined)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const run = store.list()[0]!
    expect(run.status).toBe('error')
    expect(run.error?.code).toBe('llm_unconfigured')
    expect(notes.some((n) => n.type === 'intervention.error')).toBe(true)
  })

  it('答案过闸 → 提议 pending、run done(proposal/end_turn)、通知一条、usage 记上', async () => {
    const llm: LlmForTask = async () => ({ content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://x.com/s*"}],"rationale":"结果页"}', raw: { usage: { prompt_tokens: 10, completion_tokens: 2 } } })
    const { store, notes, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const run = store.list()[0]!
    expect(run.status).toBe('done')
    expect(run.stopped).toEqual({ produced: 'proposal', reason: 'end_turn' })
    expect(run.usage).toMatchObject({ promptTokens: 10, completionTokens: 2, turns: 1, reported: true })
    const ps = store.proposals({ runId: run.id })
    expect(ps).toHaveLength(1)
    expect(ps[0]!.status).toBe('pending')
    expect(ps[0]!.scene?.side).toBe('browser')
    const note = notes.find((n) => n.type === 'intervention.proposal')!
    // 通知标题说人话：讲它认出了什么、叫什么名字，不把 `kind` 的枚举名（"state提议"）漏给人看。
    expect(note.title).toContain('x/results')
    expect(note.title).not.toMatch(/\bstate/)
    const kinds = store.events(run.id).map((e) => e.kind)
    expect(kinds).toContain('tool_call')
    expect(kinds).toContain('proposal')
  })

  it('答案此刻不成立（url 特征对不上现场）→ 提议 rejected-by-gate(not-observed)，run 仍 done 但 produced:nothing', async () => {
    const llm: LlmForTask = async () => ({ content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://other.com/*"}],"rationale":"x"}', raw: {} })
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const run = store.list()[0]!
    expect(run.stopped).toEqual({ produced: 'nothing', reason: 'end_turn' })
    expect(store.proposals({ runId: run.id })[0]!).toMatchObject({ status: 'rejected-by-gate', rejection: 'not-observed' })
  })

  it('答案和已知状态撞车 → not-discriminative', async () => {
    const llm: LlmForTask = async () => ({ content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://x.com/*"}],"rationale":"x"}', raw: {} })
    const { store, observations, broker } = mk(llm)
    observations.record('x', { state: 'x/home', truths: ['url:https://x.com/*'] })
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    expect(store.proposals()[0]!).toMatchObject({ status: 'rejected-by-gate', rejection: 'not-discriminative' })
  })

  it('模型说修不了 → verdict-unrepairable / end_turn，无提议', async () => {
    const llm: LlmForTask = async () => ({ content: '{"unrepairable":true,"rationale":"要登录"}', raw: {} })
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    expect(store.list()[0]!.stopped).toEqual({ produced: 'verdict-unrepairable', reason: 'end_turn' })
    expect(store.proposals()).toHaveLength(0)
  })

  it('同源同指纹第二次不再调 LLM：cache_hit 事件、0 turns', async () => {
    let calls = 0
    const llm: LlmForTask = async () => { calls++; return { content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://x.com/s*"}],"rationale":"结果页"}', raw: {} } }
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    expect(calls).toBe(1)
    const second = store.list()[0]!
    expect(second.usage.turns).toBe(0)
    expect(store.events(second.id).some((e) => e.kind === 'cache_hit')).toBe(true)
    expect(second.stopped).toEqual({ produced: 'proposal', reason: 'end_turn' })
  })

  it('梯子全员失败 → error(llm_all_failed)，402/余额类文案 → llm_out_of_credits，非梯子错 → internal', async () => {
    const { LadderError } = await import('../providers/ladder-trace.ts')
    const rung = { member: 'deepseek', source: 'llm-openai', ms: 1, outcome: 'error' as const }
    const llm: LlmForTask = async () => { throw new LadderError('LLM 梯子上没有一个成员答成：deepseek: error（402 Insufficient Balance）', { via: null, rungs: [{ ...rung, reason: '402 Insufficient Balance' }] }) }
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    expect(store.list()[0]!.error?.code).toBe('llm_out_of_credits')

    // 梯子有成员、文案里没有余额词 → 「配了但全失败」，不能和「没配」「没钱」合成一种红。
    const allFailed = new LadderError('LLM 梯子上没有一个成员答成：deepseek: error（connect ETIMEDOUT）', { via: null, rungs: [{ ...rung, reason: 'connect ETIMEDOUT' }] })
    expect(classifyLlmError(allFailed).code).toBe('llm_all_failed')
    // 一个成员都没配：rungs 空。
    expect(classifyLlmError(new LadderError('梯子上一个成员都没有', { via: null, rungs: [] })).code).toBe('llm_unconfigured')
    // 压根不是 LadderError（Broker / 存储自己的 bug）→ internal，别冒充成 LLM 的错。
    expect(classifyLlmError(new TypeError('x is not a function')).code).toBe('internal')
  })

  it('被闸拒的答案也进缓存，但第二次命中报 produced:nothing（不是凭空多一条提议），且不再调 LLM', async () => {
    let calls = 0
    const llm: LlmForTask = async () => { calls++; return { content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://other.com/*"}],"rationale":"x"}', raw: {} } }
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    expect(calls).toBe(1)
    const second = store.list()[0]!
    expect(second.stopped).toEqual({ produced: 'nothing', reason: 'end_turn' })
    const hit = store.events(second.id).find((e) => e.kind === 'cache_hit')!
    expect(hit.title).toContain('被拒')
  })

  /**
   * 缓存在库里、不在进程内：后端一重载，同一个界面第二次落空又会重新问一次模型——
   * 一次白烧的 token 加一次白等，而没有任何一处会喊。用「同一个 store 新建一个 Broker」
   * 模拟重启（进程内 Map 的实现在这里必红）。
   */
  it('换了个 Broker（同一份库）同指纹再问 → 仍然 cache_hit，不调 LLM', async () => {
    let calls = 0
    const llm: LlmForTask = async () => { calls++; return { content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://x.com/s*"}],"rationale":"结果页"}', raw: {} } }
    const { store, observations, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const reborn = new InterventionBroker({ store, observations, llm: () => llm, notify: () => {}, log: () => {} })
    await reborn.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    expect(calls).toBe(1)
    const second = store.list()[0]!
    expect(second.usage.turns).toBe(0)
    expect(store.events(second.id).some((e) => e.kind === 'cache_hit')).toBe(true)
  })

  /** 人拒过的答案比闸拒更硬：复用时必须报「什么都没产出」，并说清命中的是被人拒过的那条。 */
  it('提议被人拒之后再问 → cache_hit 说明是被人拒过的答案，produced:nothing', async () => {
    const llm: LlmForTask = async () => ({ content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://x.com/s*"}],"rationale":"结果页"}', raw: {} })
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const prop = store.proposals()[0]!
    store.setProposalStatus(prop.id, 'rejected-by-user')
    store.setAnswerStatusByProposal(prop.id, 'rejected-by-user')
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const second = store.list()[0]!
    expect(second.stopped).toEqual({ produced: 'nothing', reason: 'end_turn' })
    expect(store.events(second.id).find((e) => e.kind === 'cache_hit')!.title).toContain('被人拒过')
  })

  /** 缓存条目是 accepted（人已经接受、状态图已经吃了这个答案）→ 命中时不调 LLM、
   *  不新建提议（本来 cache_hit 分支就不建），produced 仍是 proposal（照旧）。 */
  it('缓存条目为 accepted 时命中 → 不调 LLM、不新建提议、produced:proposal', async () => {
    let calls = 0
    const llm: LlmForTask = async () => { calls++; return { content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://x.com/s*"}],"rationale":"结果页"}', raw: {} } }
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const prop = store.proposals()[0]!
    store.setProposalStatus(prop.id, 'accepted')
    store.setAnswerStatusByProposal(prop.id, 'accepted')
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    expect(calls).toBe(1)
    const second = store.list()[0]!
    expect(second.usage.turns).toBe(0)
    expect(second.stopped).toEqual({ produced: 'proposal', reason: 'end_turn' })
    expect(store.proposals()).toHaveLength(1) // 还是原来那一条，没有新落一条
    expect(store.events(second.id).find((e) => e.kind === 'cache_hit')!.title).toContain('已被人接受过')
  })

  it('候选没有 group 而已知里有带组的状态 → gateNote 说清「区分度只和无组状态比过」', async () => {
    const llm: LlmForTask = async () => ({ content: '{"stateId":"x/results","features":[{"kind":"url","pattern":"https://x.com/s*"}],"rationale":"结果页"}', raw: {} })
    const { store, broker } = mk(llm)
    const grouped = [{ id: 'x/home', features: [{ kind: 'url' as const, pattern: 'https://x.com/' }], group: '首页组' }]
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known: grouped })
    const prop = store.proposals()[0]!
    expect(prop.status).toBe('pending')
    expect(prop.gateNote).toContain('区分度只和无组状态比过：候选没有 group，与 首页组 这些组的状态没比')
  })

  /**
   * 活体 2026-09-11：xhs-search（浏览器侧）上模型提了一条 `text` 特征。它进图之后，那个
   * facility 的每一趟 identify 都会在 `DomPerception` 里抛，而 `classifyByState` 把它 catch 成
   * 一行「状态诊断失败」——引擎从此一个状态都认不出，日志里只有那一行。所以必须拒在入库之前。
   */
  it('浏览器侧答了一条 text 特征 → 拒，且说清是这条路线判不了', async () => {
    const llm: LlmForTask = async () => ({ content: '{"stateId":"x/results","features":[{"kind":"text","text":"搜索结果"}],"rationale":"x"}', raw: {} })
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const prop = store.proposals()[0]!
    expect(prop.status).toBe('rejected-by-gate')
    expect(prop.gateNote).toContain('浏览器这条路线判不了 text 特征')
    expect(store.list()[0]!.stopped).toEqual({ produced: 'nothing', reason: 'end_turn' })
  })

  /** 模型把 stateId 写成 sourceId 前缀（活体上就是 `xhs-search/search`）→ 改写 + 在 gateNote 里留痕。 */
  it('stateId 前缀被按 facility 改写 → 提议里是改过的名字，gateNote 说清改了什么', async () => {
    const llm: LlmForTask = async () => ({ content: '{"stateId":"x-search/results","features":[{"kind":"url","pattern":"https://x.com/s*"}],"rationale":"结果页"}', raw: {} })
    const { store, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    const prop = store.proposals()[0]!
    expect(prop.status).toBe('pending')
    expect(prop.stateId).toBe('x/results')
    expect(prop.gateNote).toContain('stateId 前缀按 facility 改写：x-search/results → x/results')
  })

  it('transition：模型既没给 name 也没给 selector → gateNote 说「目标没有 name 也没有 selector」', async () => {
    const llm: LlmForTask = async () => ({ content: '{"target":{"n":3},"action":"click","rationale":"x"}', raw: {} })
    const { store, broker } = mk(llm)
    await broker.proposeTransition({ sourceId: 'x/search', facility: 'x', kind: 'transition', reason: 'r', observed: [], scene, known, from: 'x/home', goal: 'x/results' })
    expect(store.proposals()[0]!).toMatchObject({ status: 'rejected-by-gate', rejection: 'target-unresolvable', gateNote: '目标没有 name 也没有 selector' })
  })
})

describe('InterventionBroker · 永不抛', () => {
  it('store.create 抛 / notify 抛，五个公开口都 resolve 不 reject', async () => {
    const store = new InterventionRunStore(':memory:')
    // `create` 是 ask() 里唯一曾在 try 之外的一行——它抛出去就把「状态图缺一条」升级成「采集炸了」。
    ;(store as unknown as { create: () => never }).create = () => { throw new Error('create 炸了') }
    const observations = new ObservationLedger(mkdtempSync(join(tmpdir(), 'obs-')))
    const broker = new InterventionBroker({
      store, observations, llm: () => undefined,
      notify: () => { throw new Error('notify 炸了') },
      log: () => {},
    })
    const p = { sourceId: 'x/search', facility: 'x', reason: 'r', observed: [], scene, known }
    await expect(broker.proposeState({ ...p, kind: 'state' })).resolves.toBeUndefined()
    await expect(broker.proposeDiscriminator({ ...p, kind: 'discriminator', candidates: ['a', 'b'] })).resolves.toBeUndefined()
    await expect(broker.proposeTransition({ ...p, kind: 'transition', from: 'a', goal: 'b' })).resolves.toBeUndefined()
    await expect(broker.proposeLocator({ sourceId: 'x/search', see: { text: '发送' }, wasVia: 'template', reason: 'r' })).resolves.toBeUndefined()
    await expect(broker.requestRepair({ sourceId: 'x/search', reason: 'drift x3' })).resolves.toBeUndefined()
  })
})

describe('InterventionBroker · 其它三口', () => {
  it('proposeLocator：不问模型，直接落一条 locator 提议（人审），run done', async () => {
    const { store, broker } = mk(undefined)
    await broker.proposeLocator({ sourceId: 'qq/send', see: { text: '发送' }, wasVia: 'template', reason: 'expect 未兑现' })
    expect(store.proposals()[0]!).toMatchObject({ kind: 'locator', status: 'pending' })
    expect(store.list()[0]!.stopped).toEqual({ produced: 'proposal', reason: 'end_turn' })
  })
  /** 去重键按整段原文的哈希算：LLM 的错误原文常带同样的长前缀，截前 40 字会让两种红共用一个键。 */
  it('两条前缀相同、结尾不同的错误 → dedupeKey 不同（不会被当重复吞掉）', async () => {
    const prefix = 'LLM 梯子上没有一个成员答成：deepseek: error（原因见下）——'
    let n = 0
    const llm: LlmForTask = async () => { throw new Error(`${prefix}${n++ === 0 ? '连接超时' : '余额不足另一种红'}`) }
    const { notes, broker } = mk(llm)
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene, known })
    await broker.proposeState({ sourceId: 'x/search', facility: 'x', kind: 'state', reason: 'r', observed: [], scene: { ...scene, url: 'https://x.com/s?q=2' }, known })
    const keys = notes.filter((e) => e.type === 'intervention.error').map((e) => e.dedupeKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  /** 中途抛了也不许留一条永远停在 `running` 的孤儿 run——那和"正在跑"长得一模一样。 */
  it('proposeLocator 中途抛 → run 落成 error，不留孤儿 running', async () => {
    const { store, broker } = mk(undefined)
    const boom = new Error('库锁住了')
    ;(store as unknown as { addProposal: () => never }).addProposal = () => { throw boom }
    await expect(broker.proposeLocator({ sourceId: 'qq/send', see: { text: '发送' }, wasVia: 'template', reason: 'r' })).resolves.toBeUndefined()
    const run = store.list()[0]!
    expect(run.status).toBe('error')
    expect(run.error).toMatchObject({ code: 'internal', message: '库锁住了' })
  })

  it('requestRepair：没接 repairs 时只落通知 + 日志', async () => {
    const { notes, broker } = mk(undefined)
    await broker.requestRepair({ sourceId: 'x/search', reason: 'drift x3' })
    expect(notes.some((n) => n.type === 'intervention.repair-needed')).toBe(true)
  })
})

describe('InterventionBroker · requestRepair 接 agent 档', () => {
  const withRepairs = (repairs: BrokerDeps['repairs']) => {
    const store = new InterventionRunStore(':memory:')
    const observations = new ObservationLedger(mkdtempSync(join(tmpdir(), 'obs-')))
    const notes: EventInput[] = []
    const logs: string[] = []
    const broker = new InterventionBroker({
      store, observations, llm: () => undefined,
      notify: (e) => notes.push(e), log: (...a) => logs.push(a.join(' ')),
      ...(repairs ? { repairs } : {}),
    })
    return { notes, logs, broker }
  }

  it('repairs 说 unconfigured → 退回第一期行为：warn 通知 + 指路日志', async () => {
    const { notes, logs, broker } = withRepairs({ start: () => 'unconfigured' })
    await broker.requestRepair({ sourceId: 'x', reason: 'r' })
    expect(notes[0]).toMatchObject({ type: 'intervention.repair-needed', severity: 'warn' })
    expect(logs.join('\n')).toContain('ai-agent')
  })

  it('repairs 开了 run → 不再落 repair-needed 通知（run 自己会通知），日志记 runId', async () => {
    const { notes, logs, broker } = withRepairs({ start: () => ({ runId: 'R1' }) })
    await broker.requestRepair({ sourceId: 'x', reason: 'r', affectedSources: ['x', 'y'] })
    expect(notes.some((n) => n.type === 'intervention.repair-needed')).toBe(false)
    expect(logs.join('\n')).toContain('R1')
    expect(logs.join('\n')).toContain('y')            // 被连累的源也点名
  })

  it('repairs 回一条已标错的 run（包找不到）→ 日志说「已标错」而不是「开了会话」，通知归 manager 发', async () => {
    const { notes, logs, broker } = withRepairs({ start: () => ({ runId: 'R2', failed: true }) })
    await broker.requestRepair({ sourceId: 'x', reason: 'r' })
    expect(logs.join('\n')).toContain('R2')
    expect(logs.join('\n')).toContain('已标错')
    expect(logs.join('\n')).not.toContain('开了 agent 修复会话')
    expect(notes).toHaveLength(0)
  })

  it('repairs 说 busy → info 通知说明已有会话在修，去重键与首次那条分开', async () => {
    const { notes, broker } = withRepairs({ start: () => 'busy' })
    await broker.requestRepair({ sourceId: 'x', reason: 'r' })
    expect(notes[0]!.title).toContain('已有')
    expect(notes[0]!.severity).toBe('info')
    expect(notes[0]!.dedupeKey).toContain('repair-busy')
  })
})
