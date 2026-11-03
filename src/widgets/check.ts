/**
 * widget 检查器（openspec `widget-manifest`）：逐条规则给出通过/失败与原因。
 *
 * 规则：manifest（存在且 schema 合法）、entry（文件存在）、icon（声明了就存在）、
 * serve-port（合法且不是主实例端口）、serve-up（serve.command 在超时内起来并回应健康检查）、
 * permissions（字段本身合法）。整体 ok = 全部结果都通过（没声明 serve / permissions 的对应
 * 规则按跳过 = 通过计）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { request } from 'node:http'
import { WIDGET_SCHEMA } from './manifest.ts'
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
}

const DEFAULT_TIMEOUT_MS = 10_000

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

export async function checkWidget(dir: string, opts: CheckOpts = {}): Promise<CheckOutput> {
  const results: CheckResult[] = []
  const abs = resolve(dir)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const backendPort = opts.backendPort ?? 8900

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
  const parsedShape = WIDGET_SCHEMA.safeParse(parsed)
  if (!parsedShape.success) {
    const first = parsedShape.error.issues[0]
    results.push({ rule: 'manifest', ok: false, message: `schema 校验失败：${first.path.join('.')} — ${first.message}` })
    return { ok: false, results }
  }
  manifest = parsedShape.data as WidgetManifest
  results.push({ rule: 'manifest', ok: true })

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

  // 4) serve-port：声明了 serve 才查
  if (manifest.serve) {
    const p = manifest.serve.port
    if (p === backendPort) results.push({ rule: 'serve-port', ok: false, message: `端口 ${p} 与主实例端口冲突` })
    else if (p < 1024 || p > 65535) results.push({ rule: 'serve-port', ok: false, message: `端口 ${p} 超出 1024–65535` })
    else results.push({ rule: 'serve-port', ok: true })
  } else {
    results.push({ rule: 'serve-port', ok: true, skipped: true })
  }

  // 5) serve-up：起 command、轮询健康检查、停服。spawn 失败 / 提前退出 / 超时都要说清。
  if (manifest.serve) {
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
      child.removeAllListeners()
      if (child.pid && child.exitCode === null && !child.killed) {
        try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      }
    }
  } else {
    results.push({ rule: 'serve-up', ok: true, skipped: true })
  }

  // 6) permissions：schema 已经整体校验过；这一条单独给结论（逐条报告的要求）。
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
  })
  .strict()
