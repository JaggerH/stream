// src/conversions/converters/summary.ts
//
// 摘要作为一种 conversion。重构前它是 `POST /api/transcripts/:itemId/summary`——一个动词端点，
// 产物挂在转写记录的一列上。它的输入其实是**另一条 conversion 的产物**（转写文本），不是原始
// 媒体，所以 inputId 指向上游那条。这条链一旦成立，翻译 / 字幕对齐 / embedding 都是同形状的新 kind。
import type { LadderTrace } from '../../providers/ladder-trace.ts'
import type { ConversionStore } from '../store.ts'
import type { Converter } from '../runner.ts'

export interface SummaryConverterDeps {
  store: ConversionStore
  /** 打 LLM 出摘要（markdown），并带回**是梯子上的谁答的**（`ladder`）。 */
  summarize: (text: string, lang?: string) => Promise<{ summary: string; ladder: LadderTrace }>
  available: () => boolean
}

export function makeSummaryConverter(deps: SummaryConverterDeps): Converter {
  return {
    kind: 'summary',
    label: '摘要',
    stages: ['summarize'],
    available: deps.available,
    options: { lang: 'string' },
    async run(ctx) {
      // 上游是一条 **extract**（正文），不再限定转写：一篇文章、一张图、一集播客，摘要这边
      // 看到的都是同一个 `text` 字段——这正是收敛要兑现的那件事。
      const upstream = ctx.inputId ? deps.store.get(ctx.inputId) : deps.store.latestFor(ctx.itemId, 'extract')
      const text = (upstream?.result as { text?: string } | undefined)?.text
      if (!upstream || upstream.status !== 'done' || !text) {
        return { ok: false, error: { code: 'no_content', message: '没有可摘要的正文（先取一次正文）' } }
      }
      const lang = ctx.options.lang as string | undefined
      const out = await ctx.stage('summarize', () => deps.summarize(text, lang))
      return { ok: true, result: { summary: out.summary, lang }, ladder: out.ladder }
    },
  }
}
