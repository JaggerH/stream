/**
 * 档 A 的**第二道判据：比正文**。
 *
 * `fold.ts` 那道只看得见搜索结果自带的两样东西——链接和标题。它治得了「同一篇稿子挂在 8 个
 * 域名下、标题一字不改」，治不了**标题被改写过的转载**：聚合站爱换成自己的口气、镜像站爱
 * 加前缀、门户转发时编辑会重拟一个标题。那种情况下两条的 Dice 只有 0.3，正文却是同一段话。
 *
 * ## 判据是「最长连续共享块」，不是草图相似度
 *
 * 网页抽出来的正文必然拖着一身样板（导航、推荐位、免责声明、股吧滚动条），**整篇算的
 * Jaccard 因此没法用**：活体实测同一篇通稿的两个转载只有 0.076–0.14，而「各写各的同一件事」
 * 是 0.006–0.016，两个数都贴着 0，中间没有能安全下刀的地方。换成「最长的那一段一模一样的
 * 连续正文」，同一批数据是 246 字 vs 11 字——差一个量级还带清晰的空档。量法与实测表在
 * `src/text/shingle.ts` 的 `longestSharedRun`：那张表里还有一类**这把尺分不开**的东西
 * （技术页面共享的 traceback / CLI 输出），门槛因此定在 130 而不是更低。
 *
 * ## 三条不许违反的
 *
 * 1. **抓正文只用来救「标题不像但可能是同一条」的那些。** 已经靠链接或标题判定的对子不再
 *    花钱（`fold.ts` 先跑，这里只在它的**堆代表**之间补判）。
 * 2. **抓不到 = 判不了，不是「不像」，更不是错误。** 任何一条抓取失败/超时都只让那一对
 *    保持原样，绝不让整次搜索变成 error（同 `web-search-ladder.ts` 头注那条硬规矩）。
 * 3. **同一个 URL 一次进程里只抓一次。** 缓存按归一化 URL 键。
 */

import { commonPrefixLen, commonSuffixLen, longestSharedRun, normalizeForFingerprint } from '../text/shingle.ts'
import { withDeadline } from './deadline.ts'
import { fold, hostOf, serialConflict, urlKey, type FoldGroup, type Foldable } from './fold.ts'
import type { FoldProfile, TextFoldSettings } from './profiles.ts'
import { foldGroupsBySemantics, textLookup, type SemanticFoldDeps } from './semantic-fold.ts'

/**
 * 太短的「正文」一律当作没取到。
 *
 * **这一条是防误并，不是省钱**：抓失败时上游常常回的不是空串，而是一句人话——Cloudflare 的
 * 「Just a moment…」、各家的「访问过于频繁」、登录墙的那一屏。两个不同的站撞上同一种拦截页，
 * 正文会**一模一样**，于是两条毫不相干的结果被并成一条。字数门槛把这类页面挡在判据之外。
 */
const MIN_TEXT_CHARS = 200

/**
 * 一篇正文最多留多少字参与比对。**这是给 CPU 和内存的上限**，不是判据的一部分：
 * 判据只看最长的那一段共享块，而它几乎必然落在正文里，正文又几乎必然在页面开头。
 */
const MAX_TEXT_CHARS = 20_000

/** 草稿缓存的存活时间。搜索是会话里连着打的，10 分钟足够覆盖一轮对话里的反复查询。 */
const CACHE_TTL_MS = 10 * 60_000
/** 缓存条数上限。到顶就整把清掉——这是个省钱的加速器，不是要精确的 LRU。 */
const CACHE_MAX = 300

/** 一条 URL 的归一化正文。`null` = 取过了但判不了（抓失败 / 正文太短），**下次也别再抓**。 */
type CacheEntry = { text: string | null; at: number }

export interface TextCache {
  get(key: string): string | null | undefined
  set(key: string, text: string | null): void
}

/** 进程级缓存。key 用 `urlKey` 归一化后的串（同一个页面的 http/https、带不带尾斜杠不重抓）。 */
export function makeTextCache(ttlMs = CACHE_TTL_MS, max = CACHE_MAX): TextCache {
  const map = new Map<string, CacheEntry>()
  return {
    get(key) {
      const e = map.get(key)
      if (!e) return undefined
      if (Date.now() - e.at > ttlMs) {
        map.delete(key)
        return undefined
      }
      return e.text
    },
    set(key, text) {
      if (map.size >= max) map.clear()
      map.set(key, { text, at: Date.now() })
    },
  }
}

const sharedCache = makeTextCache()

