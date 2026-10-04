// src/conversions/converters/extract.ts
//
// 「把这条 item 的正文给我」——**唯一**的问法。
//
// 两条老路（parse / stt）收成它的内部分支，网页正文是新增的第三条：调用方不再需要先自己判断
// 「这是图还是视频还是网页」才知道该问哪个端点。判分支归 shared/extract/plan.ts（前端同一份），
// 这里只管：按判定去打对应的分支，然后把三种不同的产物拍成同一个形状。
//
// 设计见 docs/superpowers/specs/2026-07-31-extract-unified-content-design.md。
import { planExtract, type Content, type ExtractBranch, type ExtractCapabilities } from '../../../shared/extract/plan.ts'
import { listMarkdownImages, annotateMarkdownImages } from '../../content/images/markdown-images.ts'
import type { LadderTrace } from '../../providers/ladder-trace.ts'
import type { ConversionContext, ConversionOutcome, Converter } from '../runner.ts'

/** extract 的产物。合同是 `text`——谁都能产出的只有它。 */
export interface ExtractResult {
  text: string
  format: 'markdown' | 'plain'
  branch: ExtractBranch
  /** 分支特有，能产才有。`segments`（时间轴）只有转写分支拿得出，而声纹归名、播放器同步、
   *  「只看某人」都靠它——不能砍，也不能提到顶层假装人人都有（那会让 OCR 结果凭空多出恒空字段）。 */
  detail?: Record<string, unknown>
}

/** 一条分支：能不能跑 + 怎么跑 + 声明哪些阶段。就是 `Converter` 去掉 kind/label 剩下的部分，
 *  所以现有的 stt / parse converter **原样**就能当分支用（结构化类型，零改写）。 */
export interface ExtractBranchRunner {
  stages: string[]
  available: () => boolean
  /** 该分支认的 options（如转写的 diarize/translate）——extract 合并后对外展示。 */
  options?: Record<string, string>
  run(ctx: ConversionContext): Promise<ConversionOutcome>
}

export interface ExtractConverterDeps {
  stt: ExtractBranchRunner
  ocr: ExtractBranchRunner
  /** 网页正文：打 `article-extract` 行（成员即成本阶梯，产物 `text` 是 markdown-lite）。
   *  返回 `null` = 没抓到正文。 */
  article: {
    available: () => boolean
    fetch: (url: string, signal?: AbortSignal) => Promise<{ text?: string; ladder?: LadderTrace } | null>
    /** 正文里的每张配图过一遍 OCR，结果批注回图片原位，返回批注后的 markdown。
     *  **不是可选的**：接线漏了要在 typecheck 就炸，而不是活体上安静地少一半正文
     *  （图文混排的文章关键信息常在图里）。 */
    ocrImages: (markdown: string, signal?: AbortSignal) => Promise<string>
  }
}

/** 各分支此刻配没配——**每次现问**，不缓存：host 档下插件容器可能中途醒来，
 *  bootstrap 时算一次并烤进闭包会把可用性永久冻在启动那一刻（identify 踩过同款）。 */
export function extractCapabilities(deps: ExtractConverterDeps): ExtractCapabilities {
  return { stt: deps.stt.available(), ocr: deps.ocr.available(), article: deps.article.available() }
}

