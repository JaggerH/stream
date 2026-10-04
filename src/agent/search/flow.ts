// src/agent/search/flow.ts
import type { Hub, ScoredHit, SearchOutcome, StopReason, TrajectoryStep, WebHit } from './types.ts'
import { classifyHits, proposeQueries, type ChatFn } from './joints.ts'
import { rankTargets } from './rank.ts'
import type { DiscoveryDomain } from './domain.ts'

export type Emit = (step: Omit<TrajectoryStep, 'seq' | 'at'>) => void

export interface SearchFlowDeps<T> {
  /** the discovery entry — one keyword search of the open web (spec §6 step 1). 装配时吃的是
   *  `web-search-ladder`，和对话里的 `web_search` 同一条梯子；这里只要结果集。 */
  webSearch: (keyword: string) => Promise<WebHit[]>
  chat: ChatFn
  /** 乙档: fetch a hub page's text so the domain's parse can pull concrete candidates (spec §6
   *  step 3). When absent, the flow is 甲档 (discover hubs only, no fetch). */
  fetchPage?: (url: string) => Promise<string>
  /** 领域差异的全部（spec 2026-09-01 §2.1）：parse / check / habitat / identityOf / hubAffinity。 */
  domain: DiscoveryDomain<T>
  /** max discovery rounds. Default 3. */
  maxRounds?: number
  /**
   * 早停参数（Task 2，spec §2.5 ②）。**不是另一套判据**——通用停止是「边际产出趋零」（收敛），
   * 早停只是叠在它之上的参数：`topical` 够 N 条、或甲档（无 fetchPage）集齐 `hubs` 个窝就停。
   * 网盘档传 `{ topical: targetCount, hubs: hubTarget }` 原样保住现状行为；枚举档可不传，只靠收敛。
   */
  earlyStop?: { topical: number; hubs: number }
  /**
   * 乙档 cost guard: **每一轮**最多进几个窝。Default 5。
   *
   * **按轮给、不按 run 给**，是 2026-08-15「摇滚夏令营3」那次的直接教训：当时是整个 run 12 个名额，
   * round 0 一口气吃光，round 1 只剩 1 个、放弃 33 个窝，round 2 名额为 0、9 个窝一个没开。而后两轮
   * 恰恰是**学会品类词之后**才搜出来的更好的窝（TG 网盘频道），也就是这条链路上唯一真能抽出链接的
   * 那一类——名额全被第一轮那批泛泛资源站占了。表现是：三轮 20 条查询、255 条搜索结果、开了一堆
   * 标签，最后 0 条切题。**扩源的意义全在后面几轮，名额却只发给第一轮。**
   */
  maxHubsPerRound?: number
}

const TOPICAL = 2

/** hub url → host。回灌按 host + kind 两个键各记一份（Task 3，spec §2.2）。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 每开一个窝：fetched +1，这一窝验完还算数的候选数加进 kept。 */
function bumpYield(map: Map<string, { fetched: number; kept: number }>, key: string, kept: number): void {
  const cur = map.get(key) ?? { fetched: 0, kept: 0 }
  cur.fetched += 1
  cur.kept += kept
  map.set(key, cur)
}

/** The code-driven skeleton (spec §6, search-led two-axis discovery loop). LLM only at the joints
 *  (proposeQueries / classifyHits / check 的贵半段); every branch and stop condition is code.
 *  Each round: propose two-axis queries (A 名字直取 + B 品类找窝) → web search → classify into
 *  direct/netdisk/hub/noise + learn category vocab → 乙档 fetch new hubs and let the domain's
 *  parse extract concrete candidates → check (verify + score) → accrete hubs → loop until enough
 *  or dry. Emits one trajectory step per stage. 领域差异全部收在 `deps.domain`（spec §2.1）。 */
