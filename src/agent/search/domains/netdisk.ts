// src/agent/search/domains/netdisk.ts
import type { ChatMessage, ChatResult } from '../../../llm/client.ts'
import { extractJson } from '../../../llm/extract-json.ts'
import type { DiscoveryDomain } from '../domain.ts'
import { extractNetdiskLinks, hubFetchUrl } from '../extract.ts'
import type { ChatFn } from '../joints.ts'
import type { NetdiskHit, ScoredHit } from '../types.ts'
import { verifyHits, type ParseShareLink, type VerifyShare } from '../verify.ts'

/** Default acquisition-intent seed words per the audio-resource domain (spec §4/§10: a starting
 *  hint, NOT a ceiling — the model generates + learns more). Category framing is left to the model. */
export const DEFAULT_INTENT_SEEDS = ['网盘', '夸克', '百度云', '下载', '资源', '合集', '下架'] as const

/** Fetch priority: hubs that expose links in static HTML first (telegram previews / resource
 *  communities), random sites last. */
const HUB_RANK: Record<string, number> = { telegram: 0, community: 1, site: 2 }

/**
 * 目标的名字有哪几种写法 —— 从 goal 里抠出来的、用来认「这个窝是不是**就在讲这一部**」的键。
 *
 * 只收两类高辨识度的串：书名号/引号里的（中文名），以及连着两个及以上首字母大写的拉丁词组
 * （原名）。品类词（"儿童动画"、"网盘"）**故意不收**——它们哪个窝都命中，收进来这条判据就废了。
 */
