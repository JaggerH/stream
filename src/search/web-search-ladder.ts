/**
 * 「上网查一下」的唯一实现：**在用户自己那个 Chrome 里打开真的搜索结果页**（拟人采集，
 * 主腿 `primary` + 备胎 `fallback` + 中文并联腿 `cjk`）。
 *
 * **这一层只认角色，不认站点。** 每条腿接到哪个包的哪个源、叫什么名字（日志与 note 里给人读的
 * 出处，`WebSearchLeg.label`），是装配处（`src/kernel/plugins/agent.ts`）的产品判断；下面讲实测
 * 证据的散文里出现的站名，说的是今天装配处接的那几家。
 *
 * **为什么是浏览器而不是一个搜索容器**：不带浏览器地取，这台机器上的免费元搜索引擎大多被
 * 反爬挡着；能答的那一两家回的是买词广告站（查一条技术问题，前几名是培训机构）。而同一条查询
 * 在用户自己的 Chrome 里打 Google，9 条全切题、没有验证码——挡住的是「请求不像浏览器」，
 * 不是这台机器的 IP。
 *
 * **成本的形状**（实测）：热的一趟 12–14s，冷的 50s 级；浏览器搜索腿本身 6.3–27.8s，偶发挂满
 * ~30s。出口的折叠（`foldSameStory`）冷跑还能在这之上叠 20–40s，所以它被 `FOLD_BUDGET_MS`
 * 一个 8s 的总预算兜着——到点就把没折的原样给出去。
 *
 * ## 一条硬规矩
 *
 * **任何一条腿的失败都不许把整个工具变成 error。** 扩展没连、被限速、超时、Google 改版，全都
 * 回落成「有多少给多少 + 一句 note」。把「没查成」变成 error，模型会重打同一条查询，而对话
 * 循环没有退避——实测一轮里连着 22 条 web_search error 就是这么来的。note 的文案里也不留
 * 「稍后再试」，那等于在邀请重试。
 *
 * ## 备胎（Brave）挂在哪一格
 *
 * **Brave 是 Google 的备胎，不是另一档**：只有 Google 那一档**没跑成**（抛错：漂移 / 撞验证码 /
 * 被限速 / **撞满每小时累计预算** / 扩展没连）时才叫醒它；Google 跑通了但确实没有结果 → **不叫**（那是结论，不是失败）。
 * 理由是它补的是**冗余**——今天 Google 这条腿一断，网页搜索就整个没了。它给的结果确实和 Google
 * 不一样（自己的索引，实测重合 2/10），但那份**多样性**要用就该由 search_agent 显式去调，
 * 不值得在这条热路径上为它多开一个浏览器标签。
 *
 * ## 百度挂在哪一格：不是备胎，是按语言并联的第二条腿
 *
 * **百度补的是「中文长尾覆盖」，不是冗余**，所以它的判据和 Brave 完全不同：**不看 Google 成没成，
 * 只看这条查询是不是中文**（`pickBrowserLegs` 的 `'cjk'`）。查询里有汉字 → Google 和百度**并行**跑，结果合并
 * （Google 的排前，按 URL 去重）；没有汉字 → 只跑 Google，和以前一模一样。
 *
 * 为什么值得并联而不是串成第三档：实测「怡楽播客 小宇宙」这类查询百度回 10 条真结果
 * （各家中文播客源官方页与视频/音频站），Google/Brave 对中文小站覆盖差——**串在后面就永远轮不到
 * 它**（Google 有结果就到此为止，而它恰恰不是「Google 没有」时才有用）。并行付得起：实测 6 发并发
 * 搜索总墙钟 9s，两条腿的墙钟是 max 而不是和。
 *
 * **百度那条腿的任何失败都不许把整个工具变成 error**，甚至不许改变 Google 那半边的结论：它挂了就
 * 当它不存在（记一笔日志，结果里顶多在「一条都没有」时多一句 note）。理由和下面第 2 条硬规矩一样。
 *
 * ## 每小时预算撞满之后走哪一格
 *
 * 站点的闸门有两维（`src/replay/facility-rate-limit.ts`）：**速率**（一阵能打多密）和**累计量**
 * （一小时最多几发，`perHour`）。Google 拦人数的是后者——实测一小时约百发之后稳定回 `/sorry/index`。
 * 撞满累计预算时抛的是同一个 `RateLimitedError`，**所以这一层不需要认识它**：它落进上面那三格里的
 * 「没跑成」，于是 Google 撞满 → 走 Brave；中文查询还有并联的百度。**用户看到的是少了一条腿的结果，
 * 不是一个 error，也不是一次几十秒的干等**（预算撞满是立刻抛的，不走 `maxWaitMs` 那条「宁可等」）。
 */