export interface TextFoldDeps {
  /**
   * 取一个网页的正文。**就是 `read_url` 背后那一份**（`makeArticleFetchDep`，
   * `src/content/article/article-fetch-dep.ts`）——全后端只有那一处实现，这里不另造抓取器。
   *
   * 约定：抓不到就抛或回 `null`/空 text，两者都被当成「判不了」。
   */
  readUrl: (url: string) => Promise<{ text?: string } | null>
  /** 抓取失败/超时记一笔。**软回落不该是无声的**（同梯子里 `onPrimaryFailure` 那条）。 */
  onFetchFailure?: (url: string, reason: string) => void
  /** 测试注入用；生产走进程级共享缓存。 */
  cache?: TextCache
}

/**
 * 这一对值不值得为它去抓正文。**这是候选闸门，不是判据。**
 *
 * 两条，每条都在挡掉一类「抓了也白抓」：
 *
 * - **两边都得有 host**：认不出 host 的（磁力、非 http）反正也抓不了正文。**这不是
 *   「跨站才算」**——同一个站里的转载照样要判，见 `sharedStoryRun`。
 * - **序列身份不冲突**：第 2 集和第 3 集的正文可能很像（同一个主持、同一段片头），
 *   靠相似度分不出来。这道硬否决必须跑在花钱之前，否则就是花钱买一个错答案。
 * - 剩下的**一律放行，不设标题相似度下限**——「标题完全不像」正是这一档存在的理由，
 *   在这里加个下限等于把要救的那些人先挡在门外。
 */
export function worthFetchingText(a: Foldable, b: Foldable): boolean {
  const ha = hostOf(a.url)
  const hb = hostOf(b.url)
  if (ha === '' || hb === '') return false
  if (serialConflict(a.title, b.title)) return false
  return true
}

/**
 * 共同页眉页脚**至少要占到较短那篇的这个比例**，才认它「长到不可能只是页脚」。
 *
 * 0.5 是照实测定的：同站样板占整篇的比例实测最高 25%（澎湃 484 / 1942 字），0.5 留了一倍余量。
 */
const EDGE_IS_CONTENT_RATIO = 0.5

/**
 * 这一对共享了多长的**正文**（不是「多长的文字」）。同站那一档全靠它。
 *
 * ## 同站为什么不能直接用 `longestSharedRun`
 *
 * 抽出来的正文拖着整页样板，而**同一个站的任意两个页面天然共享它**。实测（2026-08-14，
 * 每个站三篇内容毫不相干的文章，两两比，用的就是这把尺）：
 *
 * | 站 | 三对的共享块 | 那一段是什么 |
 * |---|---|---|
 * | `thepaper.cn` | **484 / 484 / 484** | 「收藏我要举报」+ 一串 `static/media/*.png` 图标地址 |
 * | 网易号（资讯自媒体平台） | **209 / 209 / 209** | 「特别声明：以上内容…网易号用户上传并发布」中英双语 |
 * | `baijiahao.baidu.com` | 66 / 66 / 66 | 「设为首页 关于百度…京ICP证030173号」 |
 * | `sohu.com` | 38 / 37 / 37 | 一条 `sohu.com/a/...` 链接 |
 *
 * 前两个站**直接越过 130 字的门槛**——同站一放开就会把两篇毫不相干的文章并掉。
 *
 * ## 判法：先剥掉两篇的共同页眉页脚，再比剩下的
 *
 * 三对之间共享块**一字不差地相等**（484/484/484、209/209/209），而且每一次都**正好是两篇的
 * 共同后缀**（页眉那侧实测 0–4 字）。所以样板不用猜、不用列名单、不用认结构标记（抽出来的
 * 正文本来也不保留结构标记）：**它就是共同后缀**，剥掉即可，剥的是实测量出来的那一截，
 * 不是拍脑袋定的长度。
 *
 * 剥完还剩下 ≥ 门槛的共享块 = 两篇的**正文**里有一大段一模一样 → 同一篇稿子。
 *
 * ## 一个例外：尾巴长到不可能是页脚
 *
 * 同站两篇要是转载得一字不差，「共同后缀」会把正文一起吃掉，剥完什么都不剩。所以共同边
 * 占到较短那篇一半以上时，直接认它是正文（见 `EDGE_IS_CONTENT_RATIO`）。
 *
 * ## 什么时候会失效
 *
 * 1. **同站转载，共享的正文正好整段落在结尾，而两篇各自的独有部分又比它长**（比如各加了一段
 *    很长的编者按）：共同后缀被当成样板剥掉，剩下的头部对不上 → 这一档判不出来。它不会误并，
 *    只是**落到第 3 档（问模型）手里**——那一档看的是正文开头，不吃页脚。
 * 2. **样板不在页首页尾，而是夹在正文中间**（页中插入的「相关推荐」）：剥不掉。实测四个站都
 *    没有这一形态（搜狐那 37 字的站内链接在中间，但它离门槛差得远）。真撞上了，表现是同站
 *    误并，排错先看 `why` 里那条 `text-identity` 的字数。
 * 3. **跨站一律不剥**：两个不同站的共同后缀不是样板，是内容——剥它就是把证据剥掉。
 */
