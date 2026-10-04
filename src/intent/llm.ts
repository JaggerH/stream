import { generateObject, generateText, type LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import type { ChatEndpoint } from '../llm/client.ts'
// 不可信文本的注入围栏（phase2 spec §2）搬去了 `src/llm/fence.ts`（零改动）——档 A 的语义折叠
// 把网页正文递给模型时吃的是同一对标记。仍然从这里导出，老的引用方不用改。
import { FENCE_CLOSE, FENCE_NOTE, FENCE_OPEN, stripFence } from '../llm/fence.ts'

export { FENCE_OPEN, FENCE_CLOSE }

export interface IntentLlm {
  parseIntent(goal: string): Promise<{ criteria: string; metadata?: string }>
  judgeItem(criteria: string, text: string): Promise<{ relevant: boolean; summary?: string }>
  mergeDossier(goal: string, current: string, entries: Array<{ title: string; summary: string; link?: string }>): Promise<string>
  pickSources(
    goal: string,
    criteria: string,
    candidates: Array<{ id: string; description: string; categories?: string[]; params_schema?: Record<string, unknown> }>,
  ): Promise<Array<{ sourceId: string; params: Record<string, string | number> }>>
}

/** 意图跟踪的三个 LLM 原语，全部 AI SDK 标准调用（spec「Agent 框架选型」：结构化输出一律
 *  generateObject，不手搓 JSON 解析）。`opts.model` 供测试注入；生产按 resolveEndpoint 现解析
 *  （每次调用重解析，用户改配置即生效，不冻快照）。 */
export function makeIntentLlm(resolveEndpoint: () => ChatEndpoint | null, opts?: { model?: LanguageModel }): IntentLlm {
  const modelOf = (): LanguageModel => {
    if (opts?.model) return opts.model
    const ep = resolveEndpoint()
    if (!ep) throw new Error('LLM 未配置')
    return createOpenAICompatible({ name: 'stream-llm', baseURL: ep.baseUrl, apiKey: ep.apiKey })(ep.model)
  }

  return {
    async parseIntent(goal) {
      const { object } = await generateObject({
        model: modelOf(),
        schema: z.object({
          // string|string[] 双收：DeepSeek 把"判定标准"自然理解成清单,回数组是常态(活体实测),
          // 只收 string 会 schema 不匹配。归一在下面 join。
          criteria: z.union([z.string(), z.array(z.string())]).describe('判定标准，白话：什么内容算与该意图相关、什么明确排除'),
          // nullish 不是 optional：DeepSeek 对"没有"会回 null 而不是省略字段，optional 会判 schema 不匹配。
          metadata: z.union([z.string(), z.array(z.string())]).nullish().describe('从意图能推断的潜在背景（如"可能有小孩/从业者"），没有就给 null'),
        }),
        // 「以 JSON 输出」不是废话：DeepSeek 等上游对 response_format:json_object 要求 prompt
        // 里出现 "json" 字样，缺了直接 4xx；且形状必须在 prompt 里钉死成带示例的扁平两键——
        // 只给 schema 它会自由发挥嵌套结构（活体实测两轮都翻车）。
        prompt:
          `用户想长期跟踪一个目的，请把它解析成持续筛选内容用的判定标准。\n用户原话：${goal}\n\n` +
          `以 JSON 输出，严格只有两个键，值都是纯文本（不许嵌套对象或数组）：\n` +
          `{"criteria": "一段白话：什么内容算相关、什么明确排除", "metadata": "从意图能推断的潜在背景，推断不出就给 null"}`,
      })
      const join = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v.join('；') : v)
      const metadata = join(object.metadata)
      return { criteria: join(object.criteria)!, ...(metadata ? { metadata } : {}) }
    },

    async judgeItem(criteria, text) {
      const { object } = await generateObject({
        model: modelOf(),
        schema: z.object({
          relevant: z.boolean().describe('该内容是否符合判定标准'),
          summary: z.string().nullish().describe('相关时给一句话中文摘要；不相关给 null'), // nullish 理由同 parseIntent
        }),
        // 同 parseIntent：prompt 必须含 "json" 且形状钉死，见上。
        prompt:
          `判定标准：${criteria}\n\n${FENCE_OPEN}\n${stripFence(text.slice(0, 6000))}\n${FENCE_CLOSE}\n${FENCE_NOTE}\n\n这条内容和判定标准相关吗？\n` +
          `以 JSON 输出，严格只有两个键：{"relevant": true或false, "summary": "相关时一句话中文摘要，不相关给 null"}`,
      })
      return { relevant: object.relevant, ...(object.summary ? { summary: object.summary } : {}) }
    },

    async mergeDossier(goal, current, entries) {
      const list = entries.map((e) => `- ${e.title}：${e.summary}${e.link ? `（${e.link}）` : ''}`).join('\n')
      const { text } = await generateText({
        model: modelOf(),
        prompt:
          `你在维护一份长期跟踪档案（markdown），主题：${goal}。\n` +
          `保持「## 现状 / ## 近期变化 / ## 值得看的原文」三段结构；把新条目合并进认知（累积改写，不是追加日志），过时的表述更新掉。\n\n` +
          // current 是上一轮 mergeDossier 的输出——不可信文本同理围栏包住（防上一轮档案里被
          // 洗白进去的注入文本裸拼进这一轮 prompt）；两段各自独立围栏，别共用一对首尾。
          `现有档案（可能为空）：\n${FENCE_OPEN}\n${stripFence(current) || '（尚无）'}\n${FENCE_CLOSE}\n${FENCE_NOTE}\n\n` +
          `新增相关条目：\n${FENCE_OPEN}\n${stripFence(list)}\n${FENCE_CLOSE}\n${FENCE_NOTE}\n\n输出完整的新档案 markdown，不要解释。`,
      })
      return text
    },

    async pickSources(goal, criteria, candidates) {
      if (candidates.length === 0) return []
      const menu = candidates
        .map((c) => `- id: ${c.id}\n  描述: ${c.description}${c.categories?.length ? `\n  分类: ${c.categories.join(',')}` : ''}${c.params_schema && Object.keys(c.params_schema).length ? `\n  参数schema: ${JSON.stringify(c.params_schema)}` : ''}`)
        .join('\n')
      const { object } = await generateObject({
        model: modelOf(),
        schema: z.object({
          picks: z.array(z.object({
            sourceId: z.string().describe('候选清单里的 id，原样照抄'),
            // nullish + 值双收数字：路由参数常是数字型 id
            params: z.record(z.string(), z.union([z.string(), z.number()])).nullish().describe('该源的参数；无参数给 null'),
          })),
        }),
        // 同 parseIntent：prompt 必含 "json"，形状钉死（Global Constraints）
        prompt:
          `用户长期意图：${goal}\n判定标准：${criteria}\n\n本机可订阅的候选源清单：\n${menu}\n\n` +
          `从清单里挑最能持续产出该意图相关内容的源，宁缺毋滥，最多 5 条。候选参数schema里 required 的参数你必须给出确定值，给不出就不要选那条。\n` +
          `以 JSON 输出，严格形状：{"picks": [{"sourceId": "候选清单里的 id", "params": {"参数名": "值"} 或 null}]}`,
      })
      const ids = new Set(candidates.map((c) => c.id))
      return object.picks
        .filter((p) => ids.has(p.sourceId))
        .slice(0, 5)
        .map((p) => ({ sourceId: p.sourceId, params: p.params ?? {} }))
    },
  }
}
