/**
 * 宿主提供的持久数据服务——widget 侧参考客户端（openspec `widget-data-storage`）。
 *
 * 这是一份**参考实现**：把存储接口约定（端点、条件写、路径规范化、错误码）落成可直接对照的代码，
 * 供嵌入方实现宿主一侧、构件作者移植到别的语言时对照。它不是公共导出面的一部分（公共面只导出
 * 约定常量）；用 Node 内置 `fetch`，不带任何宿主的具体实现。
 *
 * base URL 与凭据（`WIDGET_DATA_URL` / WIDGET_DATA_TOKEN，常量见 `./manifest.ts`）由宿主组装环境时注入——
 * 本客户端只在构造函数里收这两个值，读环境是进程入口的事。
 */
import {
  WIDGET_STORAGE_DOCUMENT_PATH,
  WIDGET_STORAGE_OBJECTS_PATH,
  WIDGET_STORAGE_MAX_DEPTH,
  WIDGET_STORAGE_MAX_PATH,
  WIDGET_STORAGE_MAX_SEGMENT,
  WIDGET_STORAGE_RESERVED_NAMES,
} from './manifest.ts'

/** 服务返回的错误体（约定 `{error, message}`）。 */
export interface WidgetDataErrorBody {
  error: string
  message: string
}

/** 一次存储调用失败：status 是 HTTP 状态码，code / message 取自服务错误体（取不到时给缺省归类）。 */
export class WidgetDataError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WidgetDataError'
  }
}

/** 对象元数据（列举与 GET/HEAD 响应都带；`updatedAt` 为服务端毫秒时间戳）。 */
export interface WidgetDataObjectInfo {
  path: string
  revision: string
  sha256: string | null
  bytes: number
  updatedAt: number
}

/** 列举响应的一页。`next` 存在 = 还有下一页（放进下一次 list 的 cursor）。 */
export interface WidgetDataListPage {
  items: WidgetDataObjectInfo[]
  next?: string
}

/**
 * 对象路径的规范化校验（openspec `widget-data-storage`）。合法：POSIX 相对路径，无空段、`.`、`..`、
 * 反斜杠、NUL，段长 ≤ WIDGET_STORAGE_MAX_SEGMENT，总长 ≤ WIDGET_STORAGE_MAX_PATH，
 * 深度 ≤ WIDGET_STORAGE_MAX_DEPTH，不以 WIDGET_STORAGE_RESERVED_NAMES 开头。
 * 返回 {null} = 合法；否则返回一条可读原因。客户端与服务端各校验一遍，不信任其中一侧。
 */
export function objectPathProblem(path: string | null): string | null {
  if (typeof path !== 'string' || path === '') return '对象路径必须是非空字符串'
  if (path.includes('\0')) return '对象路径不得含 NUL'
  if (path.includes('\\')) return '对象路径不得含反斜杠（POSIX 相对路径）'
  if (path.startsWith('/')) return '对象路径必须是相对路径'
  const segments = path.split('/')
  if (segments.some((s) => s === '')) return '对象路径不得有空段'
  if (segments.some((s) => s === '.' || s === '..')) return '对象路径不得含 . 或 .. 段'
  if (segments.some((s) => s.length > WIDGET_STORAGE_MAX_SEGMENT)) {
    return `对象路径单段不得超过 ${WIDGET_STORAGE_MAX_SEGMENT} 字符`
  }
  if (path.length > WIDGET_STORAGE_MAX_PATH) return `对象路径总长不得超过 ${WIDGET_STORAGE_MAX_PATH} 字符`
  if (segments.length > WIDGET_STORAGE_MAX_DEPTH) return `对象路径深度不得超过 ${WIDGET_STORAGE_MAX_DEPTH}`
  for (const reserved of WIDGET_STORAGE_RESERVED_NAMES) {
    if (segments[0] === reserved) return `对象路径不得以保留名 ${reserved} 开头`
  }
  return null
}

/** 服务端错误的统一归类：取错误体的 error；取不到时按状态码给一个保守的名字。 */
function codeFor(status: number, body: WidgetDataErrorBody | undefined): string {
  if (body?.error) return body.error
  return `http_${status}`
}

/** 解析服务端错误体：约定 `{error, message}`；解析不了就退回状态码描述。 */
async function errorOf(status: number, res: Response): Promise<WidgetDataError> {
  let body: WidgetDataErrorBody | undefined
  try {
    const parsed = (await res.json()) as unknown
    if (parsed && typeof parsed === 'object' && 'error' in parsed && 'message' in parsed) {
      body = parsed as WidgetDataErrorBody
    }
  } catch { /* 错误体不是 JSON：按状态码归类 */ }
  return new WidgetDataError(status, codeFor(status, body), body?.message ?? `HTTP ${status}`)
}

/** 条件写的前置：`If-Match`（覆盖时给 revision）或 `If-None-Match: *`（只在新建时成立）。 */
export interface WriteConditions {
  /** 覆盖写的乐观锁：上次读到的 revision（弱 ETag 的值）。 */
  ifMatch?: string
  /** 新建语义：对象不存在才写，存在则 412。 */
  ifNoneMatchStar?: boolean
}

/** 客户端构造参数：base URL 与凭据都由宿主注入（进程入口读环境后递进来）。 */
export interface WidgetDataClientOptions {
  /** 数据服务的 base URL（`WIDGET_DATA_URL` 的值）。 */
  baseUrl: string
  /** 本次会话的构件凭据（WIDGET_DATA_TOKEN 的值），原样进 `Authorization: Bearer`。 */
  token: string
  /** 单次请求超时毫秒数，缺省 10s。 */
  timeoutMs?: number
}

