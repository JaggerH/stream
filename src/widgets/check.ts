/**
 * widget 检查器（openspec `widget-manifest`）。
 *
 * 规则：manifest（存在且 schema 合法）、env（顶层没有 `env` / `environment`）、entry（文件存在）、
 * icon（声明了就存在）、data-dir（声明了 `dataDir` 就必须是清单目录内的相对路径；没声明按缺省数据根
 * `data/` 跳过）、serve-port（合法且不是主实例端口）、serve-command（`serve.command` 的第一个词是白名单
 * 解释器或清单目录内的相对路径，且参数不含 shell 元字符）、serve-up（serve.command 在超时内起来并回应
 * 健康检查；**serve-command 不通过时不启动**）、data-ingress（声明了 data 就必须有 serve）、data-endpoint
 * （serve 还活着的时候向 /.well-known/widget-data 发一次最小样例，只要求连得上且不是 404）、
 * data-storage（检查器进程带 `WIDGET_DATA_URL` 时对宿主的存储服务探活一次：接受 2xx 与 404，拒绝
 * 连不上、401/403、5xx 与其余非 2xx/404 的状态码；没有 env 则跳过——自部署行为不变）、
 * permissions（字段本身合法）。整体 ok = 全部结果都通过（没声明 serve / data / permissions、没有存储
 * env 的对应规则按跳过 = 通过计）。
 *
 * `data-dir` / `env` / `serve-command` 三条归属规则见 openspec `widget-manifest-limits`：数据目录与环境
 * 变量都属于宿主，清单只能声明位置；后端由哪个解释器起也归宿主管，检查器自己不起不该起的命令。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { request } from 'node:http'
import {
  WIDGET_SCHEMA,
  WIDGET_DATA_PATH,
  WIDGET_DATA_DEFAULT_DIR,
  WIDGET_DATA_URL,
  WIDGET_STORAGE_OBJECTS_PATH,
  SERVE_INTERPRETERS,
  SHELL_METACHARS,
  FORBIDDEN_ENV_FIELDS,
} from './manifest.ts'
import type { WidgetManifest } from './manifest.ts'

export interface CheckResult {
  rule: string
  ok: boolean
  /** skipped = 该规则没有可查的对象（没声明 serve / permissions），按通过计。 */
  skipped?: boolean
  message?: string
}

export interface CheckOutput {
  ok: boolean
  results: CheckResult[]
}

export interface CheckOpts {
  /** serve-up 健康检查的等待上界，缺省 10s。 */
  timeoutMs?: number
  /** 主实例端口（serve.port 不得撞上），缺省 8900。 */
  backendPort?: number
  /**
   * 检查器可见的环境（openspec `widget-data-storage`）：只有 `data-storage` 一条读它——带
   * `WIDGET_DATA_URL`（宿主提供持久数据服务）就探活，不带就跳过。检查器自己**不读** `process.env`：
   * 库入口可达的模块不许读环境（openspec `embeddable-engine`），宿主环境由进程入口（CLI / 宿主装配）
   * 翻译后递进来。缺省 = 空环境 = `data-storage` 跳过，与宿主不提供存储服务同一结论。
   */
  env?: Record<string, string | undefined>
}

const DEFAULT_TIMEOUT_MS = 10_000

/** data-endpoint 单次探测的等待上界：数据口是本地回环，两秒足够，不起轮询循环。 */
const DATA_PROBE_TIMEOUT_MS = 2_000

/** GET http://127.0.0.1:port/path 一次；连不上 reject。 */
function probeOnce(port: number, path: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => { req.destroy(new Error('probe timeout')) })
    req.on('error', reject)
    req.end()
  })
}

