// src/agent/search/joints.ts
import type { ChatMessage, ChatResult } from '../../llm/client.ts'
import { extractJson } from '../../llm/extract-json.ts'
import { shareLinkKindOf } from '../../../shared/netdisk/share-link.ts'
import type { Classified, Hub, NetdiskHit, WebHit } from './types.ts'
import type { DomainFraming } from './domain.ts'

// `extractJson` 从这里搬去了 `src/llm/extract-json.ts`（零改动），因为档 A 的语义折叠也要它。
// 仍然从本模块导出：joints 的测试和调用方按老名字用它，搬家不该让它们跟着改。
export { extractJson }

export type ChatFn = (messages: ChatMessage[]) => Promise<ChatResult>

/** Netdisk kind from a url; '' when it is not a recognized netdisk share link.
 *  文法只有一份（shared/netdisk/share-link.ts，按主机判）。 */
export function netdiskOf(url: string): string {
  return shareLinkKindOf(url) ?? ''
}

/** Coarse hub kind from a url: telegram (t.me/tgstat) / community (forums + known netdisk-resource
 *  hubs, which tend to expose links in static HTML) / site (everything else). Kind drives both
 *  display and fetch priority (§6 step 3: telegram + community first). */
export function hubKindOf(url: string): string {
  if (/t\.me|tgstat\.com|telegram/i.test(url)) return 'telegram'
  if (
    /(linux\.do|douban\.com|zhihu\.com|v2ex\.com|nga\.cn|reddit\.com|tieba\.baidu)/i.test(url) ||
    /(fuliba\w*\.net|mimiziyuan\.com|thopan\.com|panjdzy\.com|vipc6\.com|ndflb\.com|jizhihezi\.com)/i.test(url)
  )
    return 'community'
  return 'site'
}

/** LLM joint — 分类命中 + 抽词 (spec §6 step 2). Classify each web hit into
 *  netdisk / hub / noise, and surface new category vocabulary noticed in the titles/snippets.
 *  netdisk kind + hub kind are decided by url (deterministic); the LLM only decides the class and
 *  extracts vocab. Parse failure → everything is noise, empty vocab (fail-safe, never throw). */
export async function classifyHits(
  goal: string,
  hits: WebHit[],
  chat: ChatFn,
  framing: DomainFraming
): Promise<Classified> {
  if (hits.length === 0) return { directLinks: [], hubs: [], vocab: [] }
  const list = hits
    .map((h, i) => `${i}. ${h.title} | ${h.url} | ${(h.snippet ?? '').slice(0, 120)}`)
    .join('\n')
  // 「货」那一档只在本域真有的时候才出现在提示里——写死它，商品档就会被逼着把排行榜
  // 硬塞进一个不存在的类。kind 的枚举也跟着变，别让模型选一个我们不认的值。
  const kinds = framing.directLooksLike ? 'direct|hub|noise' : 'hub|noise'
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `你在给"${framing.mission}"的搜索结果分类。为每条判 kind：\n` +
        (framing.directLooksLike ? `- "direct"：${framing.directLooksLike}\n` : '') +
        `- "hub"：聚集地——${framing.hubLooksLike}\n` +
        '- "noise"：与上面两类都不沾边的页（工具站、广告、无关内容）。\n' +
        '另外，从标题/摘要里挑出对"继续找这类东西"有用的新词（品类词、站牌、限定词），放进 vocab。\n' +
        `只输出 JSON：{"items":[{"i":编号,"kind":"${kinds}"}],"vocab":["..."]}，不要解释。`,
    },
    { role: 'user', content: `目标：${goal}\n\n命中：\n${list}` },
  ]
  const res = await chat(messages)
  const parsed = extractJson<{ items?: { i: number; kind: string }[]; vocab?: string[] }>(res.content)
  const kindOf = new Map((parsed?.items ?? []).map((it) => [it.i, it.kind]))
  const directLinks: NetdiskHit[] = []
  const hubs: Hub[] = []
  hits.forEach((h, i) => {
    const kind = kindOf.get(i) ?? 'noise'
    const nd = netdiskOf(h.url)
    // Trust the url over the label: a real netdisk url is a direct link even if the model said hub.
    if (nd) directLinks.push({ title: h.title, link: h.url, netdisk: nd, sourceId: 'web-search', snippet: h.snippet })
    else if (kind === 'hub') hubs.push({ url: h.url, title: h.title, kind: hubKindOf(h.url) })
  })
  const vocab = (parsed?.vocab ?? []).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
  return { directLinks, hubs, vocab }
}

/** LLM joint — 出这轮搜索词 (spec §4/§6 step 1/5). Two axes:
 *  A 名字直取（资源名 × 获取意图词），B 品类找窝（扔掉名字，按品类特征找聚集地）。
 *  `learned` = category vocab accreted from prior rounds; `seeds` = the starting intent hint.
 *  Excludes anything in `tried`. Parse failure → [] (caller stops expanding). */
export async function proposeQueries(
  goal: string,
  tried: string[],
  learned: string[],
  seeds: readonly string[],
  chat: ChatFn,
  framing: DomainFraming
): Promise<string[]> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `你在为"${framing.mission}"生成网页搜索词。出两类，共 4-6 条：\n` +
        '- A 目标直取：拿目标本身（含繁简/空格/别名变体）去搜，直接命中。\n' +
        `- B 品类找窝：**扔掉目标本身的名字**，${framing.categoryAxisHint}` +
        '目的是找出囤着这一类东西的页面，而不是直接命中。\n' +
        '只输出 JSON 字符串数组，不要解释。',
    },
    {
      role: 'user',
      content:
        `目标：${goal}\n品类/限定词（起手 + 已学到）：${[...seeds, ...learned].join('、')}\n` +
        `已搜过（别重复）：${tried.join('、') || '（无）'}`,
    },
  ]
  const res = await chat(messages)
  const parsed = extractJson<unknown[]>(res.content) ?? []
  return parsed
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim())
    .filter((x) => !tried.includes(x))
}