export function sharedStoryRun(ta: string, tb: string, sameHost: boolean): number {
  if (!sameHost) return longestSharedRun(ta, tb)
  const head = commonPrefixLen(ta, tb)
  const tail = commonSuffixLen(ta, tb)
  const na = normalizeForFingerprint(ta)
  const nb = normalizeForFingerprint(tb)
  const shortest = Math.min(na.length, nb.length)
  // 共同边比正文还长 → 它不是页脚，是「两篇根本就是同一篇」。
  if (Math.max(head, tail) > shortest * EDGE_IS_CONTENT_RATIO) return Math.max(head, tail)
  // 页眉页尾一起剥；两截加起来盖满了短的那篇时，上面那一条已经把它接走了。
  return longestSharedRun(na.slice(head, na.length - tail), nb.slice(head, nb.length - tail))
}

/** 定宽并发池。抓正文是网络活，放开了打既慢又容易被上游限速。 */
async function pooled<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let next = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= jobs.length) return
      out[i] = await jobs[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, jobs.length)) }, run))
  return out
}

/**
 * 一条 URL 的归一化正文。**空串 = 判不了**，和「不像」不是一回事：前者该保持原样，
 * 后者是结论。失败在这里就地吞掉——抓正文是锦上添花，它挂了只该让这一对保持原样。
 */
async function textOf(url: string, key: string, deps: TextFoldDeps, timeoutMs: number): Promise<string> {
  const cache = deps.cache ?? sharedCache
  const hit = cache.get(key)
  if (hit !== undefined) return hit ?? ''

  let reason = ''
  const got = await withDeadline(
    deps.readUrl(url).catch((e) => {
      reason = e instanceof Error ? e.message : String(e)
      return null
    }),
    timeoutMs,
    () => {
      reason = `${timeoutMs}ms 内没回来`
    },
  )
  const raw = typeof got?.text === 'string' ? got.text : ''
  if (!raw) {
    deps.onFetchFailure?.(url, reason || '没有正文')
    cache.set(key, null)
    return ''
  }
  // 字数按归一化后算——一屏拦截页里空白和标点占的比例很高，按原串数会高估。
  const text = normalizeForFingerprint(raw).slice(0, MAX_TEXT_CHARS)
  if (text.length < MIN_TEXT_CHARS) {
    deps.onFetchFailure?.(url, `正文只有 ${text.length} 字，判不了（多半是拦截页/登录墙）`)
    cache.set(key, null)
    return ''
  }
  cache.set(key, text)
  return text
}

/**
 * 在**已经折过一轮**的堆之间再比一次正文，把标题不像的同源合进去。
 *
 * 只比**堆代表**：同一堆里的其它成员已经被判成同一条了，再为它们各抓一次正文是重复付钱。
 * 抓取次数因此是 O(堆数) 而不是 O(对数)——比对是免费的，抓取才是成本，闸门也就该按 URL 收敛。
 *
 * 合并方向永远是**靠前的吃掉靠后的**（输入序 = 相关性序），和 `fold` 选代表的口径一致。
 */
