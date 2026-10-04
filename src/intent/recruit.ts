// src/intent/recruit.ts
import { randomUUID } from 'node:crypto'
import type { IntentStore } from './store.ts'

export interface RecruitCandidate {
  id: string
  description: string
  categories?: string[]
  params_schema?: Record<string, unknown>
  cadence_hint_seconds?: number
}

export interface RecruitStream {
  id: string
  description: string
  sources: Array<{ source_id: string; params: Record<string, unknown> }>
  cadence_seconds: number
  vault_subdir: string
}

export interface RecruitDeps {
  store: IntentStore
  // 结构等价于 Pick<IntentLlm, 'pickSources'>，但 params 放宽到 Record<string, unknown>：
  // 真实 IntentLlm.pickSources 回的是 Record<string, string | number>（更窄，协变可赋值），
  // 这里放宽纯粹是让 mock 的异构字面量数组能顺利做类型推断，recruit.ts 内部本就按
  // Record<string, unknown> 使用 pick.params。
  llm: {
    pickSources(
      goal: string,
      criteria: string,
      candidates: RecruitCandidate[],
    ): Promise<Array<{ sourceId: string; params: Record<string, unknown> }>>
  }
  search: (query: string) => RecruitCandidate[]
  preview: (sourceId: string, params: Record<string, unknown>) => Promise<{ items: unknown[] }>
  /** 已订流里有同 source+等值 params → 回它的 streamId，否则 null */
  findExisting: (sourceId: string, params: Record<string, unknown>) => string | null
  subscribe: (stream: RecruitStream, channelId: string) => void
  /** 幂等建频道（putChannel 语义） */
  ensureChannel: (id: string, label: string) => void
  events?: { append: (e: { type: string; title: string; body?: string; severity: 'info' | 'warn' | 'error'; dedupeKey?: string }) => unknown }
  log?: (msg: string) => void
}

export interface RecruitOutcome {
  subscribed: Array<{ streamId: string; sourceId: string }>
  reused: string[]
  dropped: number
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** 注册表内招源（phase2 spec §1）：搜→挑→验参→试吃→查重→订进意图频道→记→报。
 *  同步执行（秒级）；单条失败丢弃不断链。 */
export async function runRecruit(intentId: string, deps: RecruitDeps): Promise<RecruitOutcome> {
  const rec = deps.store.get(intentId)
  if (!rec) throw new Error('意图不存在')

  const candidates = deps.search(`${rec.goal}\n${rec.criteria}`).slice(0, 30)
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const picks = await deps.llm.pickSources(rec.goal, rec.criteria, candidates)

  const subscribed: Array<{ streamId: string; sourceId: string }> = []
  const reused: string[] = []
  let dropped = 0
  const channelId = rec.channelId ?? `intent-${rec.id.slice(0, 8)}`
  let channelEnsured = false

  for (const pick of picks) {
    const cand = byId.get(pick.sourceId)
    if (!cand) { dropped++; continue } // pickSources 已过滤，双保险
    // 验参：schema.required 里的字段必须有非空值——宁缺毋滥，不猜参数
    const required = Array.isArray(cand.params_schema?.required) ? (cand.params_schema.required as string[]) : []
    if (required.some((k) => pick.params[k] === undefined || pick.params[k] === '')) {
      dropped++
      deps.log?.(`[intent] recruit 丢弃 ${pick.sourceId}：required 参数缺值`)
      continue
    }
    // 查重：已订过 → 复用，挂 streamIds、不进意图频道、retire 不动它
    const existing = deps.findExisting(pick.sourceId, pick.params)
    if (existing) {
      reused.push(existing)
      continue
    }
    // 试吃闸：当场出不了货的不订
    try {
      const pv = await deps.preview(pick.sourceId, pick.params)
      if (!pv.items.length) {
        dropped++
        deps.log?.(`[intent] recruit 丢弃 ${pick.sourceId}：预览无内容`)
        continue
      }
    } catch (e) {
      dropped++
      deps.log?.(`[intent] recruit 丢弃 ${pick.sourceId}：预览失败 ${(e as Error).message}`)
      continue
    }
    // 订：首单前懒建意图频道
    try {
      if (!channelEnsured) {
        deps.ensureChannel(channelId, `意图：${rec.goal.slice(0, 20)}`)
        channelEnsured = true
      }
      const streamId = `intent-${rec.id.slice(0, 8)}-${slug(pick.sourceId) || 'source'}-${randomUUID().slice(0, 4)}`
      deps.subscribe(
        {
          id: streamId,
          description: cand.description || pick.sourceId,
          sources: [{ source_id: pick.sourceId, params: pick.params }],
          cadence_seconds: cand.cadence_hint_seconds || 172800, // 无 hint 时默认 2d 采集周期
          vault_subdir: streamId,
        },
        channelId,
      )
      subscribed.push({ streamId, sourceId: pick.sourceId })
    } catch (e) {
      dropped++
      deps.log?.(`[intent] recruit 订阅失败 ${pick.sourceId}: ${(e as Error).message}`)
    }
  }

  // 记：一次 put 收齐（streamIds 去重合并；只有真订到了才写 channelId）
  const fresh = deps.store.get(rec.id)
  if (fresh) {
    deps.store.put(rec.id, {
      streamIds: [...new Set([...fresh.streamIds, ...subscribed.map((s) => s.streamId), ...reused])],
      ...(subscribed.length
        ? {
            recruitedStreamIds: [...new Set([...(fresh.recruitedStreamIds ?? []), ...subscribed.map((s) => s.streamId)])],
            channelId,
          }
        : {}),
    })
  }

  // 报：零结果也发，讲明原因（phase2 spec §1 步骤 7）
  const total = subscribed.length + reused.length
  deps.events?.append({
    type: 'intent.recruit',
    title: total
      ? `「${rec.goal.slice(0, 20)}」招到 ${total} 个源（新订 ${subscribed.length}，复用 ${reused.length}）`
      : `「${rec.goal.slice(0, 20)}」本轮没招到源`,
    body: total
      ? subscribed.map((s) => s.sourceId).concat(reused.map((r) => `复用 ${r}`)).join('；')
      : candidates.length === 0
        ? '注册表里没有匹配的候选'
        : picks.length === 0
          ? `注册表命中的 ${candidates.length} 条候选与意图不对口，挑源放弃`
          : `${picks.length} 条候选全部被验参/试吃闸挡下`,
    severity: 'info',
    // 编入终态：光靠总数会把"这轮颗粒无收"(subscribed=0, reused=0)折叠进上一次总数相同的
    // 成功事件里(dedupe 吞掉，标题却讲的是新一轮"没招到")，必须把本轮 subscribed/reused
    // 也编进 key——总数不变但本轮结果不同，key 也要变。
    dedupeKey: `intent:${rec.id}:recruit:${(deps.store.get(rec.id)?.streamIds ?? []).length}:${subscribed.length}:${reused.length}`,
  })

  return { subscribed, reused, dropped }
}
