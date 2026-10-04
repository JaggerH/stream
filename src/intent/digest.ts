// src/intent/digest.ts
import type { IntentStore } from './store.ts'
import type { IntentLlm } from './llm.ts'
import type { IntentRecord, Ledger, DigestOutcome } from './types.ts'

export interface DigestDeps {
  store: IntentStore
  llm: IntentLlm
  /** 意图名下某 stream 的现存 item（含已判过的——增量筛选靠账本，不靠调用方） */
  listItems: (streamId: string) => Array<{ id: string; title?: string; author?: string; body_text?: string; link?: string }>
  /** 音视频优先取已有转写；没有就回 null（不主动触发转写，spec §3） */
  transcriptTextOf?: (itemId: string) => string | null
  events?: { append: (e: { type: string; title: string; body?: string; severity: 'info' | 'warn' | 'error'; dedupeKey?: string }) => unknown }
  log?: (msg: string) => void
  streamExists: (streamId: string) => boolean
  /** 一轮最多串行判几条 LLM 调用；超出留给下轮（账本天然断点）。默认 100。 */
  maxJudged?: number
  /** listItems 每个 stream 的窗口大小（调用方约定，如 bootstrap 传 200）；用于判"窗口是否已
   *  饱和"——不传则不做饱和检测。 */
  windowSize?: number
}

/** 一轮消化：账本外的新 item → LLM 判相关+摘要 → 相关条目合并进档案 → 写账本 → 发事件。
 *  单条判定失败跳过不入账本（下轮重试）；mergeDossier 抛出则本轮账本一条不写、lastDigestAt 不
 *  更新，整轮 rethrow（下轮全量重判，零丢失）——整轮 LLM 不可用同理由调用方（service）兜。
 *  remaining > 0（本轮被 maxJudged 截断，还有账本外条目没轮到）时同样不推进 lastDigestAt——
 *  否则要等一整个 cadence（默认 24h）scanDue 才会再来，日产量超过 maxJudged 的意图会越攒越多、
 *  旧条目还可能被 200 窗口挤出去永久漏判；不推进就让下一次 scanDue（每小时）立即接着排。 */
export async function runDigestRound(intent: IntentRecord, deps: DigestDeps): Promise<DigestOutcome> {
  // 重读最新记录（phase2 spec §1 联动修复）：调用方传入的可能是入队时的旧快照，
  // 拿旧 streamIds 会漏掉排队期间招源新落的订阅、还会把它们从记录里清掉。
  const live = deps.store.get(intent.id)
  if (!live) return { judged: 0, relevantNew: 0, errors: 0, remaining: 0, windowSaturated: [] }
  intent = live
  const ledger = deps.store.ledger(intent.id)
  const liveStreams = intent.streamIds.filter((sid) => deps.streamExists(sid))
  if (liveStreams.length !== intent.streamIds.length) {
    deps.store.put(intent.id, { streamIds: liveStreams })
  }

  const fresh: Array<{ id: string; title?: string; author?: string; body_text?: string; link?: string }> = []
  const windowSaturated: string[] = []
  for (const sid of liveStreams) {
    const items = deps.listItems(sid)
    const unjudged = items.filter((item) => !(item.id in ledger))
    if (deps.windowSize && items.length === deps.windowSize && unjudged.length === items.length) {
      // 窗口整窗都是未判条目：窗口外极可能还有更旧的、永远够不着的条目——它们已经被
      // listItems 的 limit 挡在外面，且不会再进来（新条目会先把它们挤出窗口）。
      windowSaturated.push(sid)
      deps.log?.(`[intent] stream ${sid} 消化窗口(${deps.windowSize})已满且全为未判条目，窗口外更旧的条目可能被永久漏判`)
    }
    fresh.push(...unjudged)
  }

  const maxJudged = deps.maxJudged ?? 100
  const toJudge = fresh.slice(0, maxJudged)
  const remaining = fresh.length - toJudge.length

  const newEntries: Ledger = {}
  const relevantEntries: Array<{ title: string; summary: string; link?: string }> = []
  let errors = 0
  for (const item of toJudge) {
    const transcript = deps.transcriptTextOf?.(item.id) ?? null
    const text = [
      item.title ? `标题: ${item.title}` : '',
      item.author ? `作者: ${item.author}` : '',
      transcript ? `转写:\n${transcript}` : item.body_text ? `正文:\n${item.body_text}` : '',
    ].filter(Boolean).join('\n')
    try {
      const verdict = await deps.llm.judgeItem(intent.criteria, text)
      newEntries[item.id] = { relevant: verdict.relevant, ...(verdict.summary ? { summary: verdict.summary } : {}), at: Date.now() }
      if (verdict.relevant) {
        relevantEntries.push({ title: item.title ?? item.id, summary: verdict.summary ?? '（无摘要）', ...(item.link ? { link: item.link } : {}) })
      }
    } catch (e) {
      errors++
      deps.log?.(`[intent] judge failed item=${item.id}: ${(e as Error).message}`)
    }
  }

  // 先合并档案再写账本：mergeDossier 抛出时账本一条不写（本轮判过的相关内容不会被
  // 账本挡在下一轮增量筛选之外），代价是下轮全量重判，但零丢失。
  if (relevantEntries.length > 0) {
    const merged = await deps.llm.mergeDossier(intent.goal, deps.store.dossier(intent.id), relevantEntries)
    deps.store.writeDossier(intent.id, merged)
    if (Object.keys(newEntries).length > 0) deps.store.appendLedger(intent.id, newEntries)
    // ledger 是本轮开头读的快照，新条目在 relevantEntries 里，二者相加即合并后的相关总数
    // （账本键是 itemId，toJudge 全部来自账本外，不会重复计数）。
    const relevantTotal =
      Object.values(ledger).filter((e) => e.relevant).length + relevantEntries.length
    deps.events?.append({
      type: 'intent.digest',
      title: `「${intent.goal.slice(0, 20)}」新增 ${relevantEntries.length} 条相关（累计 ${relevantTotal}）`,
      severity: 'info',
      // dedupeKey 编入累计终态：有新增量必然换 key，不再被 dedupe 吞（phase2 spec §4）
      dedupeKey: `intent:${intent.id}:digest:${relevantTotal}`,
    })
  } else if (Object.keys(newEntries).length > 0) {
    deps.store.appendLedger(intent.id, newEntries)
  }

  if (remaining === 0) deps.store.put(intent.id, { lastDigestAt: Date.now() })
  return { judged: toJudge.length, relevantNew: relevantEntries.length, errors, remaining, windowSaturated }
}