export function makeExtractConverter(deps: ExtractConverterDeps): Converter {
  return {
    kind: 'extract',
    label: '转成文字',
    // 阶段名带分支前缀：三条分支的阶段本来就不是一回事，摊平成 `fetch|ocr|media|asr` 会让
    // 「这次到底走了哪条」只能靠阶段名猜。
    stages: [
      ...deps.ocr.stages.map((s) => `ocr:${s}`),
      ...deps.stt.stages.map((s) => `stt:${s}`),
      'article:fetch',
      // 声明在这里，但**只有正文里真有图时**才会被记进 timing——见 run() 里的注释。
      'article:ocr',
    ],
    // kind 级永远可用：`inline` 一档不打任何后端，所以「extract 这个能力在不在」恒为真。
    // 具体这条 item 行不行是 **per-item** 的事，由 run() 返回结构化失败回答——
    // 用一个 kind 级布尔去表达 per-item 的可行性，只会得到一个既不对也没用的读数。
    available: () => true,
    // 各分支认的 options 合并上来：走哪条分支是后端判的，但调用方仍能递 diarize 这类偏好。
    options: { ...deps.ocr.options, ...deps.stt.options },
    branches: () => ({ ...extractCapabilities(deps) }),
    async run(ctx): Promise<ConversionOutcome> {
      const content = ctx.options.content as Content | undefined
      if (!content) {
        return { ok: false, error: { code: 'no_content', message: '这条 item 没有可判定的内容（缺 archetype）' } }
      }
      const plan = planExtract(content, extractCapabilities(deps), ctx.options.url as string | undefined)
      if (!plan.ok) {
        // 判定失败**不是**内部错误：它说得出缺什么、该去配还是该换条内容。原样交出去。
        return { ok: false, error: { code: plan.code, message: plan.message } }
      }

      if (plan.branch === 'inline') {
        // 白拿的一档：正文本来就在 item 上，不打任何后端，也没有梯子可走。
        return { ok: true, result: shape(plan.text, 'plain', 'inline') }
      }

      if (plan.branch === 'article') {
        const got = await ctx.stage('article:fetch', () => deps.article.fetch(plan.url, ctx.signal))
        const text = got?.text?.trim()
        if (!text) return { ok: false, error: { code: 'empty_result', message: '抓到了页面，但没有可用正文' }, ladder: got?.ladder }
        // markdown 不是 plain：投影保留了 `![alt](url)` 图片标记（逐图 OCR 靠它定位回填），
        // firecrawl 降级档原生也产 markdown——两档同一种载体，消费方不用分辨是谁抓的。
        //
        // 逐图 OCR：**先数图，有图才建阶段**。未发生的阶段不出现在 timing 里（不是 ms:0）——
        // 「没跑」和「跑了 0ms」必须分得开，否则一篇没有配图的文章看起来像是 OCR 跑了但一无所获。
        // 抛错就退回未批注的正文：OCR 是增量信息，它塌了不能把正文一起带走。
        const annotated = listMarkdownImages(text).length
          ? await ctx.stage('article:ocr', async () => {
              try {
                return await deps.article.ocrImages(text, ctx.signal)
              } catch (e) {
                // 整层失败（不是单张图的失败——那种早被 ocr-images.ts 的 one() 吞成
                // `[未识别：…]` 留在正文里了；这里是 listMarkdownImages/annotateMarkdownImages
                // 或缓存层这类结构性炸法）同样要给**每张图**留标记，不能静静退回未批注的
                // 正文——那样"这篇没跑 OCR"和"跑了但全塌了"就分不出来了。
                const msg = e instanceof Error ? e.message : String(e)
                const reason = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg
                try {
                  const images = listMarkdownImages(text)
                  return annotateMarkdownImages(text, images.map(() => `[未识别：${reason}]`))
                } catch {
                  // 兜底里**又调了一遍**上面注释点名的那两个函数——如果真是它们炸的，这次还会炸，
                  // 而这一抛会逃出 ctx.stage 让整条转换失败，**把正文一起带走**，正好撞破
                  // 「OCR 塌了不能把正文带走」这条不变量。所以兜底自己也要有兜底：
                  // 退回未批注的正文。标记没了是遗憾，正文没了是事故。
                  return text
                }
              }
            })
          : text
        return { ok: true, result: shape(annotated.trim() || text, 'markdown', 'article'), ladder: got?.ladder }
      }

      // stt / ocr：分支自己跑（含它自己的阶段计时与梯子走法），这里只把产物拍成统一形状。
      const branch = plan.branch
      const out = await deps[branch].run(prefixStages(ctx, branch))
      if (!out.ok) return out
      const mapped = mapBranchResult(branch, out.result)
      if (!mapped) {
        return { ok: false, error: { code: 'empty_result', message: `${branch} 分支没有产出正文` }, ladder: out.ladder }
      }
      return { ok: true, result: mapped, ladder: out.ladder }
    },
  }
}

function shape(text: string, format: ExtractResult['format'], branch: ExtractBranch, detail?: Record<string, unknown>): ExtractResult {
  return { text, format, branch, ...(detail ? { detail } : {}) }
}

/** 把分支的原生产物拍成 extract 的形状。`null` = 那条分支跑完了但没有正文。 */
function mapBranchResult(branch: 'stt' | 'ocr', result: unknown): ExtractResult | null {
  const r = (result ?? {}) as Record<string, unknown>
  if (branch === 'ocr') {
    const md = typeof r.markdown === 'string' ? r.markdown.trim() : ''
    return md ? shape(md, 'markdown', 'ocr') : null
  }
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  if (!text) return null
  // lang / segments / media 只有转写拿得出——进 detail，不进公共合同。
  const detail: Record<string, unknown> = {}
  for (const k of ['lang', 'segments', 'media'] as const) if (r[k] !== undefined) detail[k] = r[k]
  return shape(text, 'plain', 'stt', Object.keys(detail).length ? detail : undefined)
}

/** 分支跑在同一个 ctx 上，但阶段名要带上自己的前缀——否则 timing 里 `fetch` 到底是 OCR 取图
 *  还是网页抓取就分不出来了。 */
function prefixStages(ctx: ConversionContext, branch: string): ConversionContext {
  return { ...ctx, stage: (name, fn) => ctx.stage(`${branch}:${name}`, fn) }
}