import { foldWithText, type TextFoldDeps } from '../story-fold/text-fold.ts'
import { withDeadline } from '../story-fold/deadline.ts'
import type { SemanticFoldDeps } from '../story-fold/semantic-fold.ts'
import type { ChatMessage } from '../llm/client.ts'
import { SEARCH_PROFILE } from '../story-fold/profiles.ts'

/** 一条搜索结果，两档共用的形状（也正是 `web_search` 工具对外承诺的那个）。 */
export interface WebHit {
  title: string
  url: string
  snippet?: string
  /**
   * **被折进这一条的同源结果**（转载、镜像）。代表条带着它，被折的不再单独占格。
   *
   * 可选字段是刻意的：不认识它的消费端行为完全不变，只是列表短了。**折叠不是删除**——
   * 这里装着的每一条都还在，展开即还原（`src/story-fold/`）。
   */
  alsoAt?: Array<{ title: string; url: string }>
}

/** 一次搜索的产出：结果 + 一句「这次有没有哪里没查成」的软信号。 */
export interface WebSearchResult {
  hits: WebHit[]
  note?: string
}

/**
 * 一条浏览器搜索腿：**给人读的出处** + 真正去搜的那个函数。
 *
 * `label` 只进日志与给模型的 note（「在浏览器里打开 <label>」），不参与任何判据——换一家站点
 * 只动装配处，这一层一个字不改。
 */
export interface WebSearchLeg {
  label: string
  search: (query: string) => Promise<WebHit[]>
}