/**
 * 存储接口的最小参考客户端。一个客户端只属于一个 widget（凭据是 per-widget 的）；文档端点每个
 * widget 一份，对象端点在它自己的数据根命名空间下。
 */
export class WidgetDataClient {
  private readonly base: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: WidgetDataClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  private async request(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<Response> {
    const url = new URL(this.base + path)
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    return res
  }

  // ── 文档（整份 JSON，每 widget 一份）──────────────────────────────────────

  /** 读整份文档。没写过（404）回 null；服务不可达（503）等其余错误抛 WidgetDataError。 */
  async getDocument(): Promise<{ body: unknown; revision: string } | null> {
    const res = await this.request(WIDGET_STORAGE_DOCUMENT_PATH)
    if (res.status === 404) return null
    if (!res.ok) throw await errorOf(res.status, res)
    return {
      body: (await res.json()) as unknown,
      revision: revisionOf(res),
    }
  }

  /**
   * 写整份文档。条件写同对象：覆盖必须给 `ifMatch`，新建用 `ifNoneMatchStar`；前置不满足（409/412）
   * 抛 WidgetDataError，**不会静默覆盖**。
   */
  async putDocument(body: unknown, conditions: WriteConditions = {}): Promise<{ revision: string }> {
    const headers = conditionHeaders(conditions)
    const res = await this.request(WIDGET_STORAGE_DOCUMENT_PATH, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await errorOf(res.status, res)
    return { revision: revisionOf(res) }
  }

  // ── 对象（路径 → 字节，条件写、可列举、可删）──────────────────────────────

  /** 读一个对象。没写过（404）回 null；其余错误抛 WidgetDataError。 */
  async getObject(path: string): Promise<{ bytes: Uint8Array; revision: string; sha256: string | null } | null> {
    const problem = objectPathProblem(path)
    if (problem) throw new WidgetDataError(0, 'invalid_path', problem)
    const res = await this.request(`${WIDGET_STORAGE_OBJECTS_PATH}/${encodeSegments(path)}`)
    if (res.status === 404) return null
    if (!res.ok) throw await errorOf(res.status, res)
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      revision: revisionOf(res),
      sha256: res.headers.get('x-widget-sha256'),
    }
  }

  /**
   * 写一个对象。条件写同 putDocument；超限（413 单个过大 / 507 总量超限）与限流（429）、
   * 服务不可达（503）都抛 WidgetDataError——客户端必须处理这几种失败。
   */
  async putObject(path: string, bytes: Uint8Array, conditions: WriteConditions = {}, contentType = 'application/octet-stream'): Promise<{ revision: string }> {
    const problem = objectPathProblem(path)
    if (problem) throw new WidgetDataError(0, 'invalid_path', problem)
    const headers = conditionHeaders(conditions)
    const res = await this.request(`${WIDGET_STORAGE_OBJECTS_PATH}/${encodeSegments(path)}`, {
      method: 'PUT',
      headers: { 'content-type': contentType, ...headers },
      body: bytes as unknown as BodyInit,
    })
    if (!res.ok) throw await errorOf(res.status, res)
    return { revision: revisionOf(res) }
  }

  /** 读一个对象的元数据。没写过（404）回 null。 */
  async statObject(path: string): Promise<WidgetDataObjectInfo | null> {
    const problem = objectPathProblem(path)
    if (problem) throw new WidgetDataError(0, 'invalid_path', problem)
    const res = await this.request(`${WIDGET_STORAGE_OBJECTS_PATH}/${encodeSegments(path)}`, { method: 'HEAD' })
    if (res.status === 404) return null
    if (!res.ok) throw await errorOf(res.status, res)
    return {
      path,
      revision: revisionOf(res),
      sha256: res.headers.get('x-widget-sha256'),
      bytes: Number(res.headers.get('content-length') ?? 0),
      updatedAt: Number(res.headers.get('x-widget-updated-at') ?? 0),
    }
  }

  /**
   * 删一个对象（软删语义由服务端定）。幂等：对象不存在（404）也算删成。
   */
  async deleteObject(path: string): Promise<void> {
    const problem = objectPathProblem(path)
    if (problem) throw new WidgetDataError(0, 'invalid_path', problem)
    const res = await this.request(`${WIDGET_STORAGE_OBJECTS_PATH}/${encodeSegments(path)}`, { method: 'DELETE' })
    if (res.status === 404) return
    if (!res.ok) throw await errorOf(res.status, res)
  }

  /** 列当前对象（一页）。翻页：把本页的 `next` 作为下一次的 `cursor`。 */
  async list(prefix = '', cursor?: string): Promise<WidgetDataListPage> {
    const res = await this.request(WIDGET_STORAGE_OBJECTS_PATH, {
      query: cursor ? { prefix, cursor } : { prefix },
    })
    if (!res.ok) throw await errorOf(res.status, res)
    const page = (await res.json()) as WidgetDataListPage
    return page
  }
}

/** 条件写 → 请求头。 */
function conditionHeaders(conditions: WriteConditions): Record<string, string> {
  if (conditions.ifMatch) return { 'if-match': conditions.ifMatch }
  if (conditions.ifNoneMatchStar) return { 'if-none-match': '*' }
  return {}
}

/** 从响应取 revision：约定弱 ETag / `X-Widget-Revision`，客户端不解析内部格式，只透传。 */
function revisionOf(res: Response): string {
  return res.headers.get('etag') ?? res.headers.get('x-widget-revision') ?? ''
}

/** 逐段 encodeURIComponent，保留 `/`：路径里的特殊字符只影响单段，不改变段结构。 */
function encodeSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