export async function foldGroupsByText<T extends Foldable>(
  groups: Array<FoldGroup<T>>,
  settings: TextFoldSettings,
  deps: TextFoldDeps,
  /**
   * 抓到的正文往这里也放一份（键 = 归一化 URL）。**第 3 档（语义）靠它才做到零抓取**：
   * 它判的正是这一档判不动的那些堆，用的是同一批正文，再抓一遍就是为同一份内容付两次钱。
   */
  collect?: Map<string, string>,
): Promise<Array<FoldGroup<T>>> {
  if (groups.length < 2) return groups

  // ① 先算出哪些对子够格花钱——**没有任何一对够格的堆，一次都不抓**。
  const pairs: Array<[number, number]> = []
  const needed = new Set<number>()
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (!worthFetchingText(groups[i].rep, groups[j].rep)) continue
      pairs.push([i, j])
      needed.add(i)
      needed.add(j)
    }
  }
  if (pairs.length === 0) return groups

  // ② 抓取上限按**输入序**取前 N 个（相关性序：排前面的更值得花钱），超出的那些这一轮
  //    就当没正文——它们仍会照原样出现在结果里，只是没被补判。
  const fetchable = [...needed].sort((x, y) => x - y).slice(0, settings.maxFetches)
  const allowed = new Set(fetchable)
  const texts = new Map<number, string>()
  await pooled(
    fetchable.map((idx) => async () => {
      const url = groups[idx].rep.url ?? ''
      const key = urlKey(url)
      const text = await textOf(url, key, deps, settings.timeoutMs)
      texts.set(idx, text)
      if (text && collect) collect.set(key, text)
    }),
    settings.concurrency,
  )

  // ③ 比正文并堆。并查集式：i 已经被并进别人，就把 j 挂到那个最终的堆上。
  const absorbedBy = new Map<number, number>()
  const rootOf = (i: number): number => {
    let r = i
    while (absorbedBy.has(r)) r = absorbedBy.get(r)!
    return r
  }
  for (const [i, j] of pairs) {
    if (!allowed.has(i) || !allowed.has(j)) continue
    if (absorbedBy.has(j)) continue
    const ta = texts.get(i) ?? ''
    const tb = texts.get(j) ?? ''
    // **空串 = 判不了**（没抓到 / 正文太短）。它绝不该被当成「共享 0 字」去和门槛比——
    // 那两件事对下一步的处置完全一样（都不并），但对排错完全不一样，所以在这里就分开。
    if (!ta || !tb) continue
    const shared = sharedStoryRun(ta, tb, hostOf(groups[i].rep.url) === hostOf(groups[j].rep.url))
    if (shared < settings.minSharedChars) continue
    const root = rootOf(i)
    if (root === j) continue
    absorbedBy.set(j, root)
    const target = groups[root]
    const eaten = groups[j]
    target.members.push(eaten.rep, ...eaten.members)
    target.why.push({
      kind: 'text-identity',
      // score 是**描述性**的（共享块占较短那篇的比例），判据是上面那个字数门槛。
      score: shared / Math.min(ta.length, tb.length),
      detail: `正文里有连续 ${shared} 字一模一样，标题不同：${eaten.rep.title}`,
    })
  }

  return groups.filter((_, i) => !absorbedBy.has(i))
}

/**
 * 第 2 档到底可不可用——**可用才把第 1 档的同站标题证据降级**
 * （`FoldProfile.sameHostTitleNeedsText`，判据在 `fold.ts` 的 `titleNeedsTextConfirm`）。
 *
 * 这一步不能省成「场景档里写死一个 true」：第 2 档缺席（没配 `profile.text`、或调用方
 * 没接抓取器 `TextFoldDeps`）时降级是**净损失**——同站的标题相同转载再也没人确认，
 * 于是再也合不了，比今天更差。**只有确实有人接得住这个「疑似」，才敢把它降级。**
 */
export function withSameHostTextConfirm(profile: FoldProfile, deps?: TextFoldDeps): FoldProfile {
  if (!profile.text || !deps) return profile
  return { ...profile, sameHostTitleNeedsText: true }
}

/**
 * 档 A 的完整折叠：**一级比一级贵，前一级判不出来才轮到后一级**。
 *
 * 1. `fold` —— 链接同一性 + 标题 Dice。本地，零请求。
 * 2. `foldGroupsByText` —— 抓正文比最长共享块。治「标题被改写过的转载」。
 * 3. `foldGroupsBySemantics` —— 问模型。治「同一篇通稿被 AI 重写过」，第 2 档的字数门槛
 *    在这类稿子上和「各写各的」挨得太近，分不开（数字见 `semantic-fold.ts` 头注）。
 *
 * 每一档的依赖缺席就自动少一档，**行为退回上一档、一字不变**：`profile.text` / `readUrl` 缺席
 * 就只比链接和标题；`profile.semantic` / `semantic` deps 缺席就只到第 2 档。
 */
export async function foldWithText<T extends Foldable>(
  items: T[],
  profile: FoldProfile,
  deps?: TextFoldDeps,
  semantic?: SemanticFoldDeps,
): Promise<Array<FoldGroup<T>>> {
  const groups = fold(items, withSameHostTextConfirm(profile, deps))
  if (!profile.text || !deps) return groups
  // 第 2 档抓到的正文留一份给第 3 档——**第 3 档一个请求都不发**，全靠这张表。
  const texts = new Map<string, string>()
  const afterText = await foldGroupsByText(groups, profile.text, deps, texts)
  if (!profile.semantic || !semantic) return afterText
  return foldGroupsBySemantics(afterText, profile.semantic, semantic, textLookup(texts))
}