export interface WebSearchLadderDeps {
  /**
   * 主腿：借用户的浏览器打一家真搜索引擎（今天接的是 Google）。
   * 约定它「拿不到就抛」而不是回空数组——**空数组的意思是「主腿说没有」**，是一个结论；
   * 「选择器漂了 / 被拦」必须抛，两者的处置完全相反（判据在 recipe 的等待步里）。
   */
  primary: WebSearchLeg
  /**
   * **主腿那一档的备胎**（同样是借用户的浏览器）。**只在主腿「没跑成」时被叫醒**——抛错才算
   * 没跑成：漂移、撞验证码、被限速、扩展没连。主腿跑通了但确实没有结果 → **不叫它**，那是一个
   * 结论而不是失败。
   *
   * 它补的是**冗余**，不是多样性：今天主腿一断，网页搜索就整个没了。实测今天接的备胎（Brave）
   * 和主腿（Google）只重合 2/10（它有自己的索引），但那份差异要给出去是 search_agent 显式调它的事，
   * 不在这条梯子上为它多开一档——多开一档就是每次都多付一个浏览器标签。
   *
   * 和主腿同一个约定：**拿不到就抛**，不要回空数组（recipe 侧已经把「备胎明确说没有」
   * 和「选择器漂了」分开了，前者是成功的 0 条，后者抛错）。
   *
   * 可选是给测试留的口子；生产只有 `src/kernel/plugins/agent.ts` 一个装配点，那里必须接上。
   */
  fallback?: WebSearchLeg
  /**
   * **和主腿并联的中文那条腿**。判据是 `pickBrowserLegs`：**查询里有汉字才叫它**，而且是
   * **和主腿同时发车**，不等主腿的结果。
   *
   * 它补的是**中文长尾覆盖**（实测 Google/Brave 对中文小站的索引差），不是冗余——所以它不能挂成
   * 「主腿失败才叫」：那样它永远轮不到，因为它有用的场景恰恰是主腿跑得好好的、只是没收录。
   *
   * **和主腿/备胎不同的是它的失败语义：它抛错不算这次搜索出问题。** 挂了就当这条腿不存在，
   * 主腿那半边的结果照常给出去（只在「一条都没有」时才多一句 note）。
   *
   * 和另外两条同一个约定：**拿不到就抛**，不要回空数组（recipe 侧已经把「明确说未找到」
   * 和「选择器漂了」分开了，前者是成功的 0 条，后者抛错）。
   */
  cjk?: WebSearchLeg
  /** 主腿没跑成时记一笔（日志 / debug 总线）。回落是软的，但不该是无声的。 */
  onPrimaryFailure?: (query: string, reason: string) => void
  /** 备胎也没跑成时记一笔。同上：软回落，但不无声。 */
  onFallbackFailure?: (query: string, reason: string) => void
  /** 中文那条腿没跑成时记一笔。它对结果没有影响，所以**日志是唯一的痕迹**——更不能省。 */
  onCjkFailure?: (query: string, reason: string) => void
  /** 中文那条腿的软截止，默认 `CJK_SOFT_DEADLINE_MS`。只有测试需要改它。 */
  cjkTimeoutMs?: number
  /**
   * **内容级折叠那一档的转成文字能力**（就是 `read_url` 背后那份 `makeArticleFetchDep`）。
   *
   * 接上 → 标题被改写过的转载也能折起来（判据是正文，`src/story-fold/text-fold.ts`）；
   * **不接 → 折叠退回只看链接和标题，行为一字不变**。它的任何失败都被 text-fold 就地吞成
   * 「判不了」，不会影响这次搜索的结果或 note。
   */
  readUrl?: (url: string) => Promise<{ text?: string } | null>
  /** 抓正文失败/超时记一笔。折叠是锦上添花，但它失手不该是无声的。 */
  onReadUrlFailure?: (url: string, reason: string) => void
  /**
   * **语义折叠那一档的问模型能力**（生产接的是 `llmContentQuiet`，永不抛）。
   *
   * 接上 → 「同一篇通稿被 AI 重写过」也能折起来（第 2 档的字数门槛在这类稿子上和「各写各的」
   * 挨得太近，分不开）；**不接 → 折叠只到第 2 档，行为一字不变**。它不发任何网络抓取，
   * 只吃第 2 档已经抓到的正文，一次搜索最多一发调用。
   */
  askLlm?: (messages: ChatMessage[]) => Promise<string | null>
  /** 语义那一档判不了（没配模型 / 超时 / 回话读不懂）记一笔。它没有别的痕迹。 */
  onSemanticFailure?: (query: string, reason: string) => void
  /** 折叠整段的总预算，默认 `FOLD_BUDGET_MS`。只有测试需要改它。 */
  foldBudgetMs?: number
  /** 折叠没在总预算里做完，这次不折了。**这是它唯一的痕迹**——结果和 note 都一个字不变。 */
  onFoldTimeout?: (query: string, budgetMs: number) => void
}

/**
 * **中文那条腿的软截止。** 并联的腿最容易犯的错就是：它挂住了，整条热路径跟着一起挂——主腿
 * 3 秒就回来了，用户却因为中文那半边要等满 recipe 自己的 60s `maxTaskMs` 而干瞪着 spinner。
 *
 * 12s 是照实测定的（今天接的百度）：正常一趟 3–5s；活体撞见过 relay 的导航命令偶发挂满 30s
 * （主腿同期也撞，不是中文腿特有），那种时候这条腿本来就该被当作不存在。**超时不取消它**——
 * recipe 自己会跑完并关掉标签，我们只是不再等它。
 */
const CJK_SOFT_DEADLINE_MS = 12_000

/**
 * **折叠整段的总预算。** 折叠的每一档各自有超时，合起来却没有上限：第 2 档最多 12 篇 ÷ 4 并发
 * × 8s = 24s，第 3 档再 20s——实测冷跑能在搜索腿之上稳定叠 20–40s。而折叠只是呈现层的锦上添花，
 * 「任何失败都只该退回不折」这条硬规矩，缺的另一半就是「太慢也算失败」。
 *
 * 8s 是用户拍的板。到点**返回没折的那份**（不是 error、不改 note），也**不取消上游**——同
 * `withSoftDeadline`／`withDeadline` 的处置：不等了，但不改变 promise 自己的命运。
 */
const FOLD_BUDGET_MS = 8_000

