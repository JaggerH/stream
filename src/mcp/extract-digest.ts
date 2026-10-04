// src/mcp/extract-digest.ts
//
// extract 窄回执(spec 2026-08-24-extract-narrow-receipt):status done 且正文超门槛时,
// 在 MCP 边界把 result.text 压成带出处的要点、剥掉 detail.segments,全文留在 conversions
// 库里由 get_conversions({item}) 取。running/error/短文一律原样。**没有 full 开关**——
// 那个决策权开给模型必被滥用(活体四轮,spec 2026-08-24-digest-authority)。
// 失败兜底是**响的**:截断全文 + digest_failed,绝不让降级长得像正常回执。
import type { ChatMessage } from '../llm/client.ts'
import { llmContentQuiet, type LlmForTask } from '../llm/task.ts'

export const EXTRACT_FULL_TEXT_CHARS = 4000
export const EXTRACT_DIGEST_TTL_MS = 30 * 60_000
export const EXTRACT_DIGEST_CAP = 200

export interface ExtractDigestOpts {
  focus?: string
  /** rerun 强制重跑 conversion 后产物会变(如 diarize 加说话人标签)——跳过缓存读,
   *  避免旧 digest 挡在新产物前面;命中与否都仍写回缓存,供后续非-bypass 调用复用。 */
  bypassCache?: boolean
}

export interface ExtractDigester {
  /** record 是 conversions.start(...).record 的形状({status, result?, ...})。
   *  非 done / 无 result.text / 未超门槛 → 原样返回(同一引用)。
   *  否则返回一个**浅拷贝**的 record,result 被替换为 digest 形状。 */
  apply(itemId: string, record: unknown, opts?: ExtractDigestOpts): Promise<unknown>
}

export function buildDigestMessages(text: string, focus?: string): ChatMessage[] {
  const system =
    '把下面的长文压缩成要点清单(markdown)。硬性要求:\n' +
    '1. 每条要点末尾附一段原文短引(「…」,≤40字),作为出处。\n' +
    '2. 型号、品牌名、数字、价格**原样保留**,不许改写或省略。\n' +
    '3. 只写原文里有的内容,不许推断补充。\n' +
    (focus ? `4. 视角:调用方在找「${focus}」,优先围绕它取材;无关段落一笔带过。\n` : '') +
    '输出语言: 中文'
  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ]
}

type RecordShape = { status?: string; result?: { text?: string; detail?: unknown } & Record<string, unknown> }

export function makeExtractDigester(llmForTask: LlmForTask, now: () => number = Date.now): ExtractDigester {
  // 插入序即逐出序:命中就先 delete 再 set,把"最近又见到"的挪到队尾(照抄 search-snapshot.ts)。
  const cache = new Map<string, { text: string; at: number }>()
  return {
    async apply(itemId, record, opts) {
      const rec = record as RecordShape
      const text = rec?.status === 'done' ? rec.result?.text : undefined
      const key = `${itemId} ${opts?.focus ?? ''}`
      // bypassCache 无条件废旧稿,且必须在下面的早返回**之前**——「这条产物已作废」和「这次
      // 走不走压缩」是两件事:rerun 轮询期间的
      // running 回执都会走早返回,作废要是排在它后面,旧稿就活过这次 rerun,30 分钟内下一次
      // 普通调用会静默吃到 rerun 之前的陈旧摘要。也不止是跳过读:若不删而 LLM 这次恰好失败
      // (下面 failed 分支不写缓存),旧稿同样原封不动留在 map 里。
      if (opts?.bypassCache) cache.delete(key)
      if (typeof text !== 'string' || text.length <= EXTRACT_FULL_TEXT_CHARS) return record
      const hit = opts?.bypassCache ? undefined : cache.get(key)
      const fresh = hit && now() - hit.at <= EXTRACT_DIGEST_TTL_MS
      if (hit && !fresh) cache.delete(key)

      let digestText: string
      let failed: boolean
      if (fresh && hit) {
        digestText = hit.text
        failed = false
      } else {
        const answer = await llmContentQuiet(llmForTask, 'llm.extract_digest', {
          messages: buildDigestMessages(text, opts?.focus),
          temperature: 0.2,
        })
        if (answer == null || !answer.trim()) {
          // 兜底路不写缓存——下次调用该重试 LLM,而不是把失败结果缓存住。
          failed = true
          digestText = text.slice(0, EXTRACT_FULL_TEXT_CHARS)
        } else {
          failed = false
          digestText = answer
          cache.delete(key)
          cache.set(key, { text: answer, at: now() })
          while (cache.size > EXTRACT_DIGEST_CAP) {
            const oldest = cache.keys().next().value
            if (oldest === undefined) break
            cache.delete(oldest)
          }
        }
      }

      const detailSrc = rec.result?.detail
      let detailRest: Record<string, unknown> | undefined
      if (detailSrc !== undefined) {
        const { segments: _segments, ...rest } = (detailSrc && typeof detailSrc === 'object' ? detailSrc : {}) as Record<string, unknown>
        detailRest = rest
      }

      const next_step =
        (failed ? 'DIGEST FAILED (LLM unavailable) — this is the raw text truncated to 4000 chars. ' : '') +
        `Full text (${text.length} chars) is stored — call get_conversions({item: "${itemId}"}) to read it in full. ` +
        'The user can read the full text on the card; do not re-call extract for it.'

      return {
        ...rec,
        result: {
          ...rec.result,
          text: digestText,
          format: 'markdown',
          ...(detailRest !== undefined ? { detail: detailRest } : {}),
          digested: true,
          ...(failed ? { digest_failed: true } : {}),
          full_text_chars: text.length,
          next_step,
        },
      }
    },
  }
}
