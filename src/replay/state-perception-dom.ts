import type { PageDriver } from '../../shared/browser-relay/page-driver.ts'
import type { StateDef } from './state-graph.ts'
import { identifyWith, type FeatureTest, type IdentifyResult, type Perception } from './state-perception.ts'

/**
 * `*` 通配的整串匹配。**不是 `includes`**：`https://x.com/a` 不该匹配上
 * `https://x.com/a/b`，否则「首页」这个状态会把每一个子页都认成自己——而那正是
 * 区分度闸想拦、却在运行时被一个宽松的匹配悄悄绕过去的情形。
 */
export function matchUrlPattern(pattern: string, url: string): boolean {
  // 先按 `*` 切开、再逐段转义，**不要**拿某个字符当哨兵（比如把 `*` 换成空格再 split）：
  // 那样模式里本来就有的那个字符会跟着变成通配符，而且错得很安静。
  const escaped = pattern
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(url)
}

/**
 * 网页侧的 `identify()`。**近似免费**——URL 是一个每时每刻都在的确定性标签，选择器判断也是
 * 本地的。所以这一侧可以每步都认一次（`identifyPolicy: 'every-step'`），认得越勤越早发现走偏。
 */
export class DomPerception implements Perception {
  constructor(private readonly driver: PageDriver) {}

  identify(known: StateDef[]): Promise<IdentifyResult> {
    return identifyWith(known, this.test)
  }

  private readonly test: FeatureTest = async (f) => {
    switch (f.kind) {
      case 'url': {
        if (!this.driver.currentUrl) {
          throw new Error('这个 driver 不提供 currentUrl，判不了 url 特征——别把它静默当成不匹配')
        }
        return matchUrlPattern(f.pattern, await this.driver.currentUrl())
      }
      case 'dom': {
        const there = await this.driver.exists(f.selector)
        return f.absent ? !there : there
      }
      default:
        throw new Error(`网页这条路线判不了 ${f.kind} 特征——图里混进了别的路线的东西`)
    }
  }
}
