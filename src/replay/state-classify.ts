import type { PageDriver } from '../../shared/browser-relay/page-driver.ts'
import { escapesFrom, featureKey, type Observation, type StateGraph, type StateId, type Transition } from './state-graph.ts'
import { DomPerception } from './state-perception-dom.ts'

export type StateVerdict =
  | { kind: 'unknown' }
  | { kind: 'ambiguous'; candidates: StateId[] }
  | { kind: 'deadEnd'; state: StateId; reason: string }
  | { kind: 'escapable'; state: StateId; escape: Transition }
  /** 认出来了但既不是死路也没有逃生口。可能同时认出好几个——跨组的状态互不相干。 */
  | { kind: 'identified'; states: StateId[] }

/**
 * `expect` 落空之后回头认一眼「我在哪」。
 *
 * 这是**诊断**,不是恢复:它只给结论,不动页面。恢复由调用方决定做不做——因为"要不要重试"
 * 依赖调用方才有的上下文(这一步有没有副作用、还剩几次配额)。
 *
 * **探测自己抛错时回 `unknown`**:这一趟本来就已经在失败路径上了,让一次诊断把它变成
 * 另一种失败,只会把真正的原因盖掉。
 */
export async function classifyByState(
  driver: PageDriver,
  graph: StateGraph,
  /**
   * 认出状态就记一笔观测（那一刻为真的特征键），喂区分度闸。**每一次成功识别都记**，不挑
   * "这一趟顺不顺"——死路和逃生口那两档同样是一次货真价实的识别，漏掉它们等于让闸只见过
   * 顺利的那一半页面，而撞车恰恰最常发生在拦截页上。省略 = 不记，行为与从前逐字节一致。
   */
  onObserved?: (o: Observation) => void,
): Promise<StateVerdict> {
  // 空图连一次 exists 都不该问——这条诊断挂在每一次失败上，没配图时它的开销必须是零。
  if (graph.states.length === 0) return { kind: 'unknown' }
  try {
    const r = await new DomPerception(driver).identify(graph.states)
    // **记在分档之前**：下面几条分支各自 return，挂在某一条上就只记到那一档的观测。
    if (onObserved && r.states !== null) {
      const truths = r.matched.map(featureKey)
      for (const id of r.states) {
        // 账本的问题不掀翻诊断：这一趟本来就在失败路径上，让一次记账把它变成另一种失败，
        // 只会把真正的原因盖掉（同这个函数外层 catch 的立场）。
        try { onObserved({ state: id, truths }) } catch { /* 记不上就算了，诊断照常出结论 */ }
      }
    }
    // **死路要先看，哪怕这一次是撞车。** 撞车（`ambiguous`）说的是"这几个我分不开"，
    // 而"其中一个是死路"这件事和分不分得开无关——CF 的拦截页是同源返回的，URL 一个字不变，
    // 所以靠 url 特征认的本地状态在封禁页上照样为真，撞车在这里是常态不是意外。
    // 先报 ambiguous 再也走不到下面，等于把最该早停的那一档永久藏起来。
    const hits = r.states ?? (r.reason === 'ambiguous' ? r.candidates : [])
    // 同时认出好几个时**按坏消息优先**：死路 > 有逃生口 > 只是认出来了。
    // 反过来（先报"认出来了"）会把"其中一条是死路"这件事盖掉，而那正是最该早停的一档。
    for (const id of hits) {
      const dead = graph.states.find((s) => s.id === id)?.deadEnd
      if (dead) return { kind: 'deadEnd', state: id, reason: dead }
    }
    if (r.states === null) {
      return r.reason === 'ambiguous' ? { kind: 'ambiguous', candidates: r.candidates } : { kind: 'unknown' }
    }
    for (const id of r.states) {
      const escape = escapesFrom(graph, id)[0]
      if (escape) return { kind: 'escapable', state: id, escape }
    }
    return { kind: 'identified', states: r.states }
  } catch (e) {
    // **吞掉之前先喊一声。** 这里同时接住两类完全不同的东西：探测自己失败（driver 掉线、
    // exists 超时，属于"这一趟本来就在失败路径上"），和**图非法**（`DomPerception` 对
    // 不认识的 kind 是抛错的——图里混进了桌面路线的 `text` 特征）。后者是作者的错，
    // 静默当成 `unknown` 会让这张状态图对这个源**永久失效**，而所有单测照样绿、日志一个字没有。
    console.error(`[state] 状态诊断失败，本次按 unknown 处置：${e instanceof Error ? e.message : String(e)}`)
    return { kind: 'unknown' }
  }
}
