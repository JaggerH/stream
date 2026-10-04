/**
 * 决策 job 的 ① 枚举全集，**没有产品库可直查的那一档**：回落到发现循环（catalog 域）。
 *
 * `universe-catalog.ts` 的头注写着「discovery 那条留给没有产品库可查的品类」——这个文件就是那条。
 * 在它接上之前，`pickCatalog` 落空的品类（纸巾、洗衣液、猫粮……除手机之外的一切）拿到的是
 * 一份空全集，而回执照样报 `stopped: 'complete'`：**看起来像"市面上没有纸巾"，实际是我们
 * 根本没去找**。这是这条线上最贵的一种错——它不报错，只是安静地把能力缺口讲成了市场事实。
 *
 * 复用的是现成的 `enumerate_candidates` 那条循环（`agent/search/domains/catalog.ts` +
 * `flow.ts`）：品类找窝 → 发现聚集地 → 抓窝 → LLM 配对型号↔价格 → `price_search` 验真在售。
 * **不新造发现机制**，两条线本来就是同一份 spec 的两截，只是一直没接上。
 */
import { runSearch as runSearchImpl, type SearchFlowDeps } from '../search/flow.ts'
import { catalogDomain, type CatalogHit } from '../search/domains/catalog.ts'
import type { ChatFn } from '../search/joints.ts'
import type { SearchOutcome, WebHit, StopReason, TrajectoryStep } from '../search/types.ts'
import type { DecisionConstraints, UniverseModel } from './job.ts'

/** 枚举源的统一形状——直查（catalog）和回落（discovery）两档都长这样，`makeUniverse` 只认它。 */
export type UniverseFn = (c: DecisionConstraints, onProgress?: (note: string) => void) => Promise<{
  models: UniverseModel[]
  source: string
  truncated: boolean
  errors: string[]
}>

/**
 * 停止原因 → 「这份清单全不全」。**只有 `converged`（边际产出趋零）算走到头**；
 * 其余四种各自是一句人话，原样进 `errors`。
 *
 * 为什么每一种都要有话说：只标一个 truncated 布尔的话，回执说得出「清单是残的」却说不出
 * 为什么——`universe-catalog.ts` 已经为同一件事栽过一次（三档全挂、universe 恒 0，回执一个字
 * 都没解释）。这里照它的教训写。
 */
const STOP_NOTE: Record<Exclude<StopReason, 'converged'>, string> = {
  truncated: '跑满轮次被掐断',
  dry: '扩源干涸（没有新搜索词了）',
  interrupted: '中途某一轮挂了，按已攒下的收尾',
  early: '够数早停',
}

/** 轨迹步 → 报给外面的人话。只挑**能说明"它在干什么、走到哪"**的那几步；
 *  `note` 是循环自己写的一句（分数 / 停止原因），原样带上比重新编一句准。 */
const PROGRESS_NOTE: Partial<Record<TrajectoryStep['kind'], (note?: string) => string>> = {
  search: () => '换词搜索，找聚集页',
  classify: (n) => `分拣搜索结果${n ? `（${n}）` : ''}`,
  fetch: (n) => `抓聚集页${n ? `（${n}）` : ''}`,
  verify: (n) => `验候选真在售${n ? `（${n}）` : ''}`,
  expand: (n) => `扩源${n ? `（${n}）` : ''}`,
  rank: (n) => `收尾排序${n ? `（${n}）` : ''}`,
}

export interface DiscoveryUniverseDeps {
  /** 注入以便测试。生产传 `flow.ts` 的 `runSearch`。 */
  runSearch?: typeof runSearchImpl<CatalogHit>
  chat?: ChatFn
  priceSearch?: (model: string) => Promise<Array<{ title?: string; excerpt?: string; url?: string }>>
  webSearch?: (keyword: string) => Promise<WebHit[]>
  fetchPage?: (url: string) => Promise<string>
  /**
   * 进度回调——**不是可选的装饰**。发现循环是整条决策里最慢的一格（活体 2026-09-04 纸巾：
   * 7 分 53 秒，占总耗时的 56%），而它跑的时候外面只看得见一句「枚举全集」。
   * 第一版把 `emit` 传成了 `() => {}`，代价当场就付了：那 8 分钟里说不出开了几个窝、
   * 卡在哪一轮，**连"是不是卡住了"都判不了**。
   */
  onProgress?: (note: string) => void
}

