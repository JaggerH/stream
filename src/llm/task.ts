import type { InvokeResult } from '../providers/executor.ts'
import { ladderTrace, LadderError, type LadderTrace } from '../providers/ladder-trace.ts'
import type { ProviderBinding, ProviderRecord } from '../store/types.ts'
import type { ChatEndpoint, ChatResult } from './client.ts'
import { resolveMemberEndpoint, type LlmChatInput, type LlmOpenAiParams } from './sources.ts'
import { memberContextWindow } from './capacity.ts'

/** 任务级 LLM 调用的唯一形状：给一个调用点 id + 一次 chat 输入，拿回一个 ChatResult 或 null。
 *  null = 梯子上没有一个成员产出结果（未配置 / 全 decline / 全失败）——各调用方按自己的语义
 *  翻译（摘要抛「未配置」、抽名留匿名、聊天回 503）。 */
export type LlmForTask = (
  callsiteId: string,
  input: LlmChatInput,
  opts?: {
    /** `onLadder` = 想知道**这次是梯子上的谁答的**就传它（走法在结果之前就已确定，失败时照样回调）。
     *  做成可选回调而不是改返回类型：绝大多数调用方只要那段文本，不该被迫拆一层信封。
     *  多轮升级重试时只回调一次——合并后的**完整走法**，不是每一轮各喊一次。 */
    onLadder?: (ladder: LadderTrace) => void
    /** 结果不满足调用方的语义（如摘要没写全、抽取漏了字段）就返回 false：`makeLlmForTask` 会把
     *  当轮答话成员塞进 excludeMembers 换下一个成员重试，直到梯子上没人能答（via 为 null）为止。
     *  不传 = 逐字节沿用今天"第一个答出来的就是结果"的行为。 */
    validate?: (r: ChatResult) => boolean
  },
) => Promise<ChatResult | null>

/** 梯子。参数比 ProviderExecutor.invoke 窄一档，只为让测试造假容易。 */
interface LlmLadder {
  invoke(
    ref: string,
    input: unknown,
    opts?: { overrides?: Record<string, unknown>; excludeMembers?: string[] },
  ): Promise<InvokeResult | null>
}
/** 调用点绑定：`fixed` 说的是「这个调用点用哪条 Provider 行」（用户在下拉里换的就是它），
 *  `binding().params.model` 是这条任务的模型覆盖。两者都必须读——只读 params 会让换行成为空动作。 */
interface CallsiteBindings {
  binding(callsiteId: string): ProviderBinding | null
  fixed(callsiteId: string): string | null
}

/** 绑定挑不出行时的兜底：系统 llm 行（种子保证它存在）。 */
const DEFAULT_LLM_PROVIDER = 'llm'

/** 调用点绑定上的 model 覆盖（Task 8 落的 `params.model`）。空串/非字符串 = 没覆盖。 */
export function callsiteModel(binding: ProviderBinding | null): string | undefined {
  const model = binding?.params?.model
  return typeof model === 'string' && model ? model : undefined
}

/** 任务 → 梯子的唯一入口。model 走 executor 的 **overrides**（= 盖成员 params.model），
 *  不塞进 input：input.model 会压过每个成员自己的默认，等于把「梯子上各成员各用各的模型」这条
 *  语义抹掉；没有覆盖时干脆不传，让成员默认生效（摘要路就是靠这条回落）。 */
export function makeLlmForTask(deps: { executor: LlmLadder; bindings: CallsiteBindings }): LlmForTask {
  return async (callsiteId, input, opts) => {
    const model = callsiteModel(deps.bindings.binding(callsiteId))
    // 打哪条行由绑定说了算——写死 'llm' 会让「在下拉里换 Provider」变成空动作。
    const providerId = deps.bindings.fixed(callsiteId) ?? DEFAULT_LLM_PROVIDER
    const overrides = model ? { overrides: { model } } : undefined
    const excludeMembers: string[] = []
    const rungs: LadderTrace['rungs'] = []
    for (;;) {
      const inv = await deps.executor.invoke(
        providerId,
        input,
        excludeMembers.length ? { ...overrides, excludeMembers } : overrides,
      )
      const trace = ladderTrace(inv)
      rungs.push(...trace.rungs)
      if (!inv || inv.strategy !== 'sequential' || inv.value == null || trace.via == null) {
        opts?.onLadder?.({ via: null, rungs })
        return null
      }
      const first = Array.isArray(inv.value) ? (inv.value as ChatResult[])[0] : (inv.value as ChatResult)
      if (!first || !opts?.validate || opts.validate(first)) {
        opts?.onLadder?.({ via: trace.via, rungs })
        return first ?? null
      }
      // 被否决：把这轮答话成员记成 rejected，换掉它再试下一个。
      // 若这里 findIndex 落空（-1，理论上不该发生：trace.via 非空意味着刚 push 过一条对应的
      // win rung）——本轮就不会留下任何 rejected 记录，只是静默跳过改写、继续换成员重试。
      // 后果不止是"这一轮账没记全"：summarizeViaLlm 靠 `rungs.some(outcome==='rejected')`
      // 区分「未配置」与「生成失败」两种 null 成因——一旦这里漏记，即便梯子上有成员**答过、
      // 但全被 validate 否决**，也会被误诊成「LLM 未配置，请在设置中填写」，把真因（模型
      // 一直吐空内容）藏起来，指错方向。
      const rejectedIdx = rungs.findIndex((r) => r.member === trace.via && r.outcome === 'win')
      if (rejectedIdx >= 0) rungs[rejectedIdx] = { ...rungs[rejectedIdx], outcome: 'rejected' }
      excludeMembers.push(trace.via)
    }
  }
}

