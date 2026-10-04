/**
 * 档 A 的**第三道判据：问模型「这几篇是不是同一篇稿子」**。
 *
 * 注意它问的**不是**「是不是在讲同一件事」。三档判的始终是同一个问题——**这是不是同一份内容**：
 * 第 1 档看链接，第 2 档看字面，第 3 档看意思。**「两家各自采写同一件事」不在这条线上**：那是
 * 两篇不同的稿子，各有各的采访和角度，读者两篇都该看得见。把它们并掉是漏信息，不是去重
 * （设计里那一格叫「C. 不同人写同一件事」，是另一档的事，不是这一档放宽阈值就能顺手做掉的）。
 *
 * ## 为什么必须换一种判法，而不是把第 2 档的门槛调低
 *
 * 第 2 档（`./text-fold.ts`）判的是「最长连续共享块」，它抓的是**文字层面的同一份稿子**。活体实测
 * 一条通稿：新浪原样转发，和源站共享 **246 字**；搜狐让 AI 重写了一遍，共享块只剩 **17 字**；而
 * 「两家各自独立报道同一件事」是 **6–11 字**。17 和 11 挨在一起——**这条线上没有能下刀的地方**，
 * 调门槛只能在「漏掉改写稿」和「把不相干的两篇并掉」之间挑一个。改写稿共享的不是字，是**意思**，
 * 所以判据也只能换成意思。
 *
 * ## 三条设计约束（每一条都在挡一类真实的坏结果）
 *
 * 1. **不自己抓正文，只吃第 2 档已经抓到的那份。** 抓取是这条链路上唯一贵的动作，第 2 档已经为
 *    这批堆代表付过一次了（缓存按归一化 URL）。第 3 档因此**不增加任何网络抓取**，它的全部成本是
 *    一次模型调用。没有正文的堆直接不参与——「判不了」不是「不像」。
 * 2. **一次搜索最多一发模型调用**，把够格的几篇一起递上去让它分组，不是每对问一次。前两档已经把
 *    绝大多数对子筛掉，活到这里的通常是 3–8 篇；逐对问是 O(n²) 发调用换同一个答案。
 * 3. **模型的答案要过硬否决**：序列身份（第 3 集 vs 第 4 集）这道闸门在**问之前和拿到答案
 *    之后各跑一次**。同一档节目两集的正文语义高度相似，模型必然认为它们「在讲同一件事」——
 *    没有这道否决，这一档必然误合，而误合的代价是用户要找的那一集被藏起来了。
 *
 * 判不了的一切形态（没配 LLM、超时、返回不可解析、正文没抓到）**一律保持原样**：那一对不并，
 * 搜索结果照常返回，绝不变成 error（同 `web-search-ladder.ts` 头注那条硬规矩）。
 */

import type { ChatMessage } from '../llm/client.ts'
import { extractJson } from '../llm/extract-json.ts'
import { FENCE_CLOSE, FENCE_NOTE, FENCE_OPEN, stripFence } from '../llm/fence.ts'
import { hostOf, serialConflict, urlKey, type FoldGroup, type Foldable } from './fold.ts'
import type { SemanticFoldSettings } from './profiles.ts'
import { withDeadline } from './deadline.ts'

export interface SemanticFoldDeps {
  /**
   * 把一组 messages 递给模型，拿回它说的话。**约定它永不抛**：拿不到就回 `null`
   * （生产接的是 `llmContentQuiet`，未配置 / 全 decline / 调用抛错都已经被它吞成 null）。
   */
  ask: (messages: ChatMessage[]) => Promise<string | null>
  /** 判不了记一笔。**软回落不该是无声的**（同梯子里 `onPrimaryFailure` 那条）。 */
  onJudgeFailure?: (reason: string) => void
}

/** 模型要回的形状。`members` 是**候选清单里的编号**，不是 hit 在搜索结果里的位置。 */
interface JudgeReply {
  groups?: Array<{ members?: unknown; confidence?: unknown; why?: unknown }>
}