export function makeDiscoveryUniverse(deps: DiscoveryUniverseDeps): UniverseFn {
  const run = deps.runSearch ?? (runSearchImpl as typeof runSearchImpl<CatalogHit>)
  return async (c, onProgress) => {
    const progress = onProgress ?? deps.onProgress
    const source = 'discovery:catalog'
    const range = [
      c.priceRange.min === undefined ? '' : `${c.priceRange.min} 元以上`,
      c.priceRange.max === undefined ? '' : `${c.priceRange.max} 元以内`,
    ].filter(Boolean).join('、')
    const goal = [c.category.join(' '), range, ...c.softCriteria].filter(Boolean).join('，')

    let round = 0
    let outcome: SearchOutcome<CatalogHit>
    try {
      outcome = await run(
        goal,
        {
          chat: deps.chat!,
          webSearch: deps.webSearch!,
          fetchPage: deps.fetchPage!,
          domain: catalogDomain({
            chat: deps.chat!,
            priceSearch: deps.priceSearch!,
            constraints: { category: c.category, priceRange: c.priceRange },
          }),
          // **显式关掉早停**，理由同 `enumerate_candidates` 的接线处：装配时那份 earlyStop 是照
          // 网盘档配的，「够 N 条就收工」对"找到某个东西"是对的，对"枚举有哪些"恰恰是错的。
          // 一份提前收工的清单正是这个功能存在的理由要消灭的那个东西。
          earlyStop: undefined,
        } as SearchFlowDeps<CatalogHit>,
        // 轨迹接出去：每一步一句人话。轮次从 `search` 步计（一轮一次提词）。
        (step) => {
          if (!progress) return
          if (step.kind === 'search') round++
          const note = PROGRESS_NOTE[step.kind]?.(step.note)
          if (note) progress(`发现循环 第 ${round} 轮：${note}`)
        },
      )
    } catch (e) {
      // 整条循环挂了不放倒整轮决策——但它意味着全集是残的，且**原因必须带出去**。
      return { models: [], source, truncated: true, errors: [`发现循环失败：${e instanceof Error ? e.message : String(e)}`] }
    }

    const errors: string[] = []
    if (outcome.stopped !== 'converged') errors.push(`发现循环${STOP_NOTE[outcome.stopped]}，清单不全`)
    // 「找了但空手」必须和「没有枚举源」分开说。两句话在回执里长得一样的话，用户读到的是
    // 「市面上没有纸巾」，而真相是这个品类的窝我们一个都没开成。
    if (outcome.targets.length === 0) errors.push('发现循环跑完了但一台都没抽到（窝没开成 / 抽出来的没验上）')

    const models: UniverseModel[] = outcome.targets.map((t) => ({
      model: t.model,
      ...(t.price === undefined ? {} : { listPrice: t.price }),
      // 出处 = 抽到它的那个窝。**候选集的价值一半在出处上**（catalog 域头注），
      // 没有出处的候选集不许进支配运算。
      ...(t.hubUrls[0] ? { url: t.hubUrls[0] } : {}),
    }))

    // catalog 域的 check 对**每个**候选都跑过 `price_search`，只留下"查得到、且价格落在
    // 区间内"的那些（查无此型号直接刷掉）。所以这一档的 listPrice 是验过在售的，
    // 比价整轮空手时可以退到它——判据在这儿申报，不留给 job 猜。
    return { models, source, truncated: outcome.stopped !== 'converged', errors, listPriceVerified: true }
  }
}

/**
 * 两档合一：**直查优先，直查说没有才回落发现循环**。
 *
 * 回落的判据只有一条——`direct` 自己回的 `source === 'none'`。**不在这里复刻一份品类正则**：
 * 两份判据一旦分家，就会出现「直查说没有、这里以为有」的静默错位（本仓库里同一形状的错
 * 已经撞过五次，见 AGENTS.md「加了一份名单 → 名字就是你的回补清单」）。
 *
 * 反过来也守死：**直查命中但一台没取到时不回落**。那是直查的事实（上游今天挂了），
 * 回落会把「那份产品库今天全挂了」洗成「发现循环找不到手机」，排查时手里就只剩后面那句。
 *
 * 直查说 none 时带着的 `errors`（典型：某个包的产品库声明写错了）并进回落结果——
 * 否则"手机怎么走了发现循环"这个问题在回执里没有答案。
 */
export function makeUniverse(direct: UniverseFn, discovery: UniverseFn): UniverseFn {
  return async (c, onProgress) => {
    const d = await direct(c, onProgress)
    if (d.source !== 'none') return d
    const r = await discovery(c, onProgress)
    return d.errors.length ? { ...r, errors: [...d.errors, ...r.errors] } : r
  }
}