/** 到点就放弃等（返回 null = 这条腿不存在），**不改变** promise 自己的命运。 */
function withSoftDeadline<T>(p: Promise<T | null>, ms: number, onExpire: () => void): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onExpire()
      resolve(null)
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/**
 * 这条查询要不要走中文那条腿。**判的是汉字（Han），不是宽泛的「CJK」**：中文腿的价值是中文长尾，
 * 对纯假名 / 谚文的查询它没有优势，为它多开一个浏览器标签是纯成本。（含汉字的日文查询会走进来，
 * 无害——那条腿失败或没结果都不影响主腿那半边。）字段名 `cjk` 是「中日韩那一路」的习惯叫法，
 * 判据以这里为准。
 *
 * 抽成具名纯函数是为了能被钉住：判据一旦内联进 `webSearchLadder`，就没有地方写测试说
 * 「英文查询绝不开第二个标签」。
 */
export function hasCJK(query: string): boolean {
  // 基本汉字 + 扩展 A + 兼容汉字。刻意不含假名/谚文，理由见上。
  return /[㐀-䶿一-鿿豈-﫿]/.test(query)
}

/** 这次要开哪几条浏览器腿。主腿永远在，中文腿按语言加挂。 */
export function pickBrowserLegs(query: string): Array<'primary' | 'cjk'> {
  return hasCJK(query) ? ['primary', 'cjk'] : ['primary']
}

/**
 * 合并两条腿的结果：**前面那份优先**（主腿排前），按 URL 去重。
 *
 * 去重键刻意做了一点归一化：**同一个页面在两家搜索里常常一个 http 一个 https、一个带尾斜杠一个
 * 不带**（百度的 `mu` 属性尤其爱给 `http://`）。不归一化就会出现同一条结果占两格，而模型看不出
 * 它们是一个东西。只归一化到「协议 + 尾斜杠 + host 大小写」为止——再往下（去 query 参数、去
 * `www.`）就会把真的不同页面并掉。
 */
export function mergeHitsByUrl(...groups: WebHit[][]): WebHit[] {
  const seen = new Set<string>()
  const out: WebHit[] = []
  for (const group of groups) {
    for (const hit of group) {
      const bare = hit.url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
      const slash = bare.indexOf('/')
      // host 部分归一化大小写，路径**原样保留**——路径是大小写敏感的，一起 lower 会并掉不同的页面。
      const key = slash < 0 ? bare.toLowerCase() : bare.slice(0, slash).toLowerCase() + bare.slice(slash)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(hit)
    }
  }
  return out
}

/**
 * 折叠同源结果：**同一篇稿子被 N 个站转载，只占一格**。
 *
 * 挂在梯子出口是有意的——`web_search`（MCP）、对话 agent、search_agent 三个消费端共用这一个
 * 出口，改一处三处都吃到。尤其是 MCP 那边的 `slice(0, 10)`：折叠之后那 10 格全是不同的东西，
 * 而不是 4 条转载占掉 4 格。
 *
 * **只折叠，不丢弃**：被折的挂在代表的 `alsoAt` 上。判据与阈值见 `src/story-fold/`。
 *
 * 三道判据、一级比一级贵：链接同一性 + 标题 Dice（本地，零请求）→ 抓正文比最长共享块
 * （`text-fold.ts`）→ 问模型「是不是同一件事」（`semantic-fold.ts`，零抓取、一发调用）。
 * **每一档的依赖缺席就自动少一档**，行为退回上一档、一字不变。
 */
async function foldSameStory(hits: WebHit[], text?: TextFoldDeps, semantic?: SemanticFoldDeps): Promise<WebHit[]> {
  const groups = await foldWithText(hits, SEARCH_PROFILE, text, semantic)
  return groups.map((g) =>
    g.members.length === 0
      ? g.rep
      : { ...g.rep, alsoAt: g.members.map((m) => ({ title: m.title, url: m.url })) },
  )
}

/** 两句软信号拼一起（都可能缺席）。 */
function joinNotes(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => !!p && p.length > 0)
  return kept.length ? kept.join('；') : undefined
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 主腿那半边（含它自己的备胎）跑完之后的三种收场。**「跑通了但没有」和「没跑成」必须
 * 分开**：前者是结论，后者是缺口——它们对模型的意思完全相反，而在这一层长得一样（都是 0 条）。
 */
type PrimaryOutcome =
  | { kind: 'hits'; hits: WebHit[] }
  | { kind: 'empty'; note: string }
  | { kind: 'failed'; note: string }

