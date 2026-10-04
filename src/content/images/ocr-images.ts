import { listMarkdownImages, annotateMarkdownImages } from './markdown-images.ts'

/** 把正文里的每张配图过一遍 OCR，结果批注回图片原位。
 *
 *  为什么建在**抽完的正文**上而不是页面级的图片清单上：Defuddle 已经把头像/图标/间隔线当
 *  clutter 清掉了。实测同一篇博客——页面级清单 3 张（其中 2 张是作者头像的两个尺寸），
 *  抽完的正文里只剩 1 张真配图。所以尺寸过滤和去重这两道闸天然不需要自己写；
 *  拿页面级清单当输入等于把这活重做一遍，还做得更差。 */

export interface OcrImagesDeps {
  /** URL → 字节。由调用方接到 safe-fetch（SSRF 白名单）上；取不到返回 null。 */
  fetchBytes(url: string): Promise<{ bytes: Uint8Array; mime: string } | null>
  /** 字节 → 文字。由调用方接到 `parse` Provider 行上；没识别出东西返回 null。 */
  ocr(bytes: Uint8Array, mime: string): Promise<string | null>
}

export interface OcrImagesResult {
  markdown: string
  recognized: number
  unrecognized: number
}

const DEFAULT_CONCURRENCY = 4
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000
// 实测正常一张 ~3s；20s 对单张图已经很宽松，同时远小于总预算，能在挂住时及时让出工位。
const DEFAULT_PER_IMAGE_TIMEOUT_MS = 20_000

/** 未识别的**必须在正文里看得见**。静静跳过正好是"缺省信息"，而这件事的目的就是不缺省。 */
const unrecognizedNote = (reason: string) => `[未识别：${reason}]`

export async function ocrArticleImages(
  markdown: string,
  deps: OcrImagesDeps,
  opts: { concurrency?: number; totalTimeoutMs?: number; perImageTimeoutMs?: number } = {},
): Promise<OcrImagesResult> {
  const images = listMarkdownImages(markdown)
  if (images.length === 0) return { markdown, recognized: 0, unrecognized: 0 }

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const deadline = Date.now() + (opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)
  // 单图上限：没有它，一张挂住的图会占死一个工位到总预算耗尽——并发是 4，
  // 4 张挂住就能让剩下所有图连一次尝试都没发生（0 张成功，而不是"快的那些成功了"）。
  const perImageTimeoutMs = Math.max(1, opts.perImageTimeoutMs ?? DEFAULT_PER_IMAGE_TIMEOUT_MS)

  // 预填「总超时」：没轮到的、跑不完的，最终都是这个理由。跑成功的会把它覆盖掉。
  const outcomes: NoteOutcome[] = images.map(() => ({ note: unrecognizedNote('总超时'), ok: false }))

  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= images.length) return
      // 已经过了截止时刻就别再开新的一张——剩下的保持「总超时」标记。
      if (Date.now() >= deadline) return
      outcomes[i] = await one(images[i].url, deps, deadline, perImageTimeoutMs)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, images.length) }, worker))

  // 数 ok，不数文案前缀——`ok` 是判别式联合的结果，跟成功批注具体怎么措辞无关。
  // 靠字符串前缀反推结构正是上一条 commit 刚从 one() 内部拿掉的哨兵字符串模式，
  // 挪到出口重犯一次：改一下措辞，这个计数器就会静默漂移而测试还是绿的。
  const recognized = outcomes.filter((o) => o.ok).length
  return {
    markdown: annotateMarkdownImages(markdown, outcomes.map((o) => o.note)),
    recognized,
    unrecognized: images.length - recognized,
  }
}

// fetchBytes 的 null（取不到图片）与 ocr 的 null（没识别出东西，见 OcrImagesDeps 的注释）
// 是两种完全不同的失败，指向两个相反的排查方向。用判别式联合区分三种结局，而不是把它们
// 塞进普通字符串哨兵——哨兵字符串和 `deps.ocr` 的真实返回值共享同一个值域，真实识别出的
// 文字若恰好撞上哨兵字面量（水印、对抗样本）就会被误判成失败标记。
type WorkOutcome =
  // `scope` 记的是哪道闸先到：'total' = 整批预算耗尽（这张根本没轮到/没跑完，别的图可能也在遭殃）；
  // 'perImage' = 只有这一张自己太慢。两者标记不同文案——读的人据此判断下一步完全不同
  // （前者是"图太多/整体太慢"，后者是"这张图有问题"）。
  | { kind: 'timeout'; scope: 'total' | 'perImage' }
  | { kind: 'nofetch' }
  // GIF：视觉模型处理不了，主动不送——这是产品限制不是识别失败，标记要分得清。
  | { kind: 'skip' }
  | { kind: 'text'; value: string | null }

