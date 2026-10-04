/**
 * 从一个冻结的 `ToolCallBlock` 里把「这次工具调用的输入和产出」读出来。
 *
 * **两条路都必须有**（任务硬要求，也是现实）：
 *   1. 结构化优先 —— `dsh-mcp-client` 在 MCP 结果带 `structuredContent` 时会把它原样带过来
 *      （见其 `createExecutor`）；
 *   2. 文本回落 —— Stream 的 MCP 面今天把每个结果包成**一个 text block**、内容是
 *      `JSON.stringify(data, null, 2)`（`src/mcp/server.ts` 的 `json()` 信封），所以绝大多数
 *      情况下真正的数据要从文本里 `JSON.parse` 回来。
 *
 * **绝不抛。** 渲染器抛错会被 DSH 的 entry boundary 记成崩溃并把这一格退出去
 *（`SlotCore.reportEntryError`），坏数据不该有这个后果——一律降级成纯文本。
 */
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 一次调用被读出来的全部东西。 */
export interface ToolCallReading {
  /** 还在跑（只见到 tool/call，没见到 tool/result）。 */
  running: boolean
  /** 工具报错（DSH 的 isError 通道）。 */
  isError: boolean
  /** 结果的纯文本形态：结构化缺席时它就是全部；结构化在场时它仍是回落文案。 */
  text: string
  /** 结果的结构化形态：structuredContent 优先，其次是文本里 parse 出来的 JSON。都没有 = null。 */
  data: unknown
  /** 调用参数（`argsRaw` parse 出来的对象）；parse 不出来 = null。 */
  args: Record<string, unknown> | null
}

/** 安全 JSON.parse：坏数据回 null，不抛。 */
function parseJson(raw: string): unknown {
  if (raw === '') return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * 结果文本 → 结构化：整段是 JSON 就用整段；不是，就退一步试**最后一个非空行**。
 * 为什么要这条回落：工具偶尔会在 JSON 信封前面多写一行给人看的话（markdown 图片、提示语），
 * 整段 parse 当场失败、`data` 变 null，于是每张定制卡都读成「失败」——数据其实好好地在最后一行。
 * 这只是防御，正解仍是工具那一格只放 JSON。
 */
function parseResultText(raw: string): unknown {
  const whole = parseJson(raw)
  if (whole !== null) return whole
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim()
    if (line === '') continue
    return parseJson(line)
  }
  return null
}

/** 只取对象（数组和标量不算「参数表」）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 把结果的 content blocks 压成一段文字；非文本块记一个占位，不静默丢。 */
function flattenText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as unknown[]) {
    const rec = asRecord(block)
    if (rec === null) continue
    if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text)
    else if (typeof rec.type === 'string') parts.push(`[${rec.type}]`)
  }
  return parts.join('\n')
}

/**
 * 读一个调用块。
 * @param block - DSH 递过来的冻结 running/settled 节点。
 * @returns 参数 + 结构化产出 + 文本产出，坏数据一律降级不抛。
 */
export function readToolCall(block: ToolCallBlock): ToolCallReading {
  const rec = asRecord(block) ?? {}
  const settled = rec.kind === 'tool-result'

  // 参数：running 节点自己带 argsRaw；settled 节点的调用头在 `call` 里（窗口截断时为 null）。
  const argsRaw = settled ? asRecord(rec.call)?.argsRaw : rec.argsRaw
  const args = typeof argsRaw === 'string' ? asRecord(parseJson(argsRaw)) : null

  if (!settled) return { running: true, isError: false, text: '', data: null, args }

  const text = flattenText(rec.content)
  // structuredContent 的落点在 DSH 侧不是公共契约的一部分，两个可能的座位都看一眼。
  const structured =
    rec.structuredContent !== undefined ? rec.structuredContent : asRecord(rec.meta)?.structuredContent
  const data = structured !== undefined && structured !== null ? structured : parseResultText(text)

  return { running: false, isError: rec.isError === true, text, data, args }
}

/** 取一个字段并要求它是字符串（缺失/类型不对 = undefined）。 */
export function str(value: unknown, key: string): string | undefined {
  const rec = asRecord(value)
  const v = rec?.[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** 取一个字段并要求它是数组（缺失/类型不对 = 空数组）。 */
export function arr(value: unknown, key: string): unknown[] {
  const rec = asRecord(value)
  const v = rec?.[key]
  return Array.isArray(v) ? (v as unknown[]) : []
}

/** 把一个可能是数组、也可能是 `{items:[...]}` 的产出统一成数组。 */
export function asList(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value as unknown[]
  return arr(value, key)
}

export { asRecord }