/** 主腿本体 + 它的备胎。抽成一个函数是为了和中文那条腿并联。 */
async function runPrimaryLeg(query: string, deps: WebSearchLadderDeps): Promise<PrimaryOutcome> {
  const { primary, fallback } = deps
  try {
    const hits = await primary.search(query)
    // 跑通了但 0 条 = **主腿上确实没有**（recipe 侧已经把「漂了」那条路分出去抛错了，见
    // PRIMARY_EMPTY_NOTE 的头注）。这不是失败，所以也不喂 onPrimaryFailure——把它记成失败会一路
    // 传到检疫，几次之后整条腿被静默隔离。
    if (hits.length === 0) return { kind: 'empty', note: PRIMARY_EMPTY_NOTE(primary.label) }
    return { kind: 'hits', hits }
  } catch (e) {
    const reason = reasonOf(e)
    deps.onPrimaryFailure?.(query, reason)
    // 主腿断了 —— 这才是备胎的判据（跑通了但没结果不算，那是结论）。
    if (!fallback) return { kind: 'failed', note: PRIMARY_FAILED_NOTE(primary.label, reason) }
    try {
      const hits = await fallback.search(query)
      // 备胎顶上了：结果直接给出去。主腿那次失败不再往模型面前摆——它已经被补上了，
      // 摆出来只会让模型对一份完好的结果起疑。真要复盘去看 onPrimaryFailure 那条日志。
      if (hits.length > 0) return { kind: 'hits', hits }
      // 备胎跑通了、但备胎上也确实没有。**这不是失败**（同 PRIMARY_EMPTY_NOTE 的道理：
      // 记成失败会一路传到检疫，几次之后连备胎也被静默隔离），所以也不喂 onFallbackFailure。
      return { kind: 'empty', note: FALLBACK_EMPTY_NOTE(fallback.label) }
    } catch (e2) {
      const fallbackReason = reasonOf(e2)
      deps.onFallbackFailure?.(query, fallbackReason)
      return { kind: 'failed', note: BOTH_FAILED_NOTE(primary.label, reason, fallback.label, fallbackReason) }
    }
  }
}

export async function webSearchLadder(query: string, deps: WebSearchLadderDeps): Promise<WebSearchResult> {
  // **中文那条腿和主腿同时发车**（判据只看查询语言，见 pickBrowserLegs 的头注）。它的失败在
  // 这里就地吞掉换成 null——「这条腿不存在」和「这条腿说没有」必须分得开，而两者都不许影响
  // 主腿那半边的结论。就地 catch 还有一层作用：主腿先抛出去时它不会变成 unhandled rejection。
  const cjk = pickBrowserLegs(query).includes('cjk') ? deps.cjk : undefined
  const softDeadline = deps.cjkTimeoutMs ?? CJK_SOFT_DEADLINE_MS
  const cjkLeg: Promise<WebHit[] | null> = cjk
    ? withSoftDeadline(
        cjk.search(query).catch((e) => {
          deps.onCjkFailure?.(query, reasonOf(e))
          return null
        }),
        softDeadline,
        () => deps.onCjkFailure?.(query, `${softDeadline}ms 内没回来，这次不等它了`),
      )
    : Promise.resolve(null)

  const primary = await runPrimaryLeg(query, deps)
  const cjkHits = await cjkLeg

  // 先按 URL 合并两条腿（同一个页面两家都收录 = 一条），再把跨站转载折起来。顺序不能反：
  // URL 合并是硬去重，先做掉能让折叠少比几对。
  const byUrl = mergeHitsByUrl(primary.kind === 'hits' ? primary.hits : [], cjkHits ?? [])
  // 折叠**整段兜底**：它是呈现层的锦上添花，判据里任何一处出岔子都只该退回「不折」，
  // 绝不能把一份好好的搜索结果变成 error（同这个文件头注那条硬规矩）。**超时和出岔子同一个处置**
  // ——`withDeadline` 的 null 同时覆盖这两种（抛错也回 null），所以这里不需要再单挂一个 catch。
  const foldBudget = deps.foldBudgetMs ?? FOLD_BUDGET_MS
  const folded = await withDeadline(
    foldSameStory(
      byUrl,
      deps.readUrl ? { readUrl: deps.readUrl, onFetchFailure: deps.onReadUrlFailure } : undefined,
      deps.askLlm
        ? { ask: deps.askLlm, onJudgeFailure: (reason) => deps.onSemanticFailure?.(query, reason) }
        : undefined,
    ),
    foldBudget,
    () => deps.onFoldTimeout?.(query, foldBudget),
  )
  const merged = folded ?? byUrl
  // **有结果就只给结果。** 哪条腿路上摔了不再摆到模型面前——它已经被补上了，摆出来只会让模型
  // 对一份完好的结果起疑（同备胎顶上时的处置）。要复盘去看 onXxxFailure 那几条日志。
  if (merged.length > 0) return { hits: merged }

  // 到这里是真的一条都没有。此时才需要把「确实没有」和「没查成」的差别如实说清楚。
  const cjkNote = cjk ? (cjkHits === null ? CJK_FAILED_NOTE(cjk.label) : CJK_EMPTY_NOTE(cjk.label)) : undefined
  // `kind==='hits'` 在这里只可能是「结果全是没有 URL 的空壳」——没有话可说，不编一句 note。
  const primaryNote = primary.kind === 'hits' ? undefined : primary.note
  return { hits: [], note: joinNotes(primaryNote, cjkNote) }
}

