import type { BuiltinFn } from '../adapters/builtin/adapter.ts'
import { chatCompletion, type ChatEndpoint, type ChatMessage, type ChatResult } from './client.ts'

/** The invoke input for the llm Provider — a packed chatCompletion call. `model` comes from the
 *  caller (summarize/agent); the task→model binding is resolved a layer up, not here. */
export interface LlmChatInput {
  messages: ChatMessage[]
  model?: string
  tools?: unknown[]
  temperature?: number
}

/** llm-openai builtin source params —— **只有一种形状**：成员自己带齐端点与模型，key 经
 *  `tokenName`（逻辑名 `llm:<实例名>`）从 TokenProvider 取。和 STT 的 BYOK 成员
 *  （transcribe-openai-compat / -openai）同构。
 *
 *  这里曾经并存过第二种：只写一个 `connectionId`，真正的端点/key 去 `LlmSettings.connections`
 *  那张表里查。同一件事两种形状 = 两个真相源，"设置页配好了却报 LLM 未配置"就是那么来的。
 *  整条腿已退役——连接就是 `llm` 行的成员，没有别的入口。 */
export interface LlmOpenAiParams {
  baseUrl?: string
  model?: string
  tokenName?: string
  /** 这一档模型能吃多长的 prompt。留空 = 走 `llm/capacity.ts` 的便利表、再回落到保守下限。
   *  表单给的是字符串，所以类型放宽到 `string | number`，解析归 `declaredContextWindow`。 */
  contextWindow?: string | number
}

/** 一个 `llm-openai` 成员的 params → 具体端点，三样（端点 / key / 模型）齐不了返回 null
 *  （= 成员 decline）。两个消费方共用这一份规则：梯子里的 makeLlmOpenAiFn，以及跨不过 executor
 *  数组契约的流式聊天路（llm/task.ts resolveLadderEndpoint）——别在第二处另写一遍解析。
 *  `modelOverride` 是比成员默认更高一档的模型（源里是 input.model，流式路是调用点绑定的覆盖）。 */
export function resolveMemberEndpoint(
  params: LlmOpenAiParams,
  deps: { token: (name: string) => string | null },
  modelOverride?: string,
): ChatEndpoint | null {
  const model = modelOverride ?? params.model
  if (!params.baseUrl) return null
  const apiKey = deps.token(String(params.tokenName ?? ''))
  if (!apiKey || !model) return null
  return { baseUrl: params.baseUrl, apiKey, model }
}

/** llm-openai builtin source：成员自带端点（`params.baseUrl`）与模型，key 从
 *  `deps.token(params.tokenName)` 取（TokenProvider 的 stored 层，逻辑名如 `llm:<实例名>`）。
 *  端点/钥匙/模型缺一就 decline（[]），executor 落到下一个成员。模型取值：input.model > params.model。 */
export function makeLlmOpenAiFn(deps: { token: (name: string) => string | null }): BuiltinFn {
  return async (input, rawParams) => {
    const { messages, model: inputModel, tools, temperature } = (input ?? {}) as LlmChatInput
    if (!Array.isArray(messages) || messages.length === 0) return [] // decline — nothing to send
    const ep = resolveMemberEndpoint(rawParams as LlmOpenAiParams, { token: deps.token }, inputModel)
    if (!ep) return [] // decline — 端点/钥匙/模型缺一
    const res: ChatResult = await chatCompletion(messages, ep, { tools, temperature })
    return [res]
  }
}
