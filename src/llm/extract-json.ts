/**
 * 从模型回的一段文本里把 JSON 抠出来。**永不抛**——模型的输出不是协议，解析失败是常态，
 * 每个调用方按自己的语义给一个安全默认（切题打分给 0、分类全判 noise、语义折叠不并）。
 *
 * 住在 `src/llm/` 而不是某个消费方自己的目录里：它是「和模型说话」这件事的通用零件，
 * 搜索 agent 的三个关节和档 A 的语义判据都吃它。同一段容错逻辑写第二遍，就会有一处
 * 少认一种围栏（```json vs 裸 JSON vs 前后带话），而两边都不会有测试报警。
 */

/** 容错 JSON 抽取：先剥 ```json 围栏，否则取第一个成对的 `[..]` / `{..}`。失败一律 `null`。 */
export function extractJson<T>(text: string | null): T | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start < 0) return null
  const open = body[start]
  const close = open === '[' ? ']' : '}'
  const end = body.lastIndexOf(close)
  if (end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as T
  } catch {
    return null
  }
}
