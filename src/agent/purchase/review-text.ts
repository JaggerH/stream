/**
 * 「这一篇横评的正文从哪来」——决策 job 的 ② 抽取关节的**取料**那一半。
 *
 * 三档，按代价从低到高，**取到就停**：
 *
 * 1. **搜索结果自带的摘要**（`excerpt`）——零成本，图文笔记多半够。
 * 2. **`extract` 转写**——视频横评走这条。**本地 ASR 在手，这一档几乎是白拿的**
 *    （转换账本实测 1.0–15.5 秒），所以别因为"贵"跳过它：跳过的代价是**整类证据消失**
 *    ——视频横评恰恰是社区档里最有料的那一批，而摘要里只有一句标题党。
 * 3. **抓原页**（`readUrl`）——图文长文的兜底。
 *
 * ⚠️ **别把"取到一点点"当成取到了。** 一段 200 字的视频简介喂给抽取关节，模型会诚实地
 * 抽出零条点名，而回执长得和"这篇确实没夸谁"一模一样。所以这里有个**长度门槛**：
 * 摘要短于门槛就继续往下走，而不是拿它凑合。
 */
import type { ReviewItem } from './job.ts'

/** 摘要够长才直接用。低于它就往下一档走——一句标题党喂进去等于没喂。 */
export const MIN_USABLE_TEXT = 800

export interface ReviewTextDeps {
  /** 这一篇在搜索结果里自带的摘要（没有就空）。 */
  excerptOf: (id: string) => string
  /** 这一篇是不是有可转写的媒体（视频/音频）。没有就别白起一次转换。 */
  hasMedia: (id: string) => boolean
  /** 起一次 `extract` 并等它落定，返回转写文本；拿不到回空串。 */
  transcribe: (item: ReviewItem) => Promise<string>
  /** 抓原页正文。 */
  readUrl: (url: string) => Promise<string>
}

export function makeReviewText(deps: ReviewTextDeps): (item: ReviewItem) => Promise<string> {
  return async (item) => {
    const excerpt = deps.excerptOf(item.id)
    if (excerpt.length >= MIN_USABLE_TEXT) return excerpt

    // 视频档：转写。**顺序在摘要之后、抓页之前**——视频页抓回来的是壳，正文在音轨里。
    if (deps.hasMedia(item.id)) {
      const spoken = await deps.transcribe(item).catch(() => '')
      if (spoken.length >= MIN_USABLE_TEXT) return spoken
      // 转写短于门槛也可能是真的短（一条 30 秒的口播），所以它仍然参与下面的"取最长的一份"。
      if (spoken.length > excerpt.length) {
        const page = await deps.readUrl(item.url).catch(() => '')
        return page.length > spoken.length ? page : spoken
      }
    }

    const page = await deps.readUrl(item.url).catch(() => '')
    return page.length > excerpt.length ? page : excerpt
  }
}
