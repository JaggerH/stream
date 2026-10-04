/**
 * `netdisk_transcribe` 的**形状层**：把一次头尾采样（`reconcile/sample-audio.ts` 的产物）投影成
 * 给模型的那份回执。取数在那边，这里一行网络都不发。
 *
 * 单独一个模块的理由和 `reconcile-surface.ts` 一样：这里的每条规则都是「一次回执占多少上下文」
 * 的闸门，而闸门失效是**静默的**——回执太大 → DSH 的 tool-result 修剪把它腰斩 → 模型手里是半段
 * 转写却以为是全段，照着判完就交答案了。
 *
 * 三条规则，都有测试钉着：
 *
 *  1. **每段正文封顶，截断显式说出来**（`truncated`）。不写的后果是模型拿半段当全段，静默答错。
 *  2. **「采样」这件事必须写在回执里**（`sampledOnly` + `coverage`）。这是它和 `extract` 最容易
 *     被混起来的地方：那边给的是整篇正文，这边给的是一集里的两分钟。模型只按手里这份数据判断，
 *     不写清楚它就会把「开头没提到 X」当成「整集没提到 X」。
 *  3. **空转写不是失败，是一条证据**，但要说人话（`note`）。片尾两分钟纯音乐时 ASR 如实返回空，
 *     一个光秃秃的 `text: ''` 会被读成「这次没取到」——而「结尾没人说话」恰恰是判「这份是不是
 *     被截断了」的关键证据。
 */
import type { AudioSampleFile } from '../netdisk/reconcile/sample-audio.ts'
import type { IdentityProbe } from '../netdisk/reconcile/identity-probe.ts'

/** 单段正文上限（字符）。两段合计 ~3KB，离修剪线远得很。 */
export const SEGMENT_TEXT_MAX = 1500

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

export interface TranscribeSampleInput {
  file: AudioSampleFile
  windowS: number
  probe: IdentityProbe
  /** 这一发是不是缓存命中（没有再付一次转写钱）。 */
  cached: boolean
}

/**
 * 判完之后模型必须做的那件事，放在**它刚读完这段数据**的位置——比写在工具描述里管用得多
 * （`docs/AGENT-TOOLING.md` §3：指令越靠近决策点越有效）。
 */
const NEXT_STEP =
  '这是采样片段，不是整集内容——**别拿它概括整集**（中间那一大段你没有听到）。'
  + '拿它对着 reconcile_status 给的候选集判「这份文件是哪一集」，判出来了就用 reconcile_decide '
  + "写回（{verdict:'is-episode', leftKey, path}）；判不出来就如实说不确定、把你听到的摆给用户，"
  + '不要硬选一个。结论要引转写里的原话，引不出原话的结论不要给——这条链路后面接的是认领或删除。'

export function projectTranscribeSample(input: TranscribeSampleInput): Record<string, unknown> {
  const { file, probe, windowS } = input
  const seg = (part: 'head' | 'tail', w: { text: string; startS: number; endS: number }) => {
    const full = w.text ?? ''
    const text = full.slice(0, SEGMENT_TEXT_MAX)
    return {
      part,
      startS: w.startS,
      endS: w.endS,
      at: `${mmss(w.startS)}–${mmss(w.endS)}`,
      text,
      // 截断自陈：不写它，模型会把半段当全段。
      ...(full.length > text.length ? { truncated: true, textChars: full.length } : {}),
      // 空不是失败。说清楚是哪一种空，否则「结尾没人说话」这条真证据会被当成取数没成。
      ...(full.trim() ? {} : { note: '这一段没有人说话（片头/片尾音乐或静音）——这本身是一条证据，不是取数失败' }),
    }
  }

  const segments = [seg('head', probe.head), ...(probe.tail ? [seg('tail', probe.tail)] : [])]
  const heard = segments.reduce((n, s) => n + (s.endS - s.startS), 0)
  return {
    file: file.path,
    durationS: file.durationS,
    sizeBytes: file.sizeBytes,
    windowS,
    // 「我听到的只有这些」必须是回执里的一格，不能只写在工具描述里。
    sampledOnly: true,
    coverage: probe.tail
      ? `只听了开头 ${mmss(probe.head.startS)}–${mmss(probe.head.endS)} 和结尾 `
        + `${mmss(probe.tail.startS)}–${mmss(probe.tail.endS)}；中间约 `
        + `${Math.max(0, Math.round((file.durationS - heard) / 60))} 分钟没有听。`
      : '这个文件短于两个窗口，上面就是它的全部内容。',
    segments,
    cached: input.cached,
    next_step: NEXT_STEP,
  }
}
