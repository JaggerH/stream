import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Observation } from './state-graph.ts'

// 上限按 facility 不是按状态：一个话多的状态（观测频繁的那个）会把同 facility 里
// 别的状态的观测挤出这 200 条窗口。
const MAX_PER_FACILITY = 200

// ASCII unit separator：控制字符，正常特征键（`dom:.foo`、`url:https://…`）不会含它。
// 用 join('') 无分隔会把 ['dom:.ab','dom:.c'] 和 ['dom:.a','dom:.bc'] 并成同一个键——
// 与 src/intervention/fingerprint.ts 用同一个分隔符，两处判据要能对上。
const SEP = '\x1f'

/** facility 里若有斜杠换下划线——和状态轨迹（ENGINE §6.8）同一条命名规则。 */
export function facilityFileName(facility: string): string {
  return facility.replace(/\//g, '_')
}

/**
 * 区分度闸的观测账本：每次 `identify()` **成功**认出状态，把「那一刻为真的特征键」记一笔。
 * `checkDiscriminative` 拿候选去撞这些历史观测——没有账本，闸就是一道装了但永远开着的门。
 * **按 facility 分文件**，键与状态图一致（spec §9.1）。写法与 RepairLedger 同（tmp + rename）。
 */
export class ObservationLedger {
  constructor(private readonly dir: string) {}

  private path(facility: string): string { return join(this.dir, `${facilityFileName(facility)}.json`) }

  for(facility: string): Observation[] {
    const p = this.path(facility)
    if (!existsSync(p)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'))
      // 文件被外部改坏成非数组（截断、手改）不该让调用方拿到一个假装可迭代的东西再炸在别处。
      return Array.isArray(parsed) ? (parsed as Observation[]) : []
    } catch { return [] }
  }

  record(facility: string, o: Observation): void {
    // 键要**规范化**（去重 + 排序）再比：同一次观测按不同顺序报来是常态（特征表的排列跟着
    // 状态定义走），照原样存会攒出一堆看起来不同、其实同一份的记录，把上限那 200 条挤满。
    const truths = [...new Set(o.truths)].sort()
    const key = `${o.state}${SEP}${truths.join(SEP)}`
    const cur = this.for(facility).filter((x) => `${x.state}${SEP}${[...new Set(x.truths)].sort().join(SEP)}` !== key)
    const next = [...cur, { state: o.state, truths }].slice(-MAX_PER_FACILITY)
    mkdirSync(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${facilityFileName(facility)}.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(next))
    renameSync(tmp, this.path(facility))
  }
}
