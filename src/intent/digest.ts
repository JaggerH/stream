// src/intent/digest.ts
import type { IntentStore } from './store.ts'
import type { IntentLlm } from './llm.ts'
import type { IntentRecord, Ledger, DigestOutcome } from './types.ts'

export interface DigestDeps {
  store: IntentStore
  llm: IntentLlm
  /** 意图名下某 stream 的现存 item（含已判过的——增量筛选靠账本，不靠调用方）。带 `limit`
   *  时调用方应照实放宽取数（生产接线是 itemStore.recent 的 limit 参数）——窗口饱和的扩窗
   *  重取靠它把窗口外的旧条目捞回来。 */
  listItems: (streamId: string, opts?: { limit?: number }) => Array<{ id: string; title?: string; author?: string; body_text?: string; link?: string }>
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
  /** 窗口饱和（整窗未判）时的扩窗上限：itemStore 里本来留着 capPerStream=5000 条，窗口只是
   *  取数页大小。模型中断期间条目会堆到窗口外，恢复后的第一轮靠扩窗把它们补回来。
   *  默认 1000。 */
  backlogLimit?: number
}

/**
 * 「模型端整体不可用」的错误特征——对**这一批所有条目**都成立的失败（全部模型用尽、限流、
 * 配额、梯子全灭、LLM 未配置）。这类错误再逐条打下去每条都是同一个下场：白白把其余条目
 * 一个个烧一遍（每条还带各自的 provider 重试），日志里还刷一行 ×N。识别到就整轮收，
 * 已判的照常入账本，其余顺延（不写账本 = 不算该条目的永久失败），退避由 service 层记账。
 * 匹配是对 message 的保守启发式；个别网关的自定义文案进不了这里也只是退回逐条重试的旧形状。
 */
function isEndpointDown(message: string): boolean {
  return /all models exhausted|too many requests|\b429\b|rate.?limit|quota|额度|配额|梯子上没有一个成员|LLM 未配置|overloaded/i.test(message)
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
  const backlogLimit = deps.backlogLimit ?? 1000
  for (const sid of liveStreams) {
    let items = deps.listItems(sid)
    let unjudged = items.filter((item) => !(item.id in ledger))
    if (deps.windowSize && items.length === deps.windowSize && unjudged.length === items.length) {
      // 窗口整窗都是未判条目 = 有堆积。窗口只是 listItems 的**取数页大小**，不是删除——
      // itemStore 每个流留着 capPerStream=5000 条，窗口外更旧的还在库里。扩一页把它们
      // 捞回来：模型中断（退避期）堆下的账，恢复后的第一轮就要能补判，否则旧条目永远
      // 挤不进 200 的窗口。两种情况才算真·饱和：扩窗一无所获（调用方没吃 limit，或库
      // 里就这一窗）、或扩窗页取满仍整段未判（页外可能还有）。
      const wider = deps.listItems(sid, { limit: backlogLimit })
      const widerUnjudged = wider.filter((item) => !(item.id in ledger))
      const gainedNothing = wider.length <= items.length
      const pageFull = wider.length >= backlogLimit
      items = wider
      unjudged = widerUnjudged
      if (widerUnjudged.length === wider.length && (gainedNothing || pageFull)) {
        windowSaturated.push(sid)
        deps.log?.(`[intent] stream ${sid} 扩窗到 ${backlogLimit} 条仍全为未判条目，更旧的条目可能被永久漏判`)
      }
    }
    fresh.push(...unjudged)
  }

  const maxJudged = deps.maxJudged ?? 100
  const toJudge = fresh.slice(0, maxJudged)

  const newEntries: Ledger = {}
  const relevantEntries: Array<{ title: string; summary: string; link?: string }> = []
  let errors = 0
  let attempted = 0
  let endpointDown: { message: string; unjudgedLeft: number } | undefined
  for (const item of toJudge) {
    if (endpointDown) break
    const transcript = deps.transcriptTextOf?.(item.id) ?? null
    const text = [
      item.title ? `标题: ${item.title}` : '',
      item.author ? `作者: ${item.author}` : '',
      transcript ? `转写:\n${transcript}` : item.body_text ? `正文:\n${item.body_text}` : '',
    ].filter(Boolean).join('\n')
    attempted++
    try {
      const verdict = await deps.llm.judgeItem(intent.criteria, text)
      newEntries[item.id] = { relevant: verdict.relevant, ...(verdict.summary ? { summary: verdict.summary } : {}), at: Date.now() }
      if (verdict.relevant) {
        relevantEntries.push({ title: item.title ?? item.id, summary: verdict.summary ?? '（无摘要）', ...(item.link ? { link: item.link } : {}) })
      }
    } catch (e) {
      errors++
      const message = (e as Error).message
      if (isEndpointDown(message)) {
        // 整体不可用：收轮。其余条目不再逐个撞同一堵墙（活体：全部模型用尽时每轮把
        // 同一批条目逐条烧到上限，再各打一行日志）。这批条目不写账本，不算永久失败，
        // 退避到期后下一轮接着来。
        endpointDown = { message, unjudgedLeft: fresh.length - Object.keys(newEntries).length }
        continue
      }
      deps.log?.(`[intent] judge failed item=${item.id}: ${message}`)
    }
  }
  if (endpointDown) {
    const brief = endpointDown.message.split('\n')[0].slice(0, 200)
    deps.log?.(
      `[intent] judge 暂停：模型端整体不可用（${brief}）——本轮 ${attempted - errors} 条成功 / ${errors} 条失败，`
      + `剩余 ${endpointDown.unjudgedLeft} 条顺延（不记永久失败），按退避等恢复`,
    )
  }

  // 整体收轮时 remaining 必须如实反映"还有账本外条目"——否则 lastDigestAt 被推进，恢复后要等
  // 一整个 cadence 才轮到这批顺延的条目。正常轮保持原语义（fresh − 本轮判过的）。
  const remaining = endpointDown
    ? endpointDown.unjudgedLeft
    : fresh.length - toJudge.length

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
  // judged = 实际打了模型的条数（整体收轮时小于 toJudge），service 的退避记账按它算。
  return { judged: attempted, relevantNew: relevantEntries.length, errors, remaining, windowSaturated }
}