/**
 * 这一对够不够格进候选清单。**和第 2 档同一道闸门**（`worthFetchingText`），口径也一样：
 * **同站照判**（百家号/搜狐号/网易号是「一个域名、无数个发布者」，转载最密的地方就在站内），
 * 只有序列身份冲突是硬否决——同一档节目的两集正文语义高度相似，模型没有条件分辨。
 *
 * 同站样板不会污染这一档：递给模型的是正文**开头** `charsPerArticle` 字，而样板实测都在页尾
 * （表在 `text-fold.ts` 的 `sharedStoryRun`）。
 *
 * 这里不复用那个函数名是因为它的名字讲的是「值不值得抓」，而这一档一个字都不抓；判据同源，
 * 所以两处都指向 `fold.ts` 的 `hostOf` / `serialConflict` 这两把尺，没有第二份实现。
 */
export function judgeable(a: Foldable, b: Foldable): boolean {
  if (hostOf(a.url) === '' || hostOf(b.url) === '') return false
  return !serialConflict(a.title, b.title)
}

/** 递给模型的那份候选清单：编号 + 标题 + 站点 + 正文开头。正文进围栏，站点让它自己判得出来源关系。 */
export function buildJudgeMessages(
  articles: Array<{ title: string; host: string; text: string }>,
  minConfidence: number,
): ChatMessage[] {
  const list = articles
    .map(
      (a, i) =>
        `【${i}】标题：${stripFence(a.title)}\n来源站点：${a.host}\n正文开头：\n${FENCE_OPEN}\n${stripFence(a.text)}\n${FENCE_CLOSE}`,
    )
    .join('\n\n')
  return [
    {
      role: 'system',
      content:
        '你在判断几篇网页文章里，**哪几篇其实是同一篇稿子**——一篇是另一篇的转载或改写（同一份原稿/通稿，' +
        '被换了标题、换了措辞、甚至整篇让 AI 重写过一遍）。\n\n' +
        '**这不是在问「是不是同一件事」。** 同一个新闻事件常常有很多家各自采写，那是很多篇不同的稿子，' +
        '不算同一篇。判据只有一条：\n' +
        '**把其中一篇删掉，读者会不会丢失任何信息？** 一点都不会丢 → 同一篇稿子；会丢（哪怕只丢一句独有的' +
        '采访、一个独有的数据、一段独有的分析或行情评论）→ **不是**同一篇稿子。\n\n' +
        '所以先逐篇找出「这篇独有、别篇没有的东西」，再据此分组。下面这些**一律不算**同一篇稿子：\n' +
        '- 各家各自采写同一件事（各有各的采访、引语、角度、独有细节）；\n' +
        '- 报道 + 在它之上加了行情/券商观点/背景分析的稿子；\n' +
        '- 事后的评论、综述、长篇复盘；\n' +
        '- 同一话题的不同事件、同一主体的不同新闻、同一档节目的不同期。\n\n' +
        '宁可漏，不可错：**拿不准就不要分到一组。** 一次里通常只有 0～1 组真正的同一篇稿子，' +
        '不要把所有相关的文章都连成一大组。\n' +
        '只输出 JSON，不要任何别的字：\n' +
        '{"groups":[{"members":[编号,编号],"confidence":0到1,"why":"不超过20字：是同一篇什么稿子"}]}\n' +
        `没有任何一组算同一篇稿子就输出 {"groups":[]}。confidence 低于 ${minConfidence} 的组不要输出。不要解释。`,
    },
    { role: 'user', content: `候选文章：\n\n${list}\n\n${FENCE_NOTE}` },
  ]
}

/** 解析模型的回话 → 一组组编号。任何不认识的形状都被丢掉（**永不抛**，丢掉 = 那几条不并）。 */
export function parseJudgeReply(
  raw: string | null,
  count: number,
  minConfidence: number,
): Array<{ members: number[]; why: string }> {
  const parsed = extractJson<JudgeReply>(raw)
  const out: Array<{ members: number[]; why: string }> = []
  for (const g of parsed?.groups ?? []) {
    const conf = typeof g.confidence === 'number' ? g.confidence : 0
    // 没给 confidence 一律当 0 —— **缺一个数不是「很有把握」**，宁可这一组不并。
    if (conf < minConfidence) continue
    const members = Array.isArray(g.members)
      ? [...new Set(g.members.filter((m): m is number => Number.isInteger(m) && m >= 0 && m < count))]
      : []
    if (members.length < 2) continue
    out.push({ members: members.sort((x, y) => x - y), why: typeof g.why === 'string' ? g.why : '' })
  }
  return out
}

