// src/http/image-generation-routes.ts — 「会出图的动作 recipe」换成 OpenAI images API 的形状
// （spec `docs/superpowers/specs/2026-09-14-doubao-image-openai-bridge-design.md`）。
//
// 宿主这一侧**不认识任何一个包**：哪些 recipe 能当"模型"，由 recipe 自己在 `meta.produces: "images"`
// 里申报（今天是 `packages/doubao/doubao-image`）；一轮出几张读 recipe 的 `output.targetCount`；
// prompt 经 `params_schema.prompt` 递进去；回来的条目要有 `url`，可选 `watermarked:'true'`（退回带
// 水印的图时标出来，这里替它过 `dewatermark` 容器）。加一个新的生图站点 = 加一份 recipe，这里不动。
//
// 路径是 OpenAI 协议的标准形状：根级 `/v1/models`、`/v1/images/generations`——客户端把 Base URL 填成
// 源本身（`http://127.0.0.1:8900`，和填 `https://api.openai.com` 一个样），自己拼 `/v1/…`；`model` 填
// recipe 的 id。`/v1/*` 和 `/api/*` 过同一道门（`app.ts`）。它**不是 LLM 入口**（`/v1/chat/completions`
// 那条已撤，见 `app.removed-routes.test.ts`）——只有 images 这两条。
//
// 一次请求 = 一条动作 recipe 跑完 → 逐张下载 → （必要时）去水印 → b64 回。`confirmed:true` 由这里给：
// 这条口是程序消费者，和 CLI `--yes` 同一档；人的意图在客户端那次点击里。
import type { Context, Hono } from 'hono'
import { createHash } from 'node:crypto'
import { pluginTarget } from '../plugins/plugin-target.ts'
import { resolveBySourceId } from '../registry/source-id.ts'
import { withAwake } from '../plugins/standby/hook.ts'

/** recipe 在 `meta.produces` 里填这个值，就会出现在 `/v1/models` 里、能被 `model` 指到。 */
export const PRODUCES_IMAGES = 'images'
/** 等 recipe 跑完的上限（recipe 自己的 maxTaskMs 再大也不会超过它）。 */
const RUN_WAIT_MS = 210_000
const RUN_POLL_MS = 3_000
const DEWATERMARK_SERVICE = 'dewatermark'
const DEWATERMARK_TIMEOUT_MS = 60_000
export const DEWATERMARK_INSTALL_HINT = '去水印包没装：stream add @streamapp/dewatermark（装完重启后端）'
/** 去水印容器解析不到地址——是「没装」不是「坏了」，路由把它打成 503 而不是 502。 */
export class DewatermarkUnavailableError extends Error {
  constructor() { super(DEWATERMARK_INSTALL_HINT); this.name = 'DewatermarkUnavailableError' }
}

/** 一个"模型"= 一条会出图的动作 recipe，这里只要它的这几格。 */
export interface ImageModel {
  id: string
  /** 一轮固定出几张（recipe 的 `output.targetCount`）。`n` 超过它就拒。 */
  perRun: number
}

interface ActionResult {
  status: string
  runId?: string
  reason?: string
  items?: Record<string, string>[]
}
interface ActionRunView {
  status: string
  result?: unknown
  error?: string
}

