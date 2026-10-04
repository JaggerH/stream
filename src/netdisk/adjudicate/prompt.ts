// 裁决器给模型的固定 system 提示 + 消息构造 + 结论解析（spec 2026-09-03-netdisk-llm-adjudicator §4）。
// 判据从 `.claude/skills/netdisk-library/references/archive.md` §2/§5 抽，写死成常量：
// 不动态读 skill 文件——那份是给人和 agent 的，这里是给一次结构化调用的（spec §4.1 头注）。
import type { Card } from './cards.ts'

export const ADJUDICATE_SYSTEM_PROMPT = `你在给网盘归档器裁一批"机器判不了、但读一眼证据就能定"的卡片。
每张卡问的是同一类问题：这份网盘文件是不是清单里某一集（或者都不是）。判据：

- 期号体系：文件名里的"第N期"与候选标题的"第M期"都在场却不相等 → 不是那一集。
- 纯享、加更、花絮、彩蛋这类衍生内容不是正片集，除非清单本身也把它当一集列出来。
- 一期多集（如"第3期上/下"）按文件名的分段编号区分，别把上下两集当成同一集的两份。
- 时长精确相等（容差 1 秒内）是同一集的另一版最强的证据；时长差得远基本可以排除是同一集；
  离谱到超过 12 小时的时长本身就是探测失败，别拿它当证据。
- 候选里带 existing（这一集已经有一份在货架上）时，判断这份新文件是"同一集的另一版"还是
  "压根不是这一集"，别默认"已经有了就不用管"。

只能从每张卡自带的 candidates 里挑一个 leftKey 作答，或者答 none（都不是）；不许凭空指一个
candidates 里没有的 leftKey。拿不准就答 unsure、confidence 填 low——你的结论会先过一道代码闸，
拿不准写"是"反而会被拒收留在原地，不会造成任何损失，胡乱写"是"才会。只输出 JSON，不要任何
解释性文字包在外面：

{"decisions":[{"id":"<卡的 id>","verdict":"is-episode"|"not-episode"|"unsure","leftKey"?:"<candidates 里的一个>","confidence":"high"|"low","reason":"<一句人话>"}]}`

/** 一条模型结论（spec §4.2）。`unsure` 时不带 `leftKey`。 */
export interface Decision {
  id: string
  verdict: 'is-episode' | 'not-episode' | 'unsure'
  leftKey?: string
  confidence: 'high' | 'low'
  reason: string
}

export interface AdjudicateMessage { role: 'system' | 'user'; content: string }

/** 造给模型的消息：一条 system + 一条 user（卡片数组的 JSON，字段只挑 spec §4.1 列出的那几个——
 *  `Card.dirSeason` / `CardCandidate.season` 是 gate 用的内部字段，不进这份 JSON）。 */
export function buildMessages(cards: readonly Card[]): AdjudicateMessage[] {
  const payload = {
    cards: cards.map((c) => ({
      id: c.id,
      kind: c.kind,
      file: c.file,
      candidates: c.candidates.map((x) => ({
        leftKey: x.leftKey,
        title: x.title,
        ...(x.airDate !== undefined ? { airDate: x.airDate } : {}),
        ...(x.authorityDurationS !== undefined ? { authorityDurationS: x.authorityDurationS } : {}),
        ...(x.existing !== undefined ? { existing: x.existing } : {}),
      })),
      reason: c.reason,
    })),
  }
  return [
    { role: 'system', content: ADJUDICATE_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ]
}

const VERDICTS = new Set(['is-episode', 'not-episode', 'unsure'])
const CONFIDENCES = new Set(['high', 'low'])

/**
 * 模型回执 → 结论数组。**只认 JSON**：解析不出、顶层不是对象、`decisions` 不是数组、任意一条
 * 形状不对或字段类型错 → 整批返回 `null`（spec §4.2「解析不出 → 整批作废，不猜」）。
 * 未知 `id`（不在这次发出去的卡里）**不在这里过滤**——那要对照卡集合才判得出，留给 gate/service。
 */
export function parseDecisions(content: string): Decision[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const decisions = (parsed as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions)) return null

  const out: Decision[] = []
  for (const raw of decisions) {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string') return null
    if (typeof r.verdict !== 'string' || !VERDICTS.has(r.verdict)) return null
    if (typeof r.confidence !== 'string' || !CONFIDENCES.has(r.confidence)) return null
    if (typeof r.reason !== 'string') return null
    if (r.leftKey !== undefined && typeof r.leftKey !== 'string') return null
    out.push({
      id: r.id,
      verdict: r.verdict as Decision['verdict'],
      confidence: r.confidence as Decision['confidence'],
      reason: r.reason,
      ...(typeof r.leftKey === 'string' ? { leftKey: r.leftKey } : {}),
    })
  }
  return out
}