export async function runSearch<T>(goal: string, deps: SearchFlowDeps<T>, emit: Emit): Promise<SearchOutcome<T>> {
  const seeds = deps.domain.habitat
  const maxRounds = deps.maxRounds ?? 3
  const es = deps.earlyStop
  const maxHubsPerRound = deps.maxHubsPerRound ?? 5

  const tried: string[] = []
  const scored: Array<T & { fit: number }> = []
  const hubs: Hub[] = []
  const learned: string[] = []
  const fetched = new Set<string>()
  // 已见过的候选身份（identityOf）——「候选集不再增长」的分母（Task 2，spec §2.2）。
  const seen = new Set<string>()
  // 产出量回灌（Task 3，spec §2.2）：按 host 和 kind 各记一份「开过几个窝、验完剩几个算数」。
  // 排序时从亲和度里扣掉产出加成——能出活的窝后面轮次优先开。
  const yieldByHost = new Map<string, { fetched: number; kept: number }>()
  const yieldByKind = new Map<string, { fetched: number; kept: number }>()
  const yieldBonusOf = (hub: Hub): number => {
    // 只看 kept（spec §2.5 ③：信号取 check 之后还算数的数量，不是抽出来的数量）。
    // 产出为 0 的不惩罚到底——这轮空手可能只是被限流，压死它就再也不会被开第二次。
    return (yieldByHost.get(hostOf(hub.url))?.kept ?? 0) + (yieldByKind.get(hub.kind)?.kept ?? 0)
  }
  let stop: StopReason = 'truncated'

  let queries = await proposeQueries(goal, tried, learned, seeds, deps.chat, deps.domain.framing)
  if (queries.length === 0) queries = [`${goal} ${seeds[0] ?? ''}`.trim()] // always search at least once
  emit({ kind: 'seed', decision: { queries }, note: '搜索领路：A 名字直取 + B 品类找窝' })

  for (let round = 0; round < maxRounds; round++) {
    try {
      tried.push(...queries)
      // 逐条容错、整轮出声：单条查询失败（被站点限流、被拦、超时）不该拖垮这一轮——别的查询
      // 捞回来的照样有用。但**一条都没成**就不是"这轮没找到"，是"这轮压根没查成"，两者混成一个
      // 空数组的话，run 会安静地得出「没招到源」。
      //
      // **每轮的并发就是这一行的 `queries.length`（4–6 条）**，而它直接决定会不会被搜索引擎当机器：
      // 实测 18 发挤在 13 秒内打 Google，两次里有一次被验证码拦掉 6 发；同样 18 发拆成 3 轮×6 并发
      // （约 35 次/分钟）两次都是零被拦。所以**别把它改成"一次把所有轮的查询全撒出去"**——那正好
      // 落进被拦的那一档。站点侧的闸门另有一道（facility 的 `stream.rateLimit`），两道都别拆。
      const settled = await Promise.allSettled(queries.map((q) => deps.webSearch(q)))
      const ok = settled.filter((s): s is PromiseFulfilledResult<WebHit[]> => s.status === 'fulfilled')
      if (ok.length === 0 && settled.length > 0) {
        throw new Error(
          `搜索这一轮没有任何查询成功：${(settled[0] as PromiseRejectedResult).reason?.message ?? '未知原因'}`
        )
      }
      const webHits = ok.flatMap((s) => s.value)
      emit({ kind: 'search', input: { round, queries }, output: { count: webHits.length } })

      const cls = await classifyHits(goal, webHits, deps.chat, deps.domain.framing)
      for (const h of cls.hubs) if (!hubs.some((x) => x.url === h.url)) hubs.push(h)
      for (const v of cls.vocab) if (!learned.includes(v)) learned.push(v)
      emit({
        kind: 'classify',
        output: { directLinks: cls.directLinks.length, hubs: cls.hubs.length, vocab: cls.vocab },
        note: `累计聚集地 ${hubs.length}`,
      })

      // 乙档: fetch the highest-priority new hubs (up to this round's cap), in parallel, and let the
      // domain's parse pull concrete candidates out of each page. Priority = the domain's hubAffinity
      // (netdisk: telegram/community first — they expose links in static HTML) **减去** 该窝同
      // host / 同 kind 的历史产出（Task 3 回灌：能出活的窝后面轮次提优先级）。
      const fetchPage = deps.fetchPage
      // classifyHits 的 directLinks 是网盘形（netdisk 类是这一档的产物）；泛型循环里把它当候选
      // 塞进 T 的桶。商品档 directLinks 恒空（spec §2.5 ①），这个 cast 在 Task 4 后自然消失。
      const candidates: T[] = cls.directLinks as unknown as T[]
      let fetchInfo: { toFetch: Hub[]; eligible: Hub[]; byHub: Map<string, T[]>; extracted: number } | null = null
      if (fetchPage) {
        const eligible = cls.hubs.filter((h) => !fetched.has(h.url))
        const toFetch = eligible
          .sort(
            (a, b) =>
              deps.domain.hubAffinity(a, goal) - yieldBonusOf(a) - (deps.domain.hubAffinity(b, goal) - yieldBonusOf(b))
          )
          .slice(0, maxHubsPerRound)
        const byHub = new Map<string, T[]>()
        const links = (
          await Promise.all(
            toFetch.map(async (hub) => {
              fetched.add(hub.url)
              try {
                const extracted = await deps.domain.parse(await fetchPage(hub.url), hub.url)
                byHub.set(hub.url, extracted)
                return extracted
              } catch {
                byHub.set(hub.url, []) // fetch failed (login-gated / blocked / 404) → skip; hub stays onboardable.
                return []
              }
            })
          )
        ).flat()
        candidates.push(...links)
        fetchInfo = { toFetch, eligible, byHub, extracted: links.length }
      }

      // Verify BEFORE scoring: the LLM then judges on the share's real file names instead of the
      // text that merely sat near the link, and the dead are gone before the batch scoring call
      // (which is the expensive one). Scoring first would lose on both counts. 这一段的顺序由
      // domain.check 内部保证（网盘档先 verify 后 score）；flow 只负责把 stats 说进轨迹。
      const { kept, stats } = await deps.domain.check(goal, candidates, deps.chat)
      if (stats.alive + stats.dead + stats.unchecked > 0) {
        emit({
          kind: 'verify',
          output: { alive: stats.alive, dead: stats.dead, unchecked: stats.unchecked },
          // 「没验上的怎么处置」是**领域策略**，别写死进这句：网盘档保留（一条没验到的链
          // 仍可能是活的），商品档丢弃（没出处的候选不许进支配运算，spec §2.4）。写死一种
          // 说法，另一档的轨迹就在骗读的人——而轨迹正是出事时唯一的复盘凭据。
          note: `验候选：合格 ${stats.alive} / 不合格 ${stats.dead} / 没验上 ${stats.unchecked}`,
        })
      }
      const roundScored = kept
      scored.push(...roundScored)
      const topical = scored.filter((h) => h.fit >= TOPICAL).length
      emit({ kind: 'score', output: { scored: roundScored.length }, note: `累计切题(≥${TOPICAL}) ${topical}${es ? `/${es.topical}` : ''}` })

      // 回灌 + fetch 步骤（挪到 check 之后：kept 只有验完才知道）。把这一轮验完还算数的候选按窝
      // 归因（identityOf 对上该窝 parse 抽出来的那些），累进 yieldByHost / yieldByKind。
      if (fetchInfo) {
        const { toFetch, eligible, byHub, extracted } = fetchInfo
        const keptTopical = roundScored.filter((h) => h.fit >= TOPICAL)
        const hubKept = new Map<string, number>()
        for (const [url, hubExtracted] of byHub) {
          const ids = new Set(hubExtracted.map((c) => deps.domain.identityOf(c)))
          hubKept.set(url, keptTopical.filter((k) => ids.has(deps.domain.identityOf(k))).length)
        }
        for (const hub of toFetch) bumpYield(yieldByHost, hostOf(hub.url), hubKept.get(hub.url) ?? 0)
        for (const hub of toFetch) bumpYield(yieldByKind, hub.kind, hubKept.get(hub.url) ?? 0)
        // 没开的那些要说出来：`fetched: 5` 单看像"这一轮就这么多窝"，而真相可能是"41 个里只开了
        // 5 个、名额用完了"。默不作声的截断读起来跟"全查过了"一模一样。
        //
        // **别把这条 emit 挪进任何"这一轮还有没有窝可开"的判断里**：那样一来，没窝可开的那一轮
        // 整块被跳过，轨迹上连一条 fetch 步骤都不存在。读的人看到的是"这一轮没找到链接"，真相是
        // "这一轮压根没开过窝"——正是上面这句注释本来要防的那件事，2026-08-15 真栽过一次。
        // **fetched / kept 并排写**（spec §2.2 ③）：只有两个数摆在一起，才看得出"抽得多但没一个
        // 算数"这种窝——按抽出量回灌会正确地学到一个错误的偏好。
        const skipped = eligible.length - toFetch.length
        emit({
          kind: 'fetch',
          output: { fetched: toFetch.length, extracted, kept: keptTopical.length, skipped },
          note: skipped > 0 ? `进窝抽链（本轮名额 ${maxHubsPerRound}，另有 ${skipped} 个窝没开）` : '进窝抽链',
        })
      }

      // 边际产出：这一轮 check 后**新增的不重复候选**（按 identityOf，只数 fit≥TOPICAL 的——
      // 候选集 = 算数的那批，spec §2.2「候选集不再增长」）。
      let newThisRound = 0
      for (const h of roundScored) {
        if (h.fit < TOPICAL) continue
        const id = deps.domain.identityOf(h)
        if (!seen.has(id)) {
          seen.add(id)
          newThisRound++
        }
      }

      // 停止三件套，顺序就是语义：早停（可判定的事实）→ 收敛（边际产出趋零）→ 轮次截断。
      // 收敛和截断都停，但对下游"覆盖范围"的含义相反（spec §2.4）——回执靠 stopped 分。
      if (es && (topical >= es.topical || (!deps.fetchPage && hubs.length >= es.hubs))) {
        stop = 'early'
        break
      }
      // **「还没开始」和「到顶了」长得一模一样，判据必须分开。** 门槛是 `seen.size > 0`
      // （此前至少产出过一条算数的候选），不是「这一轮抽到过东西」：第 0 轮常常抽到一堆链却
      // 一条都不切题——按后者会当场收敛在第 0 轮，而那正是 maxHubsPerRound 注释里那段教训
      // （2026-08-15「摇滚夏令营3」）所保的路径：真能出活的窝要到**学会品类词之后**的轮次
      // 才搜得出来。收敛只在「已经有过产出、这一轮不再增长」时成立。
      if (seen.size > 0 && newThisRound === 0) {
        stop = 'converged'
        break
      }
      if (round === maxRounds - 1) {
        stop = 'truncated'
        break
      }

      const next = await proposeQueries(goal, tried, learned, seeds, deps.chat, deps.domain.framing)
      if (next.length === 0) {
        stop = 'dry'
        emit({ kind: 'expand', note: '无新搜索词，停止' })
        break
      }
      emit({ kind: 'expand', decision: { queries: next, learned }, note: '换角度：名字变体 / 新品类词 / 新站型' })
      queries = next
    } catch (e) {
      // **一轮挂了不该把前面几轮验好的东西一起扔掉。** 这是本文件对 `webSearch` 早就写明的
      // 那条原则（逐条容错、只有"一条都没成"才致命）在**轮次**这一层的同一句话：已经攒下
      // 算数候选了 → 收尾交货，并在回执里说清它是残的；一条都没攒下 → 那才是真的没跑成，
      // 照抛。
      //
      // 为什么必须有这一条：上游 LLM 梯子是**所有消费方共享**的，它会成串地瞬时打不出去
      // （实测 2026-09-02：同一秒里 `llm.chat` 和 `story-fold.semantic` 一起 no_result，
      // 而前一发 7717 token 刚成功——是梯子在抖，不是体积问题）。抖一下就毁掉整条 run，
      // 代价是**已经花钱验过的候选全没了**：那天两条 run 分别丢了 22 条和 7 条。
      //
      // **绝不能安静地当成正常结束**：`interrupted` 和 `converged` 对"覆盖范围"的含义天差
      // 地别，下游据此决定敢不敢把这份清单说成"市面上的选择"。
      if (seen.size === 0) throw e
      stop = 'interrupted'
      emit({
        kind: 'expand',
        note: `第 ${round} 轮没跑完就断了（${(e as Error).message}）——按已攒下的收尾，这份清单是残的`,
      })
      break
    }
  }

  // **跨轮去重必须在这里做，按域的 `identityOf`。**
  //
  // `check` 只在**单轮内**合并（它只看得见这一轮的 candidates）；`scored` 是跨轮累积的，
  // 而 `rankTargets` 的去重键是 `link || JSON.stringify(hit)` —— 网盘档有 link，跨轮天然
  // 去得掉；商品档没有 link，价格差一块钱就是两条。活体（2026-09-02）真出过：同一台
  // 「vivo X300S 4499」和「vivo X300s 12GB+256GB 4999」双双进了最终清单。
  //
  // 后果不只是清单虚胖：**支配运算会把同一台机器的两个价格当成两个候选，便宜的那条
  // 「斩掉」贵的那条**，于是卡片上印着一行拿自己跟自己比出来的「已排除」。没有一处报错。
  //
  // 同一条候选留 fit 最高的那份（fit 相同则留先到的——先到的来自更早的轮次，出处更靠谱）。
  const bestById = new Map<string, T & { fit: number }>()
  for (const h of scored) {
    const id = deps.domain.identityOf(h)
    const prev = bestById.get(id)
    if (!prev || h.fit > prev.fit) bestById.set(id, h)
  }
  const deduped = [...bestById.values()]

  // rank 外提在 flow（spec §2.1：网盘档的「夸克优先」是用户偏好，Task 5 挪到调用侧）。
  // `deduped` 是 T 形，rankTargets 吃网盘形——运行时是同一批对象（check 的 kept 同时带着
  // fit 和 topicality），这里两个 cast 都是形状收窄，Task 5 把 rank 外提后消失。
  const targets = rankTargets(deduped as unknown as ScoredHit[]) as unknown as Array<T & { fit: number }>
  const onboardable = [
    ...new Set([
      ...hubs.map((h) => h.url),
      ...deduped.filter((h) => h.fit >= TOPICAL).flatMap((h) => deps.domain.originsOf(h)),
    ]),
  ]
  // 话术别写死成网盘那套：`rankTargets` 的「夸克优先」对商品档不成立（那些候选没有 netdisk
  // 字段，排序实际只剩切题分）。轨迹是出事时唯一的复盘凭据，写一句只在一个域成立的话，
  // 读的人会照着它推错。
  emit({
    kind: 'rank',
    output: { targets: targets.length, hubs: hubs.length },
    note: `按切题分排序（${deps.domain.name} 档）`,
  })
  emit({ kind: 'result', output: { targets: targets.length, hubs: hubs.length, onboardable, stopped: stop }, note: `停止原因：${stop}` })
  return { targets, hubs, onboardable, stopped: stop }
}
