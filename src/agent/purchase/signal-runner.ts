/**
 * 抽取关节的**跑法**（纯 schema 与校验在 `signal.ts`，这里只管怎么问模型）。
 *
 * 两个实测决定的形状（探针 2026-09-02，spec §4）：
 *
 * - **用工具调用而不是 `response_format: json_schema`**——`deepseek-v4-flash` 对后者直接 400
 *   （`This response_format type is unavailable now`）。工具参数的 enum 是这条路上唯一能用的
 *   取值域约束。
 * - **不强制 `tool_choice`**。强制指定工具在该模型的 thinking 档 400
 *   （`Thinking mode does not support this tool_choice`），而 auto 档实测能正常调。所以走 auto，
 *   并留一条「模型改回正文了」的兜底解析。兜底不是宽容，是为了让**失败可辨认**：
 *   两条都拿不到就抛，由 job 记成这一篇的 gap，而不是悄悄返回一个空结果——空结果和
 *   「这篇文章确实没夸任何一台」长得一模一样。
 */
import { extractJson } from '../../llm/extract-json.ts'
import { FENCE_OPEN, FENCE_CLOSE, FENCE_NOTE, stripFence } from '../../llm/fence.ts'
import { buildSignalTool, criteriaLabel, validateSignal, type SignalResult } from './signal.ts'
import type { DecisionConstraints, ReviewItem } from './job.ts'

export interface SignalChat {
  (input: { messages: Array<{ role: string; content: string }>; tools?: unknown[] }): Promise<{
    content: string | null
    toolCalls?: unknown[]
    /** 服务端原样回的 body（OpenAI 形状）。只用来在读不成时描述「回的是什么」，不参与解析。 */
    raw?: unknown
  }>
}

/**
 * 一次空答的**签名**：finish_reason / 正文字数 / 有没有思考摘要 / tool_calls 条数 / usage 的字段形状。
 * 为什么要记这些而不是一句「没读成」：活体（2026-09-03）6 篇横评全空，账本里 6 次都是同一成员
 * 「答成 + 计费」，回执里只有一句「模型既没调工具也没给出可解析的 JSON」——什么都判不了，
 * 只能另开一轮去复现。复现出来的签名是：`finish_reason:"stop"`、正文 ""、带 `reasoning_content`、
 * 没有 tool_calls、usage 是 `input_tokens/output_tokens/reasoning_tokens` 形状（同一成员答成的
 * 那些则是 `completion_tokens_details` 形状）——即同一个中转站后面有两个上游池，其中一个把
 * 函数调用整个吞掉，按请求随机命中。这些字段每次都在 body 里，写进 gap 就不用再复现一次。
 */
export function emptyReplySignature(res: { content: string | null; toolCalls?: unknown[]; raw?: unknown }): string {
  const choice = (res.raw as { choices?: Array<{ finish_reason?: unknown; message?: Record<string, unknown> }> } | undefined)?.choices?.[0]
  const usage = (res.raw as { usage?: Record<string, unknown> } | undefined)?.usage
  const msg = choice?.message ?? {}
  const parts = [
    `finish=${String(choice?.finish_reason ?? '?')}`,
    `正文 ${(res.content ?? '').length} 字`,
    `思考摘要${'reasoning_content' in msg || 'reasoning' in msg ? '有' : '无'}`,
    `tool_calls ${Array.isArray(res.toolCalls) ? res.toolCalls.length : 0} 条`,
    usage ? `usage 字段 ${Object.keys(usage).filter((k) => k !== 'total_tokens').join('/')}` : 'usage 无',
  ]
  return parts.join('，')
}

/** 从 OpenAI 形状的 tool_calls 里抠出参数对象。 */
function argsOf(toolCalls: unknown[] | undefined): unknown {
  const first = toolCalls?.[0] as { function?: { arguments?: unknown } } | undefined
  const raw = first?.function?.arguments
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function makeSignalJoint(chat: SignalChat, fetchText: (item: ReviewItem) => Promise<string>) {
  return async (review: ReviewItem, universe: string[], c: DecisionConstraints): Promise<SignalResult> => {
    const text = await fetchText(review)
    if (!text.trim()) throw new Error('这篇取不到正文')

    const tool = buildSignalTool(universe, c.softCriteria)
    const criteria = criteriaLabel(c.softCriteria)
    const system =
      `你在读一篇选购文章，任务是记录：哪些型号因为「${criteria}」被推荐或称赞。` +
      '只记文章真的说过的，不要凭自己的印象补充。' +
      `文章提到的型号不在候选列表里时，必须用列表里的 "__not_in_set__" 那一项，并把原文写法填进 raw——` +
      '**不要挑一个相近的型号顶替**。' +
      '每一条：attribute 是一个短语（不超过 12 个字），quote 必须从文章里照抄一句原话（不超过 80 个字）——缺 quote 的条目会被整条丢掉，不要把总结写进 attribute 而不给 quote。'
    const user = { role: 'user', content: `${FENCE_OPEN}\n${stripFence(text).slice(0, 40000)}\n${FENCE_CLOSE}\n${FENCE_NOTE}` }
    // 第一问走函数调用（enum 把全集塞进取值域）；第二问**不带 tools**，把候选列表和 JSON 形状写进
    // 提示词、要它在正文里直接回 JSON。两问的解析和事后集合校验是同一条路——enum 从来只是
    // 「让它少走」，保证在 `validateSignal`。
    const askWithTool = () => chat({ messages: [{ role: 'system', content: system }, user], tools: [tool] })
    const askAsText = () =>
      chat({
        messages: [
          {
            role: 'system',
            content:
              system +
              `\n候选列表（model 只能从这里选）：${universe.join('、')}、__not_in_set__。` +
              '\n只输出一个 JSON 对象，不要别的文字：{"mentions":[{"model":"","raw":"","attribute":"","quote":""}]}',
          },
          user,
        ],
      })

    const parse = (res: Awaited<ReturnType<SignalChat>>): SignalResult | null => {
      const fromTool = argsOf(res.toolCalls)
      if (fromTool && typeof fromTool === 'object') return validateSignal(fromTool, universe)
      const fromText = extractJson<unknown>(res.content)
      if (fromText && typeof fromText === 'object') return validateSignal(fromText, universe)
      return null
    }

    // 空答（既没调工具、正文也不是 JSON）**同一成员换问法再问一次**，只补一次。梯子的 validate 是
    // 「换下一个成员」，对这种按请求随机吞掉 tool_calls 的中转站不对症——下一个成员多半是欠费的
    // 那几个。第二问不带 tools：实测（2026-09-03，~3.6k token 正文）带工具 5 次中 2 次拿到结果，
    // 「正文里直接回 JSON」5 次全中——吞的是函数调用，不是正文。两次都空才算没读成。
    const first = await askWithTool()
    const r1 = parse(first)
    if (r1) return r1
    const second = await askAsText()
    const r2 = parse(second)
    if (r2) return r2

    // 两条都空 = 这一篇没读成。**不返回空结果**——空结果会被读成「文章没夸任何一台」。
    // 把两次空答的签名带出去：回执里的 gap 就是现场，不用再复现。
    throw new Error(`模型既没调工具也没给出可解析的 JSON（重试一次仍空；第一次 ${emptyReplySignature(first)}；第二次 ${emptyReplySignature(second)}）`)
  }
}
