import type { Enrichment } from '../content/types.ts'
import type { Enricher } from '../packages/activate.ts'
import type { WsClient, WsHub } from './ws.ts'

interface EnrichOpenCommand {
  type: 'enrich.open'
  correlationId: string
  /** 包申报的 enricher 名（`content.enrich.source`），只在包交出的那张表里查。 */
  source: string
  params: Record<string, string>
}

export interface EnrichWsDeps {
  /** 包交出的 enricher 表。thunk：装载序上包晚于 hub，调用时现取。 */
  enrichers: () => ReadonlyMap<string, Enricher>
}

/** 一次在飞的现取，以及此刻在等它的那些人（同一份 (source, params) 的重复点击共享同一次运行）。 */
interface InFlightRun {
  key: string
  controller: AbortController
  waiters: Array<{ client: WsClient; correlationId: string }>
}

const MAX_PARAMS = 32
const MAX_PARAM_LENGTH = 2048

function parseOpen(value: unknown): EnrichOpenCommand | null {
  const v = value as Partial<EnrichOpenCommand> | null
  if (
    !v || v.type !== 'enrich.open' || typeof v.correlationId !== 'string' || !v.correlationId ||
    typeof v.source !== 'string' || !v.source || typeof v.params !== 'object' || v.params === null || Array.isArray(v.params)
  ) return null
  if (v.correlationId.length > 128 || v.source.length > 128) return null
  const entries = Object.entries(v.params)
  if (entries.length > MAX_PARAMS) return null
  for (const [k, val] of entries) {
    if (typeof val !== 'string' || k.length > 128 || val.length > MAX_PARAM_LENGTH) return null
  }
  return v as EnrichOpenCommand
}

/** 同 source 同 params 才算同一份：键序不影响。 */
function paramsKey(params: Record<string, string>): string {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]))
}

/**
 * 前端「打开一条」的 WS 协议：`enrich.open { source, params }` → 派发给包交出的 enricher，
 * 结果按 `enrich.article / comments / completed` 分片推回，全程带 correlationId。只服务包交出的
 * enricher（宿主自己那几条走 HTTP 就够，它们不占串行 lane）；查无 → `enrich.failed`，不静默回空：
 * 包没装载时的空答案会被前端读成"这条没有正文"。
 *
 * **同一 source 上，新的点击顶掉旧的（supersede），不排队。** 详情是用户此刻要看的东西，排队等于把
 * 陈旧结果排在前面。前端本来就按 correlationId 丢掉旧答案，但**丢答案不等于停任务**：靠 recipe
 * 现取的站多是单标签串行，被放弃的那次仍占着 lane 跑完（最长十几秒），用户想看的第二条只能排在
 * 它后面，同时还从这个 facility 的访问预算里扣掉一发——一次没人要的访问。所以取消必须真的传到
 * 下面去（`signal`），而被顶掉的那次一个帧都不发（它的答案没人要，一条 failed 只会制造假故障）。
 *
 * **同 source 同 params 的重复点击不取消，而是搭车**：取消再重来会白扔掉一次已经开始的访问；更要紧
 * 的是下游的请求缓存按 (source, params) 共享在飞的取数，取消自己那次会连带把别人等的那一份也弄成
 * 失败。所以同一份只加一个等待者。in-flight 按 source 分：不同站各自一条串行 lane，互不相干。
 */
export function attachEnrichCommands(hub: WsHub, deps: EnrichWsDeps): () => void {
  const inflight = new Map<string, InFlightRun>()

  return hub.onCommand((client, raw) => {
    const command = parseOpen(raw)
    if (!command) return
    const { source, correlationId } = command
    const key = paramsKey(command.params)

    const running = inflight.get(source)
    if (running?.key === key) {
      running.waiters.push({ client, correlationId })
      hub.send(client, { type: 'enrich.started', correlationId })
      return
    }
    // 换了一份参数：上一条没人要了，停掉它把 lane 让出来。
    running?.controller.abort()

    const controller = new AbortController()
    const current: InFlightRun = { key, controller, waiters: [{ client, correlationId }] }
    inflight.set(source, current)
    hub.send(client, { type: 'enrich.started', correlationId })

    /** 广播给所有在等这一份的人；每人用自己那个 correlationId（前端按它认领）。 */
    const toWaiters = (message: (correlationId: string) => Record<string, unknown>) => {
      for (const w of current.waiters) hub.send(w.client, message(w.correlationId))
    }
    const settle = () => { if (inflight.get(source) === current) inflight.delete(source) }

    const run = async (): Promise<Enrichment> => {
      const enricher = deps.enrichers().get(source)
      if (!enricher) throw new Error(`enricher "${source}" not available`)
      return (await enricher(command.params, controller.signal)) as Enrichment
    }

    void run().then(
      (result) => {
        settle()
        if (result.article) toWaiters((correlationId) => ({ type: 'enrich.article', correlationId, article: result.article }))
        const comments = result.comments
        if (comments) {
          toWaiters((correlationId) => ({
            type: 'enrich.comments', correlationId, comments,
            total: result.total ?? comments.length,
          }))
        }
        toWaiters((correlationId) => ({ type: 'enrich.completed', correlationId }))
      },
      (error) => {
        settle()
        // 我们自己叫停的那次不报错：它的答案没人要了，一条 `failed` 只会在前端制造一次假故障。
        if (controller.signal.aborted) return
        if (error instanceof Error && error.name === 'RecipeBlockedError') {
          toWaiters((correlationId) => ({ type: 'enrich.blocked', correlationId, reason: error.message.slice(0, 500) }))
          return
        }
        toWaiters((correlationId) => ({
          type: 'enrich.failed', correlationId,
          error: String(error instanceof Error ? error.message : error).slice(0, 500),
        }))
      },
    )
  })
}
