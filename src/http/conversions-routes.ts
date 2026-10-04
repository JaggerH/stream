// src/http/conversions-routes.ts
//
// 统一的转换资源。重构前 OCR 与转写各有一族端点（/api/parses、/api/transcripts），逐行同构；
// 这里收成一族，kind 判别。设计见 docs/superpowers/specs/2026-07-25-conversions-unified-api-design.md。
import type { Hono } from 'hono'
import type { ConversionKind, ConversionSnapshot, ConversionStatus } from '../conversions/store.ts'
import type { ConversionRunner } from '../conversions/runner.ts'
import type { Media } from '../content/types.ts'
import { unknownKey, unknownKeyMessage } from './strict-input.ts'

export interface ConversionsDeps {
  runner: ConversionRunner
  /** 判定一个 handle 指不指向真实存在的东西（存量 item / netdisk 绑定的作品）；
   *  同时供出它的 media 与快照，省得客户端每次都递。 */
  resolveHandle: (handle: string) => {
    known: boolean
    media?: Media[]
    /** extract 判分支的输入（archetype 权威）；缺席 = 判不出来，converter 会明确报 no_content。 */
    content?: unknown
    url?: string
    snapshot?: ConversionSnapshot
  }
}

export const KINDS: ConversionKind[] = ['extract', 'identify', 'frames', 'summary', 'audio-fp']

/** 输入是**另一条 conversion**（不是 item 自身）的那些 kind。它们不要求 item 还在库里——
 *  上游那条转换就是它们的全部输入。**`ConversionKind` 加一个派生类 kind 就要在这里加一行**：
 *  漏了的表现是「对不在库里的 item 请求它 → 404」，而这条路只在特定形状下走到，很容易漏测。 */
export const DERIVED_KINDS: ConversionKind[] = ['identify', 'frames', 'summary']
const STATUSES: ConversionStatus[] = ['queued', 'running', 'done', 'error']

function err(code: string, message: string) {
  return { error: { code, message } }
}

/**
 * `POST /api/conversions` 认识的顶层字段（docs/API.md §2 的严格输入闸）。
 * **加字段就要加进来**——漏加是响亮的 400，不是"收下了但什么都没发生"。
 * `options` 里面不查：那是各 converter 自己的地盘。
 */
const CONVERSION_CREATE_KEYS = ['kind', 'item', 'media', 'snapshot', 'options', 'input', 'force'] as const

export function registerConversionsRoutes(app: Hono, deps: ConversionsDeps): void {
  // 能力发现：哪些 kind 注册了、后端配没配、各有哪些阶段。前端据此决定按钮显不显示，
  // 不必再 POST 一次试探 503。
  app.get('/api/conversion-kinds', (c) => c.json({ items: deps.runner.kinds() }))

  app.post('/api/conversions', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: string
      item?: string
      media?: Media[]
      snapshot?: ConversionSnapshot
      options?: Record<string, unknown>
      input?: string
      force?: boolean
    }
    // 闸放在 kind/item 校验之前：「你写的是 items，该写 item」比「item required」有用。
    // body 不是对象时不查（交给下面的 kind 校验说话）。
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const bad = unknownKey(Object.keys(body), CONVERSION_CREATE_KEYS)
      if (bad) return c.json(err('validation_error', unknownKeyMessage('字段', bad, CONVERSION_CREATE_KEYS)), 400)
    }
    const kind = body.kind as ConversionKind | undefined
    if (!kind || !KINDS.includes(kind)) {
      return c.json(err('validation_error', `kind must be one of ${KINDS.join('|')}`), 400)
    }
    const item = body.item
    if (!item) return c.json(err('validation_error', 'item required'), 400)

    // 派生类 kind（输入是另一条 conversion）不需要 item 本身还在——上游那条转换就是它的全部输入。
    const derived = DERIVED_KINDS.includes(kind)
    const resolved = deps.resolveHandle(item)
    if (!resolved.known && !body.media && !derived) {
      return c.json(err('not_found', 'item not found'), 404)
    }

    try {
      const { record, created } = deps.runner.start(kind, item, {
        options: { ...(body.options ?? {}), media: body.media ?? resolved.media, content: resolved.content, url: resolved.url },
        snapshot: body.snapshot ?? resolved.snapshot,
        inputId: body.input,
        force: body.force,
      })
      if (!created) return c.json(record, 200) // 命中缓存：状态码本身就区分了新建与复用
      c.header('Location', `/api/conversions/${record.id}`)
      return c.json(record, 201)
    } catch (e) {
      const msg = String((e as Error).message)
      // start() 在建记录之前就把这两种情况抛出来，所以这里不会留下半条垃圾记录。
      if (msg.includes('unavailable')) return c.json(err('unavailable', `${kind} 后端未配置`), 503)
      if (msg.includes('unknown')) return c.json(err('validation_error', msg), 400)
      throw e
    }
  })

  app.get('/api/conversions', (c) => {
    const q = c.req.query()
    const kind = q.kind as ConversionKind | undefined
    if (kind && !KINDS.includes(kind)) return c.json(err('validation_error', 'unknown kind'), 400)
    const status = q.status as ConversionStatus | undefined
    if (status && !STATUSES.includes(status)) return c.json(err('validation_error', 'unknown status'), 400)
    const limit = q.limit ? Number(q.limit) : undefined
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json(err('validation_error', 'limit must be a positive number'), 400)
    }
    return c.json(
      deps.runner.list({
        item: q.item,
        kind,
        status,
        limit,
        cursor: q.cursor,
        expandResult: q.expand === 'result',
      })
    )
  })

  app.get('/api/conversions/:id', (c) => {
    const rec = deps.runner.get(c.req.param('id'))
    if (!rec) return c.json(err('not_found', 'conversion not found'), 404)
    return c.json(rec)
  })

  // 取消并删除。语义是「消灭这个意图和它的产物」——在跑的中止、排队的出队、历史的直接删。
  app.delete('/api/conversions/:id', (c) => {
    if (!deps.runner.remove(c.req.param('id'))) {
      return c.json(err('not_found', 'conversion not found'), 404)
    }
    return c.json({ ok: true })
  })
}