/** 非流式聊天关节（搜索 agent 的分类/扩源/切题）：梯子没结果 = 未配置，显式抛——这一步的成败
 *  要落进 agent 的可复盘轨迹，静默降级会让一次"什么都没搜到"看不出真因。 */
export async function chatViaLlm(
  llmForTask: LlmForTask,
  input: LlmChatInput,
  /** 打哪个调用点。默认 `llm.chat` = 现有调用方逐字节不变；另一条线（AI 介入的一问一答）传
   *  自己的 `intervention.ask`，好让「在设置里给这条问话单独换一行/换个模型」真的有处可换——
   *  所有人共用 `llm.chat` 的话，那个下拉就成了空动作。 */
  callsiteId = 'llm.chat',
): Promise<ChatResult> {
  let ladder: LadderTrace = { via: null, rungs: [] }
  const result = await llmForTask(callsiteId, input, { onLadder: (l) => { ladder = l } })
  // **「一个成员都没配」和「配了但全都失败」是两件事，措辞必须分开。** 这句话过去一律是
  // 「LLM 未配置」，而活体里最常见的成因其实是**欠费**（deepseek 402 Insufficient Balance /
  // 智谱 429 余额不足 / 网关 401 key 失效）——一句"去设置里填"会把人指去改一份本来就填对了的
  // 配置，真因（三个成员全欠费）一个字都不出现。2026-09-02 的活体验收就为这句话白跑了一轮。
  if (!result) {
    if (ladder.rungs.length > 0) {
      const why = ladder.rungs.map((r) => `${r.member}: ${r.outcome}${r.reason ? `（${r.reason}）` : ''}`).join('；')
      throw new LadderError(`LLM 梯子上没有一个成员答成：${why}`, ladder)
    }
    throw new LadderError('LLM 未配置，请在设置中填写', ladder)
  }
  return result
}

/** 「拿一段正文，拿不到就算了」：未配置 / 全 decline / 调用抛错一律 null，**绝不抛**。
 *  抽名路(自我介绍认名)靠这个 null 把簇留作匿名——低置信不硬认，一个错名 enroll 出去会永久
 *  污染声纹库，所以任何不确定都必须退化成"不命名"，而不是把异常捅进转写流程。 */
export async function llmContentQuiet(llmForTask: LlmForTask, callsiteId: string, input: LlmChatInput): Promise<string | null> {
  try {
    return (await llmForTask(callsiteId, input))?.content ?? null
  } catch {
    return null
  }
}

/** 摘要路的翻译层：梯子没结果 = 「未配置」（文案是设置页在引导用户去填的那一句），空内容 =
 *  生成失败。两条都必须抛——静默返回空串会把一份空摘要落进转换账本，看起来像成功。 */
export async function summarizeViaLlm(
  llmForTask: LlmForTask,
  input: LlmChatInput,
): Promise<{ summary: string; ladder: LadderTrace }> {
  let ladder: LadderTrace = { via: null, rungs: [] }
  const result = await llmForTask('llm.summarize', input, { onLadder: (l) => { ladder = l }, validate: (r) => !!r.content?.trim() })
  // 抛 LadderError 而不是 Error：失败时「谁试过、各自怎么了」才是要看的那半，普通 Error 会把它丢掉。
  // result 为 null 有两种成因：①梯子上没人配置/全员 miss/error（从未答出来过）→「未配置」；
  // ②有成员答出来过、但被 validate 判定为空摘要而否决，换过一圈仍无人过关 →「生成失败」。
  // 判据必须是「存在 rejected 记录」，不能是「rungs 非空」——executor 对每个被尝试过的成员
  // 都会 push 一条 rung（win/miss/error 皆算），全员弃权/失败时 rungs 也非空，误判会让凭证
  // 失效这类真正的「未配置」场景被扣上一句断言性的「模型返回空内容」。
  if (!result) {
    if (ladder.rungs.some((r) => r.outcome === 'rejected')) throw new LadderError('总结生成失败：模型返回空内容', ladder)
    throw new LadderError('LLM 未配置，请在设置中填写', ladder)
  }
  const summary = result.content?.trim()
  if (!summary) throw new LadderError('总结生成失败：模型返回空内容', ladder)
  return { summary, ladder }
}