/** POST http://127.0.0.1:port/path 一次，body 是 JSON；连不上 reject，否则给状态码。 */
function postOnce(port: number, path: string, body: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('timeout', () => { req.destroy(new Error('探测超时')) })
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * 数据口探测（openspec `widget-data-ingress`）：按约定向 serve 端口发一份最小样例（空对象 JSON），
 * 只要求「连得上、不是 404」。widget 收下与否由回 2xx 决定；它校验数据后回 4xx（400 之类）说明口
 * 在，本条不拦。body 用空对象而不按 `data` 造样例：从任意 JSON Schema 生成实例需要一个生成器，
 * 而区分「没实现（404）」与「实现了但嫌数据不对（4xx）」用空对象就够了。
 */
async function probeDataEndpoint(port: number): Promise<CheckResult> {
  try {
    const status = await postOnce(port, WIDGET_DATA_PATH, '{}', DATA_PROBE_TIMEOUT_MS)
    return status === 404
      ? { rule: 'data-endpoint', ok: false, message: `POST ${WIDGET_DATA_PATH} 返回 404：serve 起来了，但没有实现数据口` }
      : { rule: 'data-endpoint', ok: true, message: `HTTP ${status}` }
  } catch (e) {
    return { rule: 'data-endpoint', ok: false, message: `POST ${WIDGET_DATA_PATH} 连不上：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 起一个回环探测循环：每 250ms 探一次，任何 <500 的响应都算「起来了」。返回停服函数。 */
async function pollHealth(port: number, path: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const status = await probeOnce(port, path, 2_000)
      if (status > 0 && status < 500) return { ok: true, detail: `HTTP ${status}` }
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return { ok: false, detail: `健康检查 ${timeoutMs}ms 内没有得到 <500 的响应` }
}

/**
 * 存储服务探活的探针路径（openspec `widget-data-storage`）：对象端点下的一个固定名字。探测只问
 * 「服务在不在」，404 = 服务在但这个探针没写过，与 2xx 同样算通过；名字本身不进任何数据命名空间。
 */
const DATA_STORAGE_PROBE_PATH = `${WIDGET_STORAGE_OBJECTS_PATH}/.probe`

/** 存储探活的单次等待上界：与数据口探测同档，本地回环或同宿主内网两秒足够。 */
const DATA_STORAGE_PROBE_TIMEOUT_MS = 2_000

/**
 * 存储服务探活（openspec `widget-data-storage`）：宿主注入了 `WIDGET_DATA_URL` 时，对该服务的对象
 * 端点发一次单次 `HEAD`。接受 2xx 与 404（404 = 还没写过，正常）；连不上、401/403（凭据不对）、
 * 5xx（服务端坏了）与其余非 2xx/404 的状态码都不通过并写明原因。检查器不带构件凭据（那是宿主给
 * widget 后端的，检查器进程未必有），服务按未认证回 401 是「服务在、门关着」——对构件有用的探活
 * 要凭据，这里只验证可达性与基本语义。
 */
async function probeDataStorage(baseUrl: string): Promise<CheckResult> {
  let url: URL
  try {
    url = new URL(DATA_STORAGE_PROBE_PATH, baseUrl)
  } catch {
    return { rule: 'data-storage', ok: false, message: `${WIDGET_DATA_URL} 不是合法的 URL：${baseUrl}` }
  }
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(DATA_STORAGE_PROBE_TIMEOUT_MS), redirect: 'manual' })
    const status = res.status
    if (status >= 200 && status < 300) return { rule: 'data-storage', ok: true, message: `存储服务可达（HTTP ${status}）` }
    if (status === 404) return { rule: 'data-storage', ok: true, message: '存储服务可达（404 = 探针未写过，正常）' }
    if (status === 401 || status === 403) {
      return { rule: 'data-storage', ok: false, message: `存储服务拒绝探活（HTTP ${status}）：可达但凭据语义不对` }
    }
    return { rule: 'data-storage', ok: false, message: `存储服务返回 HTTP ${status}：不是 2xx / 404，探活不通过` }
  } catch (e) {
    return { rule: 'data-storage', ok: false, message: `存储服务连不上（${url.origin}）：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 像绝对路径的写法：POSIX 前缀、UNC、Windows 盘符。 */
const isAbsoluteLike = (s: string): boolean =>
  s.startsWith('/') || s.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(s)

/** 顶层的环境变量字段名（小写比对）。strict schema 本来也拒未知键，这一条是把原因指名。 */
function envFieldsOf(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const allowed: readonly string[] = FORBIDDEN_ENV_FIELDS
  return Object.keys(parsed as Record<string, unknown>).filter((k) => allowed.includes(k.toLowerCase()))
}

/** `dataDir` 的判据（openspec `widget-manifest-limits`）：非空、不是绝对路径、不含 `..` 段。通过返回 undefined。 */
function dataDirProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return 'dataDir 必须是非空字符串（相对清单目录的路径）'
  if (isAbsoluteLike(value)) return `dataDir 不能是绝对路径：${value}——数据目录由宿主映射，清单只能给相对清单目录的路径`
  if (value.split(/[\\/]/).includes('..')) return `dataDir 不得含 ..：${value}——跳出清单目录的路径不是该 widget 自己的数据目录`
  return undefined
}

/**
 * `serve.command` 的判据（openspec `widget-manifest-limits`）：第一个词要么是白名单里的裸名
 * （{@link SERVE_INTERPRETERS}），要么是清单目录内的相对路径；命令的任意元素都不得含 shell 元字符
 * （命令参数不得含 shell 元字符：宿主可能在别处以 shell 字符串拉起后端，`a; b` 在那儿就不是它在这儿
 * 看起来的那个意思）。通过返回 undefined。
 */
function serveCommandProblem(command: string[], abs: string): string | undefined {
  const metas: readonly string[] = SHELL_METACHARS
  const hit = metas.find((m) => command.some((w) => w.includes(m)))
  if (hit !== undefined) {
    const word = command.find((w) => w.includes(hit)) as string
    return `命令参数不得含 shell 元字符（${hit}）：${word}`
  }
  const word = command[0]
  if (word === undefined || word.trim() === '') return 'serve.command 的第一个词不能是空串'
  if (isAbsoluteLike(word)) {
    return `serve.command 的可执行文件不能是绝对路径：${word}——用解释器白名单（${[...SERVE_INTERPRETERS].join(' / ')}）或清单目录内的相对路径`
  }
  if (word.includes('/') || word.includes('\\')) {
    if (word.split(/[\\/]/).includes('..')) return `serve.command 的可执行文件不得含 ..（跳出清单目录）：${word}`
    const target = resolve(abs, word)
    if (target !== abs && !target.startsWith(abs + sep)) return `serve.command 的可执行文件解析后不在清单目录内：${word}`
    return undefined // 在目录内：存不存在由 serve-up 的 spawn 结果说
  }
  const names: readonly string[] = SERVE_INTERPRETERS
  if (!names.includes(word)) {
    return `serve.command 的第一个词「${word}」既不在解释器白名单（${[...SERVE_INTERPRETERS].join(' / ')}），也不是清单目录内的相对路径`
  }
  return undefined
}

export async function checkWidget(dir: string, opts: CheckOpts = {}): Promise<CheckOutput> {
  const results: CheckResult[] = []
  const abs = resolve(dir)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const backendPort = opts.backendPort ?? 8900
  const env = opts.env ?? {}

  // 1) manifest：存在、JSON 可解、schema 合法
  let manifest: WidgetManifest | undefined
  let raw: string | undefined
  try {
    raw = readFileSync(join(abs, 'widget.json'), 'utf8')
  } catch {
    results.push({ rule: 'manifest', ok: false, message: `${abs}/widget.json 不存在或读不了` })
    return { ok: false, results }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    results.push({ rule: 'manifest', ok: false, message: `widget.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` })
    return { ok: false, results }
  }
  // 1b) env：看原始 JSON 的顶层键。strict schema 本来也会把 `env` / `environment` 拒在「未知字段」里，
  //     但那条给不出「环境变量由宿主组装」这个原因——所以这里先指名，schema 的结论照旧各走各路。
  const envKeys = envFieldsOf(parsed)
  const envResult: CheckResult = envKeys.length === 0
    ? { rule: 'env', ok: true }
    : { rule: 'env', ok: false, message: `环境变量由宿主组装，清单不能注入（发现字段：${envKeys.join('、')}）` }

  const parsedShape = WIDGET_SCHEMA.safeParse(parsed)
  if (!parsedShape.success) {
    const first = parsedShape.error.issues[0]
    results.push({ rule: 'manifest', ok: false, message: `schema 校验失败：${first.path.join('.')} — ${first.message}` })
    results.push(envResult)
    return { ok: false, results }
  }
  manifest = parsedShape.data as WidgetManifest
  results.push({ rule: 'manifest', ok: true })
  results.push(envResult)

  // 2) entry：文件存在
  const entryPath = join(abs, manifest.entry)
  if (!existsSync(entryPath)) results.push({ rule: 'entry', ok: false, message: `入口不存在：${manifest.entry}` })
  else results.push({ rule: 'entry', ok: true })

  // 3) icon：声明了就要存在；没声明跳过（界面用内置图标）
  if (manifest.icon) {
    if (!existsSync(join(abs, manifest.icon))) results.push({ rule: 'icon', ok: false, message: `icon 不存在：${manifest.icon}` })
    else results.push({ rule: 'icon', ok: true })
  } else {
    results.push({ rule: 'icon', ok: true, skipped: true })
  }

  // 4) data-dir：`dataDir` 是「数据往哪儿写」的目录声明，归宿主管（openspec `widget-manifest-limits`）：
  //     必须是清单目录内的相对路径，宿主把它映射成该 widget 唯一可写的数据目录。没声明 = 缺省数据根
  //     data/（openspec `widget-data-storage`：宿主给一份按 widget id 命名的目录），本条跳过。
  //     静态判定，不起进程、不创建目录。
  if (manifest.dataDir !== undefined) {
    const problem = dataDirProblem(manifest.dataDir)
    results.push(problem === undefined
      ? { rule: 'data-dir', ok: true, message: `宿主把 ${manifest.dataDir} 映射成该 widget 唯一可写的数据目录` }
      : { rule: 'data-dir', ok: false, message: problem })
  } else {
    results.push({ rule: 'data-dir', ok: true, skipped: true, message: `未声明 dataDir：缺省数据根 ${WIDGET_DATA_DEFAULT_DIR}/，宿主给一份按 widget id 命名的数据目录` })
  }

  // 5) serve-port：声明了 serve 才查
  if (manifest.serve) {
    const p = manifest.serve.port
    if (p === backendPort) results.push({ rule: 'serve-port', ok: false, message: `端口 ${p} 与主实例端口冲突` })
    else if (p < 1024 || p > 65535) results.push({ rule: 'serve-port', ok: false, message: `端口 ${p} 超出 1024–65535` })
    else results.push({ rule: 'serve-port', ok: true })
  } else {
    results.push({ rule: 'serve-port', ok: true, skipped: true })
  }

  // 数据口的探测只能在下面 serve-up 那段进程窗口里现取，先占个位，好在 serve-up 之后按顺序入表。
  let dataEndpoint: CheckResult | undefined

  // 6) serve-command：第一个词与参数形状的静态判定（openspec `widget-manifest-limits`）。这一条不通过
  //     就**不往下 spawn**：检查器不该是那条不该起的命令的执行者。
  let commandOk = true
  if (manifest.serve) {
    const problem = serveCommandProblem(manifest.serve.command, abs)
    commandOk = problem === undefined
    results.push(problem === undefined
      ? { rule: 'serve-command', ok: true }
      : { rule: 'serve-command', ok: false, message: `${problem}；command=${manifest.serve.command.join(' ')}` })
  } else {
    results.push({ rule: 'serve-command', ok: true, skipped: true })
  }

  // 7) serve-up：起 command、轮询健康检查、停服。spawn 失败 / 提前退出 / 超时都要说清。
  if (manifest.serve && !commandOk) {
    results.push({ rule: 'serve-up', ok: true, skipped: true, message: 'serve-command 不通过，检查器没有启动这条命令（原因见 serve-command）' })
  } else if (manifest.serve) {
    const [cmd, ...args] = manifest.serve.command
    let child: ChildProcess | undefined
    let exited: string | undefined
    try {
      child = spawn(cmd, args, { cwd: abs, stdio: 'ignore' })
    } catch (e) {
      results.push({ rule: 'serve-up', ok: false, message: `起不了 serve.command：${e instanceof Error ? e.message : String(e)}` })
    }
    if (child) {
      child.once('exit', (code, signal) => { exited = `进程退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）` })
      // spawn 本身失败（ENOENT / 权限）：不挂监听就是未捕获异常。记成与退出同一档「起不来」。
      child.on('error', (e) => { exited = `进程起不来：${e.message}` })
      const health = await pollHealth(manifest.serve.port, '/', timeoutMs)
      if (!health.ok && exited) results.push({ rule: 'serve-up', ok: false, message: `${exited}；command=${manifest.serve.command.join(' ')}` })
      else if (!health.ok) results.push({ rule: 'serve-up', ok: false, message: `${health.detail}；command=${manifest.serve.command.join(' ')}` })
      else results.push({ rule: 'serve-up', ok: true, message: health.detail })
      // 声明了 data 就在进程还活着的这一段里探一次数据口（不另起第二次进程）。
      if (manifest.data && health.ok) dataEndpoint = await probeDataEndpoint(manifest.serve.port)
      child.removeAllListeners()
      if (child.pid && child.exitCode === null && !child.killed) {
        try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      }
    }
  } else {
    results.push({ rule: 'serve-up', ok: true, skipped: true })
  }

  // 8) data-ingress：`data` 是「数据往哪儿写」的声明，那个口只长在 serve 端口上——声明了 data
  //    却没有 serve，数据无处可写。静态判定，不起进程。
  if (!manifest.data) {
    results.push({ rule: 'data-ingress', ok: true, skipped: true })
  } else if (!manifest.serve) {
    results.push({ rule: 'data-ingress', ok: false, message: `声明了 data 但没有 serve，数据无处可写（约定：POST http://127.0.0.1:<serve.port>${WIDGET_DATA_PATH}）` })
  } else {
    results.push({ rule: 'data-ingress', ok: true })
  }

  // 9) data-endpoint：探测结论，只要求「连得上、不是 404」（见 probeDataEndpoint）。没 data、
  //    没 serve（原因在 data-ingress）、serve 没起来（原因在 serve-up）、serve 根本没被启动（原因在
  //    serve-command）都记跳过。
  results.push(dataEndpoint
    ?? (manifest.data
      ? {
          rule: 'data-endpoint',
          ok: true,
          skipped: true,
          message: !manifest.serve
            ? '没有 serve 可探测（原因见 data-ingress）'
            : !commandOk
              ? 'serve 没有被启动，未探测（原因见 serve-command）'
              : 'serve 没起来，未探测（原因见 serve-up）',
        }
      : { rule: 'data-endpoint', ok: true, skipped: true }))

  // 10) data-storage：宿主提供持久数据服务时的探活（openspec `widget-data-storage`）。环境从
  //     `opts.env` 取，不从 `process.env` 读（库入口可达的模块不读环境）；进程入口（CLI / 宿主装配）
  //     把它看见的环境递进来。没有 `WIDGET_DATA_URL` 就跳过——自部署 `widget check` 行为不变。
  const storageUrl = env[WIDGET_DATA_URL]
  if (storageUrl) results.push(await probeDataStorage(storageUrl))
  else results.push({ rule: 'data-storage', ok: true, skipped: true, message: `没有 ${WIDGET_DATA_URL}：宿主不提供持久数据服务，widget 只用本地数据目录` })

  // 11) permissions：schema 已经整体校验过；这一条单独给结论（逐条报告的要求）。media 是声明不是
  //     授权：放不放由宿主决定（见 manifest.ts），本检查只管形状。
  if (manifest.permissions !== undefined) {
    const re = PERMISSIONS_SHAPE.safeParse(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).permissions : undefined)
    results.push(re.success
      ? { rule: 'permissions', ok: true }
      : { rule: 'permissions', ok: false, message: `permissions 字段不合法：${re.error.issues[0].path.join('.')} — ${re.error.issues[0].message}` })
  } else {
    results.push({ rule: 'permissions', ok: true, skipped: true })
  }

  return { ok: results.every((r) => r.ok), results }
}

// permissions 子 schema（单独给结论用；与 manifest.ts 的定义保持同步——从那里拿不到子块，
// 这里用同一个 z 实例重建，测试里有正反例钉着两边一致的行为）。
import { z } from 'zod'
const PERMISSIONS_SHAPE = z
  .object({
    model: z.boolean().optional(),
    credentials: z.array(z.string().min(1)).optional(),
    network: z
      .array(
        z.string().transform((v) => v.trim().toLowerCase()).refine(
          (s) => {
            const host = s.startsWith('*.') ? s.slice(2) : s
            return host.length > 0 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
          },
          '域名只能是主机名或 *.前缀模式（小写字母、数字、点、连字符）',
        ),
      )
      .optional(),
    // media 与 manifest.ts 的声明保持同步：媒体能力只是声明，由宿主决定是否放开（iframe `allow` 的
    // 拼装在宿主侧）；宿主永不放开 allow-same-origin / allow-top-navigation。
    media: z
      .object({
        autoplay: z.boolean().optional(),
        fullscreen: z.boolean().optional(),
        popups: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
