/**
 * 一条消息的正文：一段纯文本，或 OpenAI 的**多模态分片**数组（文本 + 图片）。
 *
 * 图片走 `image_url`，`url` 收 `data:` URI 即可（不必先把图片传到某个公网地址）——OCR 这条路
 * 就是这么把一张图递给视觉模型的：**同一个 `/chat/completions` 端点、同一把钥匙**，只是正文里
 * 多了一个分片。所以"图片转文字"和"文本总结"在传输层是同一件事，不需要第二套协议。
 */
export type ChatContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

/** 一条正文里的**文本部分**。分片形式只取 text 分片拼起来（图片没有文字可读）——
 *  给那些只关心"这条消息说了什么"的消费方用，省得每处自己判类型。 */
export function textOf(content: ChatContent): string {
  return typeof content === 'string'
    ? content
    : content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n')
}

/** One OpenAI-style chat message. `tool_calls` (assistant) / `tool_call_id` (tool) carry the
 *  agentic round-trip; summarization only ever uses system/user. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ChatContent
  tool_calls?: unknown[]
  tool_call_id?: string
}

/** An OpenAI-compatible chat endpoint. `baseUrl` is the API root (e.g. `https://api.openai.com/v1`
 *  or a relay) — `/chat/completions` is appended. */
export interface ChatEndpoint {
  baseUrl: string
  apiKey: string
  model: string
}

export interface ChatOptions {
  tools?: unknown[]
  temperature?: number
  signal?: AbortSignal
}

/** A non-streaming chat completion. `content` is null when the model returned only tool calls. */
export interface ChatResult {
  content: string | null
  toolCalls?: unknown[]
  raw: unknown
}

/** 一次调用真花了多少 token。**读的是服务端返回的 `usage`，不是本地估的**——按字数估在中文和
 *  思考型模型上都能差出几倍（思考 token 也计费，却一个字都不出现在 content 里）。 */
export interface LlmUsage {
  promptTokens: number
  completionTokens: number
}

/**
 * 从 OpenAI 兼容返回里抠出 `usage`。字段缺席（有的中转不回传）→ `undefined`，
 * **绝不补一个估出来的数**：一个看起来精确、其实是猜的数字，比没有数字更坏。
 */
export function usageOf(raw: unknown): LlmUsage | undefined {
  const u = (raw as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage
  if (!u || typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return undefined
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens }
}

/** Default summary instruction — compress out filler, keep conclusions + concrete numbers.
 *  Language-neutral by design: output language is injected separately from the request. */
export const DEFAULT_SUMMARY_PROMPT =
  '你是视频内容总结助手。从转写文本中提炼核心要点，去掉口水话、寒暄和重复，保留结论、关键数据与数字。用简洁的 markdown 输出（要点列表 + 必要的小标题）。'

const LANG_LABEL: Record<string, string> = { zh: '中文', en: 'English' }

/** POST a chat completion to an OpenAI-compatible endpoint. Non-streaming. Throws on HTTP error
 *  (status + truncated body); does NOT throw on empty content — a tool-only turn is legitimate,
 *  so callers that need text (summarize) check `content` themselves. */
export async function chatCompletion(
  messages: ChatMessage[],
  ep: ChatEndpoint,
  opts: ChatOptions = {}
): Promise<ChatResult> {
  const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
    body: JSON.stringify({
      model: ep.model,
      messages,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
    }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`[llm] HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const j = (await res.json()) as { choices?: { message?: { content?: string; tool_calls?: unknown[] } }[] }
  const msg = j.choices?.[0]?.message
  return { content: msg?.content ?? null, toolCalls: msg?.tool_calls, raw: j }
}

/** Assemble the summary system/user messages: the editable prompt + an `输出语言: <lang>` line
 *  in the system message, the transcript as the user message. Pure。
 *  摘要的**发送**不在这里：它走梯子（llm/task.ts summarizeViaLlm → llm Provider 行），
 *  这里只负责把 prompt 拼成 messages。 */
export function buildSummaryMessages(text: string, prompt: string | undefined, lang?: string): ChatMessage[] {
  const label = LANG_LABEL[lang ?? 'zh'] ?? '中文'
  const system = `${prompt?.trim() || DEFAULT_SUMMARY_PROMPT}\n输出语言: ${label}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ]
}