/** 流式聊天路专用：从调用点绑定的那条行上挑第一个「端点+钥匙+模型」齐全的成员，返回它的端点。
 *  为什么不走 invoke：SSE 跨不过 executor 的数组契约（见 agent/service.ts 头注），AI SDK 要的是
 *  baseUrl/apiKey/model 三件套本身。但**行的选取、模型覆盖、exclude、成员参数解析这四条规则一律
 *  跟梯子走**——任何一条在这里另写一遍，都会造出「梯子路和流式聊天路行为不一致」的暗坑：
 *  - 行 id：`bindings.fixed(callsiteId)`（同 llmForTask），不写死 'llm'；
 *  - exclude：executor.expandMembers 按**寻址键**（`name ?? source`）过滤，这里照抄同一条；
 *  - 成员参数：复用 sources.ts 的 `resolveMemberEndpoint`。
 *
 *  只支持 `llm-openai` 形状的显式成员：auto 段 / `{provider}` 组合成员没有自己的端点参数，
 *  非 llm-openai 源（将来可能进梯子的非 OpenAI 兼容源）拼不出这三件套——**这些形状暂不支持
 *  流式聊天端点解析**，一律跳过（它们在梯子路仍然照常参与）。 */
export function resolveLadderEndpoint(
  callsiteId: string,
  deps: {
    getProvider: (id: string) => ProviderRecord | null
    bindings: CallsiteBindings
    token: (name: string) => string | null
  },
  /** 想用这一行里的**哪个成员**（寻址键 `name ?? source`）。给了但解析不出来（成员被删了、
   *  钥匙没了）→ **回落到第一个可用的**，不是报错：用户存在会话里的那个选择过期了，代价应该是
   *  "换个模型接着答"，而不是这条会话从此打不开。 */
  preferMember?: string,
): ChatEndpoint | null {
  const all = ladderEndpoints(callsiteId, deps)
  return (preferMember ? all.find((e) => e.member === preferMember)?.endpoint : undefined) ?? all[0]?.endpoint ?? null
}

/** 这条调用点上**能用的成员全集**（按行内顺序），每个带自己的端点三件套。
 *
 *  两个消费方共用它，别各写各的：`resolveLadderEndpoint`（这一轮打给谁）和「切换模型」的
 *  下拉（有哪些可选）。分家的后果是下拉里列着一个聊天路根本选不中的成员，用户点了没反应。 */
export function ladderEndpoints(
  callsiteId: string,
  deps: {
    getProvider: (id: string) => ProviderRecord | null
    bindings: CallsiteBindings
    token: (name: string) => string | null
  },
): Array<{ member: string; endpoint: ChatEndpoint; contextWindow: number }> {
  const record = deps.getProvider(deps.bindings.fixed(callsiteId) ?? DEFAULT_LLM_PROVIDER)
  if (!record) return []
  const exclude = new Set(Array.isArray(record.options?.exclude) ? (record.options.exclude as string[]) : [])
  const modelOverride = callsiteModel(deps.bindings.binding(callsiteId))
  const out: Array<{ member: string; endpoint: ChatEndpoint; contextWindow: number }> = []
  for (const member of record.members) {
    if (!('source' in member) || member.source !== 'llm-openai') continue
    const key = member.name ?? member.source
    if (exclude.has(key)) continue
    const params = (member.params ?? {}) as LlmOpenAiParams
    const ep = resolveMemberEndpoint(params, deps, modelOverride)
    // 同名成员只留第一个：寻址键要能唯一指回一个成员，否则会话里存的那个键指向谁全看遍历顺序。
    if (ep && !out.some((e) => e.member === key)) {
      // 窗口按**解析后的模型**算（`ep.model` 已含调用点绑定的 model 覆盖）——按 params.model 算
      // 会在用户换了模型之后继续报旧模型的容量，而且不会有任何一处报错。
      out.push({ member: key, endpoint: ep, contextWindow: memberContextWindow(params.contextWindow, ep.model) })
    }
  }
  return out
}