export interface ImageGenerationRoutesDeps {
  /** 同 `HttpDeps.runAction`——MCP 那侧用的同一个闭包。缺席（这台后端没接动作面）→ 503。 */
  runAction?: (args: { sourceId: string; params?: Record<string, unknown>; confirmed?: boolean }) => Promise<unknown>
  /** 同 `HttpDeps.actionRun`。 */
  actionRun: (runId: string) => unknown | null
  /** 此刻申报了 `meta.produces: "images"` 的动作 recipe。getter 式现算：装/卸包会变。 */
  models: () => ImageModel[]
  /** 下载一张图的字节。默认全局 fetch；测试注入。 */
  fetchBytes?: (url: string) => Promise<Uint8Array>
  /** 去水印：一张进一张出。默认打 `dewatermark` 容器；测试注入。 */
  dewatermark?: (png: Uint8Array) => Promise<Uint8Array>
  /** `dewatermark` 容器的地址。`dewatermark` 是可选包（stream-packages），装没装只有运行时才知道——
   *  getter 现算，别在装配期存。默认 `() => pluginTarget('dewatermark')`；测试注入 `() => null` 模拟未装。 */
  dewatermarkTarget?: () => string | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** 参考图：张数与单张体积的上限。data URL 会整个进 recipe 参数、再进页内 fetch——别让一张 30MB 的图把求值撑爆。 */
const MAX_REFERENCE_IMAGES = 4
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const GENERATION_KEYS = new Set(['model', 'prompt', 'n', 'size', 'quality', 'background', 'response_format', 'output_format', 'user'])

/** OpenAI 形状的错误体。画布的 `readAxiosError` 读 `error.message`。 */
function oaError(message: string, type = 'invalid_request_error') {
  return { error: { message, type } }
}

/** `1536x1024` → `3:2`，`16:9` → `16:9`（无限画布把比例原样当 size 发）；正方形 / 不认识 → null。 */
export function aspectFromSize(size: unknown): string | null {
  if (typeof size !== 'string') return null
  const m = /^(\d+)\s*[x×:]\s*(\d+)$/i.exec(size.trim())
  if (!m) return null
  const w = Number(m[1]), h = Number(m[2])
  if (!w || !h || w === h) return null
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a)
  const d = g(w, h)
  return `${w / d}:${h / d}`
}

/** 站点未必接尺寸参数，比例只能写进 prompt。回显进 `revised_prompt`，别悄悄改了用户的话。 */
export function promptWithAspect(prompt: string, size: unknown): string {
  const aspect = aspectFromSize(size)
  return aspect ? `${prompt.trim()}, aspect ratio ${aspect}` : prompt.trim()
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`下载生成图失败：${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** 打去水印容器。地址在 `withAwake` 里现解析——host 档的 loopback 口只在容器醒着时存在（call-service 头注）。
 *  `target` 现算而非装配期存：`dewatermark` 是可选包，装没装只有运行时才知道。地址解析不到 → 没装（503），
 *  别跟"装了但打不通"混（502）。 */
function makeDefaultDewatermark(target: () => string | null): (png: Uint8Array) => Promise<Uint8Array> {
  return async (png) =>
    await withAwake(DEWATERMARK_SERVICE, async () => {
      const base = target()
      if (!base) throw new DewatermarkUnavailableError()
      const form = new FormData()
      const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
      form.set('image', new Blob([bytes], { type: 'image/png' }), 'image.png')
      const res = await fetch(`${base.replace(/\/$/, '')}/remove`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(DEWATERMARK_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`去水印失败：${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
      return new Uint8Array(await res.arrayBuffer())
    })
}

/** 跑 recipe 到落定：`running` 就按 runId 轮询。回 items 或抛（带 recipe 的 reason）。 */
async function generate(
  deps: {
    runAction: NonNullable<ImageGenerationRoutesDeps['runAction']>
    actionRun: ImageGenerationRoutesDeps['actionRun']
    sleep: (ms: number) => Promise<void>
    now: () => number
  },
  sourceId: string,
  params: { prompt: string; images?: string },
): Promise<Record<string, string>[]> {
  let result = (await deps.runAction({ sourceId, params, confirmed: true })) as ActionResult
  if (result.status === 'running' && result.runId) {
    const runId = result.runId
    const until = deps.now() + RUN_WAIT_MS
    for (;;) {
      await deps.sleep(RUN_POLL_MS)
      const view = deps.actionRun(runId) as ActionRunView | null
      if (!view) throw new Error(`动作 run ${runId} 找不到了`)
      if (view.status === 'done') {
        result = view.result as ActionResult
        break
      }
      if (view.status === 'error') throw new Error(`${sourceId} 没有正常收尾：${view.error ?? '未知'}`)
      if (deps.now() > until) throw new Error(`${sourceId} ${RUN_WAIT_MS / 1000}s 内没跑完（runId ${runId}）`)
    }
  }
  if (result.status !== 'done') throw new Error(`${sourceId} 失败（${result.status}）：${result.reason ?? '没有更多信息'}`)
  const items = (result.items ?? []).filter((it) => it.url)
  if (items.length === 0) throw new Error(`${sourceId} 跑完了但没有读到任何图片 URL`)
  return items.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
}