/**
 * 在**前两档都折不动**的堆之间再问一次模型。`textFor` 给的是第 2 档抓到的正文（按归一化 URL 取），
 * 取不到的堆不参与——这一档一个网络请求都不发。
 *
 * 合并方向永远是**靠前的吃掉靠后的**（输入序 = 相关性序），和另外两档一致。
 */
export async function foldGroupsBySemantics<T extends Foldable>(
  groups: Array<FoldGroup<T>>,
  settings: SemanticFoldSettings,
  deps: SemanticFoldDeps,
  textFor: (url: string | undefined) => string,
): Promise<Array<FoldGroup<T>>> {
  if (groups.length < 2) return groups

  // ① 候选：有正文的堆，按输入序（＝相关性序）取前 N 个。
  const candidates: Array<{ idx: number; text: string }> = []
  for (let i = 0; i < groups.length && candidates.length < settings.maxArticles; i++) {
    const text = textFor(groups[i].rep.url)
    if (text) candidates.push({ idx: i, text })
  }
  if (candidates.length < 2) return groups

  // ② 候选里**一对够格的都没有**（全同站 / 全是序号冲突）→ 一发都不打。
  const eligible = candidates.some((a, i) =>
    candidates.slice(i + 1).some((b) => judgeable(groups[a.idx].rep, groups[b.idx].rep)),
  )
  if (!eligible) return groups

  const articles = candidates.map(({ idx, text }) => ({
    title: groups[idx].rep.title,
    host: hostOf(groups[idx].rep.url) || '未知',
    text: text.slice(0, settings.charsPerArticle),
  }))

  const raw = await withDeadline(
    deps.ask(buildJudgeMessages(articles, settings.minConfidence)).catch((e) => {
      // ask 的约定是永不抛；真抛了也当判不了——这一档挂了绝不许影响搜索结果。
      deps.onJudgeFailure?.(e instanceof Error ? e.message : String(e))
      return null
    }),
    settings.timeoutMs,
    () => deps.onJudgeFailure?.(`${settings.timeoutMs}ms 内没回来`),
  )
  if (!raw) {
    deps.onJudgeFailure?.('模型没有回话，这一轮不做语义判定')
    return groups
  }

  const verdicts = parseJudgeReply(raw, articles.length, settings.minConfidence)
  if (verdicts.length === 0) return groups

  // ③ 落地。并查集式，和第 2 档同一套：i 已经被并进别人，就把 j 挂到最终那个堆上。
  const absorbedBy = new Map<number, number>()
  const rootOf = (i: number): number => {
    let r = i
    while (absorbedBy.has(r)) r = absorbedBy.get(r)!
    return r
  }
  for (const v of verdicts) {
    const [first, ...rest] = v.members.map((m) => candidates[m].idx)
    for (const j of rest) {
      if (absorbedBy.has(j)) continue
      const root = rootOf(first)
      if (root === j) continue
      // **模型说了也不算数**：序列身份这道硬否决在答案回来之后再跑一次。模型看的是
      // 正文开头几百字，同一档节目两集的开头几乎一样，它没有条件分辨——分辨那件事靠标题里的号。
      if (!judgeable(groups[root].rep, groups[j].rep)) continue
      absorbedBy.set(j, root)
      const target = groups[root]
      const eaten = groups[j]
      target.members.push(eaten.rep, ...eaten.members)
      target.why.push({
        kind: 'semantic',
        // score 是**模型自报的把握**，不是算出来的相似度。它天然比另外两档软一档，
        // evidence 的 kind 分开正是为了让看的人知道这条是问出来的、不是算出来的。
        score: settings.minConfidence,
        detail: `模型判定是同一篇稿子的改写${v.why ? `：${v.why}` : ''}｜${eaten.rep.title}`,
      })
    }
  }

  return groups.filter((_, i) => !absorbedBy.has(i))
}

/** 按归一化 URL 转成文字的查表函数（第 2 档抓到的那份）。没有就回空串 = 判不了。 */
export const textLookup =
  (texts: Map<string, string>) =>
  (url: string | undefined): string =>
    texts.get(urlKey(url)) ?? ''