// 下面这几句给模型看的人话里的站名，一律是装配处传进来的 `label`。

/** 给模型看的人话。**不写「稍后再试」**——那是在邀请重试，而重试这一轮不会更好。 */
const PRIMARY_FAILED_NOTE = (label: string, reason: string): string =>
  `补充搜索（在浏览器里打开 ${label}）这次没跑成：${reason}。所以「没有结果」不代表这东西不存在，` +
  `如实说这次没查到、别断言它不存在。`

/**
 * 主腿**跑通了、但一条都没有**——这是一个结论，不是一次失败。
 *
 * 两者对模型的意思完全相反（「确实没有」vs「没查成」），而在这一层它们长得一样：都是 0 条。
 * 分开的那道判据不在这里，在 recipe 里（例：没有结果的 Google 页 `#rso` 整个不存在；`#rso` 在却
 * 读不到结果 = 漂了 → 抛错）。**这个分工是被检疫机制逼出来的**：把「确实没有」也做成失败，
 * `RepairLedger` 几次之后就把这条腿隔离，此后 `ReplayAdapter` 直接 DECLINE、连浏览器都不开、
 * 一个字都不报——2026-08-12 活体撞过。
 */
const PRIMARY_EMPTY_NOTE = (label: string): string =>
  `补充搜索（在浏览器里打开 ${label}）跑通了，但 ${label} 上也没有相符的结果——可以如实说没搜到。`

/** 备胎跑通了、但备胎上也确实没有。和 `PRIMARY_EMPTY_NOTE` 同一个意思：这是结论，不是失败。 */
const FALLBACK_EMPTY_NOTE = (label: string): string =>
  `补充搜索（在浏览器里打开 ${label}）跑通了，但也没有相符的结果——可以如实说没搜到。`

/**
 * 中文那条腿跑通了、但它那边也确实没有。**只在「一条结果都没有」时才会说出口**——有结果时
 * 这句话是噪音。
 */
const CJK_EMPTY_NOTE = (label: string): string =>
  `中文那条腿（在浏览器里打开${label}）也跑通了，${label}上同样没有相符的结果。`

/**
 * 中文那条腿没跑成。它对结果没有影响（主腿那半边照常给），所以**只在一条结果都没有时才提**：
 * 那种时候它是一个真实的缺口，不说就等于让模型误以为「中文资料也查过了」。
 */
const CJK_FAILED_NOTE = (label: string): string =>
  `中文那条腿（在浏览器里打开${label}）这次没跑成，所以中文来源没查全——别断言这东西在中文互联网上不存在。`

/** 两档浏览器搜索都没跑成。两个原因都摆出来：它们常常是同一个（扩展没连、被限速）。 */
const BOTH_FAILED_NOTE = (
  primaryLabel: string,
  primaryReason: string,
  fallbackLabel: string,
  fallbackReason: string,
): string =>
  `补充搜索这次没跑成：${primaryLabel} ${primaryReason}；备胎 ${fallbackLabel} ${fallbackReason}。所以「没有结果」不代表` +
  `这东西不存在，如实说这次没查到、别断言它不存在。`