/**
 * 一轮生成固定出 `perRun` 张，而客户端未必一次要那么多：无限画布把「张数 4」拆成 **4 个并发的
 * n=1 请求**（`project.tsx` 对每个目标节点各发一次）。不合批的话，4 个同 prompt 的并发请求会被
 * action-run 的在飞幂等并到同一条 run 上、各自拿 `items[0]`——**4 张一模一样**（活体撞过）。
 * 这里按 (model, prompt) 合批：同一轮分完之前来的请求各领不同的下标；分完或过了这个时限就开新一轮。
 */
const BATCH_TTL_MS = 120_000
/** 一个请求最多等几轮：站点一轮出得少（图生图 1 张）时靠多轮凑，但不能无限跑下去烧额度。 */
const MAX_ROUNDS = 4
interface Batch {
  at: number
  taken: number
  promise: Promise<Record<string, string>[]>
}

export function mountImageGenerationRoutes(app: Hono, deps: ImageGenerationRoutesDeps): void {
  const batches = new Map<string, Batch>()
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes
  const dewatermark = deps.dewatermark ?? makeDefaultDewatermark(deps.dewatermarkTarget ?? (() => pluginTarget(DEWATERMARK_SERVICE)))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? (() => Date.now())

  app.get('/v1/models', (c) =>
    c.json({ object: 'list', data: deps.models().map((m) => ({ id: m.id, object: 'model', owned_by: 'stream' })) }),
  )

  /** 两条口共用的主体：校验 → 合批 → 跑 recipe → 下载 →（必要时）去水印 → b64。`images` 是参考图的
   *  data URL（多张按行拼），只 edits 有；它进合批键——同 prompt 不同参考图当然是两轮。 */
  const serve = async (c: Context, body: Record<string, unknown>, images: string[]) => {
    const runAction = deps.runAction
    if (!runAction) return c.json(oaError('这台 Stream 没接动作 recipe 执行器', 'server_error'), 503)
    const unknown = Object.keys(body).filter((k) => !GENERATION_KEYS.has(k))
    if (unknown.length) return c.json(oaError(`不认识的字段：${unknown.join(', ')}`), 400)
    const models = deps.models()
    const modelId = typeof body.model === 'string' ? body.model : ''
    // 同 Stream 别处的 sourceId 判据：全名是正名，裸名（`doubao-image`）不歧义时也认；歧义就当没找到，
    // 让错误体列出全名——不替客户端挑一个。
    let model: ImageModel | undefined
    try {
      model = resolveBySourceId(new Map(models.map((m) => [m.id, m])), modelId)
    } catch {
      model = undefined
    }
    if (!model) {
      return c.json(
        oaError(models.length ? `model 要是这几个之一：${models.map((m) => m.id).join('、')}` : '这台机器上没有申报 produces:"images" 的动作 recipe'),
        400,
      )
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) return c.json(oaError('prompt 必填'), 400)
    const nRaw = body.n === undefined ? 1 : Number(body.n)
    if (!Number.isInteger(nRaw) || nRaw < 1 || nRaw > model.perRun) {
      return c.json(oaError(`n 要在 1..${model.perRun} 之间（${model.id} 一轮固定出 ${model.perRun} 张）`), 400)
    }
    if (body.response_format !== undefined && body.response_format !== 'b64_json') {
      return c.json(oaError('只支持 response_format: "b64_json"（图片在本机，没有公网 URL 可回）'), 400)
    }
    const fullPrompt = promptWithAspect(prompt, body.size)
    const imagesParam = images.length ? images.join('\n') : undefined

    // 同 (model, prompt, 参考图) 的并发请求分食同一轮（见 BATCH_TTL_MS 头注）。先占座再等结果：占座是同步的，
    // 并发请求各拿到不同的下标；一轮分完（或过期）就开下一轮。参考图进键的是摘要，不是几 MB 的正文。
    const key = `${model.id}\n${fullPrompt}\n${imagesParam ? createHash('sha256').update(imagesParam).digest('hex') : ''}`
    const params = imagesParam ? { prompt: fullPrompt, images: imagesParam } : { prompt: fullPrompt }
    // 一轮实际出几张由站点定（豆包：纯文生图 4 张、带参考图 1 张），`perRun` 只是上限。这一轮分不到自己那份
    // 的请求不报错，开下一轮再领——4 个并发的 n=1 图生图请求就是 4 轮，各自拿到一张不同的图。
    let mine: Record<string, string>[] = []
    for (let round = 0; round < MAX_ROUNDS && mine.length < nRaw; round++) {
      let batch = batches.get(key)
      if (!batch || batch.taken + nRaw > model.perRun || now() - batch.at > BATCH_TTL_MS) {
        batch = { at: now(), taken: 0, promise: generate({ runAction, actionRun: deps.actionRun, sleep, now }, model.id, params) }
        batches.set(key, batch)
        // 失败的批次别留着：下一个请求进来该重跑，而不是再领一次同一个错误。
        batch.promise.catch(() => {
          if (batches.get(key) === batch) batches.delete(key)
        })
      }
      const from = batch.taken
      batch.taken += nRaw
      let items: Record<string, string>[]
      try {
        items = await batch.promise
      } catch (e) {
        return c.json(oaError((e as Error).message, 'server_error'), 502)
      }
      mine = items.slice(from, from + nRaw)
      // 这一轮出的比占的座少：把它从表里撤掉，下一圈开新的一轮（别的请求同样会撤，撤第二次是空操作）。
      if (mine.length < nRaw && batches.get(key) === batch) batches.delete(key)
    }
    if (mine.length < nRaw) {
      return c.json(oaError(`${MAX_ROUNDS} 轮都没凑够 ${nRaw} 张`, 'server_error'), 502)
    }

    // 条目没标 watermarked 就直接回；标了 `'true'`（站点只给到带水印的图）才过去水印容器。
    // 去水印失败**不吞**：静默回一张带水印的图会直接进游戏包。
    try {
      const data = await Promise.all(
        mine.map(async (it) => {
          const bytes = await fetchBytes(it.url)
          const clean = it.watermarked === 'true' ? await dewatermark(bytes) : bytes
          return { b64_json: Buffer.from(clean).toString('base64'), revised_prompt: fullPrompt }
        }),
      )
      return c.json({ created: Math.floor(now() / 1000), data })
    } catch (e) {
      if (e instanceof DewatermarkUnavailableError) return c.json(oaError(e.message, 'server_error'), 503)
      return c.json(oaError((e as Error).message, 'server_error'), 502)
    }
  }

  app.post('/v1/images/generations', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json(oaError('body 不是 JSON'), 400)
    }
    return serve(c, body, [])
  })

  // 图生图：OpenAI 的 edits 是 multipart——`image` 是文件（可多个），其余字段是文本。参考图转成 data URL
  // 递给 recipe（站点在页内把它塞进上传框）。`mask` 不支持：站点没有局部重绘的入口。
  app.post('/v1/images/edits', async (c) => {
    let form: Record<string, string | File | (string | File)[]>
    try {
      form = await c.req.parseBody({ all: true })
    } catch {
      return c.json(oaError('body 不是 multipart/form-data'), 400)
    }
    const files = ([] as (string | File)[]).concat(form.image ?? form['image[]'] ?? []).filter((f): f is File => f instanceof File)
    if (!files.length) return c.json(oaError('image 必填（multipart 里的文件字段）'), 400)
    if (files.length > MAX_REFERENCE_IMAGES) return c.json(oaError(`最多 ${MAX_REFERENCE_IMAGES} 张参考图`), 400)
    const images: string[] = []
    for (const f of files) {
      if (f.size > MAX_REFERENCE_BYTES) return c.json(oaError(`参考图 ${f.name} 太大（${f.size} 字节，上限 ${MAX_REFERENCE_BYTES}）`), 400)
      const type = f.type && f.type.startsWith('image/') ? f.type : 'image/png'
      images.push(`data:${type};base64,${Buffer.from(await f.arrayBuffer()).toString('base64')}`)
    }
    const body: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(form)) {
      if (k === 'image' || k === 'image[]') continue
      if (k === 'mask') return c.json(oaError('不支持 mask（站点没有局部重绘的入口）'), 400)
      body[k] = Array.isArray(v) ? v[0] : v
    }
    return serve(c, body, images)
  })
}