/** `one()` 的产出：批注文案 + 是否识别成功的判别式联合结果。`ok` 和 `note` 分开，
 *  出口数「识别了几张」靠 `ok`，不靠对 `note` 文案做字符串匹配——两者共享同一个道理：
 *  真实值域不该和"这是不是失败标记"的判定共用同一个字符串通道。 */
interface NoteOutcome {
  note: string
  ok: boolean
}

/** 一张图的完整处理。**任何失败都在这里被吃掉换成一条标记** —— 单张图出问题不能让整篇正文
 *  消失："正文有、某张图没识别"是一个有用的结果，判成整体失败则连正文一起没了。 */
async function one(
  url: string,
  deps: OcrImagesDeps,
  deadline: number,
  perImageTimeoutMs: number,
): Promise<NoteOutcome> {
  const perImageDeadline = Date.now() + perImageTimeoutMs
  // 两道闸并存，取先到的那个。谁先到就由谁定标记文案——判据只看谁的截止时刻更近，
  // 不看"是不是第一次调用"，这样无论总预算剩多少，两条闸互不覆盖对方的语义。
  const scope: 'total' | 'perImage' = deadline <= perImageDeadline ? 'total' : 'perImage'
  const effectiveDeadline = scope === 'total' ? deadline : perImageDeadline
  const remaining = effectiveDeadline - Date.now()
  if (remaining <= 0) return { note: unrecognizedNote(scope === 'total' ? '总超时' : '识别超时'), ok: false }
  // Promise.race 里输掉的那一路不会被自动清理：赢的一路仍然是 pending 的挂起状态。
  // 常规路径下 OCR 远快于两道超时闸，赢的每次都是 timer 这一路——不清理就是每处理一张图
  // 留一个悬挂定时器，常驻进程里会持续堆积。用 finally 兜底，保证无论走哪个分支（含 catch）都清理掉。
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<WorkOutcome>((res) => {
      timer = setTimeout(() => res({ kind: 'timeout', scope }), remaining)
    })
    const work = (async (): Promise<WorkOutcome> => {
      const src = await deps.fetchBytes(url)
      if (!src) return { kind: 'nofetch' }
      // 判据用下载回来的 mime（fetchBytes 交回的权威值），不用 URL 后缀——有些平台的
      // CDN 会在 URL 上挂参数化后缀（`....gif@264w_264h_1e_1c`），靠后缀猜既不准也不通用。
      // 下载本身很快（~0.3s），相对一次注定挂住的视觉调用可以忽略；省下的正是这次调用本身。
      if (src.mime === 'image/gif') return { kind: 'skip' }
      const value = await deps.ocr(src.bytes, src.mime)
      return { kind: 'text', value }
    })()

    const r = await Promise.race([work, timeout])
    if (r.kind === 'timeout') return { note: unrecognizedNote(r.scope === 'total' ? '总超时' : '识别超时'), ok: false }
    if (r.kind === 'nofetch') return { note: unrecognizedNote('取不到图片'), ok: false }
    // 用词特意不叫"识别失败"：这张图我们根本没送出去，是产品限制（视觉模型处理不了 GIF），
    // 不是模型/端点出了问题——两者的下一步完全不同（前者无需排查，后者要去查模型/端点）。
    if (r.kind === 'skip') return { note: unrecognizedNote('GIF 不支持，未送识别'), ok: false }
    const text = r.value?.trim()
    if (!text) return { note: unrecognizedNote('图上没有可读文字'), ok: false }
    return { note: `图中文字：${text}`, ok: true }
  } catch (e) {
    // e 不保证是 Error（裸字符串/普通对象都能被 throw）；.message 在那种情况下是
    // undefined，产出的 `[未识别：undefined]` 对排查零信息量。
    return { note: unrecognizedNote(e instanceof Error ? e.message : String(e)), ok: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
