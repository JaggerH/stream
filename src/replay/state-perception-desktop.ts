import type { A11yQuery, ImageHit, TextRead } from './desktop-driver.ts'
import { matchesWhere, pickTextDetailed, regionRect, TEMPLATE_MIN_SCORE } from './desktop-see.ts'
import type { StateDef } from './state-graph.ts'
import { identifyWith, type FeatureTest, type IdentifyResult, type Perception } from './state-perception.ts'

/** 识别只要两件事。**刻意不吃整个 driver**——认状态是只读的，不该绑上全部输入能力。 */
export interface DesktopProbe {
  findCount(q: A11yQuery): Promise<number>
  /**
   * 读屏。**要的是文字表，不是一整串字**——判据要按段的位置做几何（`where`），
   * 而且匹配本身也不是 `String.includes`（见下面 `pickTextDetailed` 那一段）。
   */
  readText(): Promise<TextRead>
  /** NCC 模板匹配。`image` 特征用它，**不要另写指纹算法**——这就是那个。 */
  findImage(templatePng: Buffer): Promise<ImageHit | null>
}

/**
 * 桌面侧的 `identify()`。和网页侧的差别只有一样：**它不免费**——每次都要现测。所以这一侧用
 * 默认的 `identifyPolicy: 'on-failure'`（顺路不认，`expect` 落空才认）。
 */
export class DesktopPerception implements Perception {
  constructor(private readonly probe: DesktopProbe) {}

  async identify(known: StateDef[]): Promise<IdentifyResult> {
    // 一次 identify 里屏只读一次。多条文字特征各读一次屏，是同一笔开销付好几遍
    // （桌面这一侧一次读屏最贵要好几秒），而且各次读到的还可能不是同一帧——那会让 AND
    // 判据在动画期间随机为假。
    let screen: TextRead | null = null
    const test: FeatureTest = async (f) => {
      switch (f.kind) {
        case 'a11y': {
          const there = (await this.probe.findCount(f.query)) > 0
          return f.absent ? !there : there
        }
        case 'text': {
          screen ??= await this.probe.readText()
          // **匹配走 `pickTextDetailed`，不走 `String.includes`。** 它带着两样这里必须有的
          // 东西：① `joinRows`——OCR 每帧的分段不一样，按段做判据在被切开的那些帧上永远
          // 匹配不上，而表现和"这东西真的没出现"一模一样；② `where`——把判据收窄到锚点的
          // 某一边，防的是"同一个名字在列表和标题里各有一份"那种认错对象。
          const p = pickTextDetailed(
            screen.texts,
            f.text,
            regionRect(f.region, screen.window, screen.scale),
            undefined,
            undefined,
            true,
            f.where,
          )
          // `ambiguous`（同一档里多处命中）**算它在**：判据问的是"这串字在不在屏上"，
          // 多处命中恰恰是更强的"在"。拒绝多命中是**定位层**的纪律（点哪儿必须唯一），
          // 别把它搬到识别层来——搬过来会让"屏上有两处「发送」"变成"没有发送"。
          const there = p.kind !== 'none'
          return f.absent ? !there : there
        }
        case 'image': {
          const hit = await this.probe.findImage(Buffer.from(f.png, 'base64'))
          let there = hit !== null && hit.score >= (f.minScore ?? TEMPLATE_MIN_SCORE)
          if (there && f.where) {
            // `where` 要拿文字表当锚点，所以这一档带 `where` 时**还是要读一次屏**。
            // 判据里能不带就别带——不带的话这一档一次 OCR 都不用花。
            screen ??= await this.probe.readText()
            there = matchesWhere(hit!.rect, f.where, screen.texts)
          }
          return f.absent ? !there : there
        }
        default:
          throw new Error(`桌面这条路线判不了 ${f.kind} 特征——图里混进了别的路线的东西`)
      }
    }
    return identifyWith(known, test)
  }
}