export function targetNames(goal: string): string[] {
  const names = [
    ...[...goal.matchAll(/[《「【"“]([^》」】"”]{2,40})[》」】"”]/g)].map((m) => m[1]),
    ...[...goal.matchAll(/\b([A-Z][a-zA-Z]+(?:[ ,]+[A-Z][a-zA-Z]+)+)\b/g)].map((m) => m[1]),
  ]
  return [...new Set(names.map(fold).filter((n) => n.length >= 3))]
}

/** 比对用的折叠形：去掉空白与标点、转小写。资源站标题里「Ada Twist Scientist」和目标里的
 *  「Ada Twist, Scientist」只差一个逗号，不折叠就对不上。 */
function fold(s: string): string {
  return s.toLowerCase().replace(/[\s,，.。:：'’"“”\-_—·]/g, '')
}

/**
 * 进哪个窝：**先看它像不像目标，再看它是什么站型。**
 *
 * 只按站型排是这条链路上真实栽过的地方（2026-08-10「阿达想当科学家」）：一个标题就叫
 * 《小科学家埃达 Ada Twist Scientist》1-4季全集、里面确实躺着活链的博客帖，因为 kind 是 'site'
 * 排在所有 telegram 频道后面，当时那 12 个抓取名额一个都没轮到它；被抓的那批泛泛资源站给出 50 条
 * 别的片子的链接，切题打分全判 0——**打分没错，是根本没把对的窝打开**。
 *
 * 名字命中是这里最强的信号，且完全免费：hub 标题和 goal 都已经在手上，不需要多一次 LLM。
 */
export function hubPriority(hub: { kind: string; title?: string }, names: string[]): number {
  const rank = HUB_RANK[hub.kind] ?? 9
  if (!names.length || !hub.title) return rank + 10
  const title = fold(hub.title)
  return names.some((n) => title.includes(n)) ? rank : rank + 10
}

/** LLM joint — 切题打分. One batched call scores every hit 0–3. Missing/garbage → 0 (spec §5:
 *  low scores sink to a 疑似 bucket, they are NOT dropped). Empty hits short-circuit (no call). */
export async function scoreTopicality(goal: string, hits: NetdiskHit[], chat: ChatFn): Promise<ScoredHit[]> {
  if (hits.length === 0) return []
  // A verified file list is the resource itself; a snippet is only the text that happened to sit
  // near the link in someone's post. So when we have the files, judge on those and say so —
  // "这个帖子在聊我要的东西" and "这个分享里装着我要的东西" are different claims, and only the
  // second one is the answer.
  const list = hits
    .map((h, i) => {
      const files = h.files?.length ? `｜里面装着：${h.files.slice(0, 12).join('、')}` : ''
      return `${i}. ${h.title ?? ''} ${h.snippet ?? ''}${files}`.trim()
    })
    .join('\n')
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你在判断网盘搜索结果是否切题。为每条打分：3=确定就是目标本身，2=很可能是，1=沾边但存疑，0=无关。' +
        '若某条给出了"里面装着"（这是打开分享读到的真实文件名），以它为准——它比帖子文字可靠得多。' +
        '只输出 JSON 数组，形如 [{"i":编号,"score":0到3}]，不要任何解释。',
    },
    { role: 'user', content: `目标：${goal}\n\n候选：\n${list}` },
  ]
  const res = await chat(messages)
  const parsed = extractJson<{ i: number; score: number }[]>(res.content) ?? []
  const byIndex = new Map(parsed.map((p) => [p.i, p.score]))
  return hits.map((h, i) => {
    const raw = byIndex.get(i)
    const score = typeof raw === 'number' && raw >= 0 && raw <= 3 ? Math.round(raw) : 0
    return { ...h, topicality: score }
  })
}

/** 装配网盘档需要的依赖：照 `verifyShare` 那格已有的注入形状（plan Task 1）。 */
export interface NetdiskDomainDeps {
  /** netdisk.share.verify — open each extracted link and read what's really inside. Absent =
   *  skip verification: every link is returned unchecked and scored on its snippet alone (the
   *  pre-verify behaviour). */
  verifyShare?: VerifyShare
  /** Link → (netdisk, pwd_id). Injected rather than imported so the agent keeps depending on the
   *  same parser the rest of the app uses, not a second one. */
  parseShareLink?: ParseShareLink
  /** 抓 hub 页文本的能力。Discourse 话题页是 JS 壳，parse 要补一枪 .json（见 parse 里的注释）；
   *  非 2xx 应当抛错，parse 据此回落原页——缺席时（测试/降级）直接在抓回来的文本上抽，壳页里没有链就抽到空，不报错。 */
  fetchText?: (url: string) => Promise<string>
}

/** 补抓一次改写后的 JSON 端点：抛错或回的不是 JSON → null（调用方回落原页）。 */
async function fetchJsonText(fetchText: (url: string) => Promise<string>, url: string): Promise<string | null> {
  try {
    const text = await fetchText(url)
    JSON.parse(text)
    return text
  } catch {
    return null
  }
}

/**
 * 网盘档 domain：把现状原样打包（plan Task 1——纯重构，行为零变化）。
 * - `parse` = `hubFetchUrl`（URL 改写并进这一格）+ `extractNetdiskLinks`（吃 #1 #2）。
 * - `check` = `verifyHits`（先便宜地开链验活，吃 #3）+ `scoreTopicality`（再花钱打分，吃 #10）。
 * - `habitat` = `DEFAULT_INTENT_SEEDS`（吃 #6）。
 * - `hubAffinity` = `hubPriority`（站型 + 专名命中，吃 #7 #8）。
 * - `identityOf` = link：两条抽到的是不是同一个分享。
 */
export function netdiskDomain(deps: NetdiskDomainDeps = {}): DiscoveryDomain<NetdiskHit> {
  const { verifyShare, parseShareLink, fetchText } = deps
  return {
    name: 'netdisk',
    parse: async (pageText: string, hubUrl: string): Promise<NetdiskHit[]> => {
      // Discourse 话题页是 JS 壳——正文在 .json 端点（见 hubFetchUrl，按 URL 形状判、不认主机）。
      // flow 只抓 hub.url（raw），URL 改写是这一格的职责：抓到壳就补一枪 .json 再抽。补抓失败
      // （抛——非 2xx / 网络——或回的不是 JSON：路径长得像 Discourse 的别家站）→ 回落原页文本，
      // 改写只是一次尝试，不许把一个本来抽得到链的页面变成空。没配 fetchText 时直接在抓回来的文本上抽。
      const target = hubFetchUrl(hubUrl)
      const text = target === hubUrl || !fetchText ? pageText : ((await fetchJsonText(fetchText, target)) ?? pageText)
      return extractNetdiskLinks(text, hubUrl)
    },
    check: async (goal: string, candidates: NetdiskHit[], chat: ChatFn) => {
      // 内部分两段（spec §2.1：这是成本优化不是概念区别，对外只有一格）——先便宜地开链验活
      // 把死的剔掉、活的带回真实文件名，再对幸存者花钱打分。**无 verify 依赖 = 压根没验**：
      // stats 全 0，flow 据此不发 verify 步骤（老行为），候选原样交给打分、按 snippet 判。
      let working = candidates
      let alive = 0
      let dead = 0
      let unchecked = 0
      if (verifyShare && parseShareLink && candidates.length) {
        const v = await verifyHits(candidates, { verifyShare, parseShareLink })
        working = v.hits
        alive = v.alive
        dead = v.dead
        unchecked = v.unchecked
      }
      const scored = await scoreTopicality(goal, working, chat)
      const kept = scored.map((h) => ({ ...h, fit: h.topicality }))
      return { kept, stats: { alive, dead, unchecked } }
    },
    habitat: DEFAULT_INTENT_SEEDS,
    // 关节口径：这三句就是泛化之前硬写在 joints.ts 里的那套话，原样搬过来（行为不变）。
    framing: {
      mission: '找下架/私有资源',
      categoryAxisHint: '用品类特征 × 获取词（如「付费播客 网盘」「有声 资源 合集」），',
      hubLooksLike: 'TG 频道、社区帖、资源站/剧集站/福利号，里面可能囤着目标或同类资源',
      directLooksLike: '这条本身就是一个网盘分享链（夸克/百度/阿里等）',
    },
    identityOf: (t) => t.link,
    // 出处 = 这条链来自的那个窝（`extract.ts` 在抽的时候就打好了标）。**不是 link**——
    // onboardable 问的是「哪个站值得接进来」，答一条网盘分享链是答非所问。
    originsOf: (t) => [t.sourceId],
    hubAffinity: (hub, goal) => hubPriority(hub, targetNames(goal)),
  }
}
