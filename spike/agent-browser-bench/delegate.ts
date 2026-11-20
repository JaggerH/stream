/**
 * Prototype: delegate `find` / `click` / `fill` to an external `agent-browser` CLI
 * that is attached to the same Chromium the CDP binding drives (`--cdp <url>`).
 *
 * This file exists to answer one question with code instead of prose: can the
 * three ops the browser recipes need be expressed through the CLI, and does the
 * answer fit the receipt shape the relay already speaks
 * (`{id, result?, error?, swMs}` in `src/cdp-binding/ops.ts`)?
 *
 * It is a spike: imported by the bench and by `delegate.test.ts` only. Nothing
 * in the product imports it, and it is deliberately not wired into any path.
 *
 * Safety rules baked in here (not configuration):
 * - it only ever talks to the CDP endpoint it is given, which must be loopback;
 * - it runs with AGENT_BROWSER_NO_VERSION_CHECK=1 so no request leaves the box;
 * - it never passes `--auto-connect`/`--profile`, so it cannot attach to a
 *   browser we did not start.
 */
import { spawn } from 'node:child_process'

export interface DelegateOptions {
  /** Path to the `agent-browser` binary. */
  bin: string
  /** CDP endpoint of the browser we started, e.g. `http://127.0.0.1:9222`. */
  cdpUrl: string
  /** Session name — one daemon per session, so keep it stable per binding. */
  session: string
  /** Per-command ceiling. The CLI's own default is larger; we cap below it. */
  timeoutMs?: number
}

/** The three ops, in the shape the recipes actually need them. */
export type DelegateOp =
  | { id: number; op: 'find'; selector: string }
  | { id: number; op: 'click'; selector: string }
  | { id: number; op: 'fill'; selector: string; text: string }

/**
 * Same fields as `RelayReply` in `src/cdp-binding/ops.ts`.
 * `swMs` is filled with the CLI's wall time here (see the report for why that
 * is not the same measurement).
 */
export interface DelegatedReceipt {
  id: number
  result?: unknown
  error?: string
  swMs: number
}

export interface AgentBrowserDelegate {
  call(op: DelegateOp): Promise<DelegatedReceipt>
}

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  ms: number
  timedOut: boolean
}

function runCli(bin: string, args: string[], timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_BROWSER_NO_VERSION_CHECK: '1' },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (b) => (stdout += String(b)))
    child.stderr.on('data', (b) => (stderr += String(b)))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: performance.now() - started, timedOut })
    })
  })
}

/** `http://127.0.0.1:9222` → `9222`; anything not loopback is refused. */
export function cdpPortOf(cdpUrl: string): string {
  const u = new URL(cdpUrl)
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') {
    throw new Error(`delegate refuses a non-loopback CDP endpoint: ${u.hostname}`)
  }
  return u.port
}

export function makeAgentBrowserDelegate(opts: DelegateOptions): AgentBrowserDelegate {
  const port = cdpPortOf(opts.cdpUrl)
  const timeoutMs = opts.timeoutMs ?? 20_000
  const base = ['--cdp', port, '--session', opts.session]

  type InvokeResult = { parsed?: { success?: boolean; data?: unknown; error?: string } | null; error?: string; raw: CliResult }
  const invoke = async (args: string[]): Promise<InvokeResult> => {
    const raw = await runCli(opts.bin, [...base, ...args, '--json'], timeoutMs)
    if (raw.timedOut) return { error: `agent-browser ${args[0]} timed out after ${timeoutMs}ms`, raw }
    let parsed: { success?: boolean; data?: unknown; error?: string } | null = null
    try {
      const body = JSON.parse(raw.stdout) as { success?: boolean; data?: unknown; error?: string }
      parsed = body
    } catch {
      /* not JSON: fall through to stderr */
    }
    if (raw.code !== 0) {
      const detail = parsed?.error ?? (raw.stderr.trim() || raw.stdout.trim() || `exit ${raw.code}`)
      return { error: String(detail), raw }
    }
    return { parsed, raw }
  }

  return {
    async call(op) {
      const result = async (run: () => Promise<InvokeResult>) => {
        const r = await run()
        const swMs = Math.round(r.raw.ms)
        if (r.error) return { id: op.id, error: r.error, swMs }
        return { id: op.id, result: r.parsed?.data ?? null, swMs }
      }
      switch (op.op) {
        case 'find':
          // "Found" for the recipes means: at least one element matches, and it is
          // the kind of element a person could act on. The CLI splits those two
          // answers across `get count` and `is visible`, and with `--json` the
          // answer sits under `data.count` / `data.visible` next to a `lifecycle`
          // block that is not part of the answer.
          return result(async () => {
            const count = await invoke(['get', 'count', op.selector])
            if (count.error) return count
            const n = fieldNumber(count.parsed?.data, 'count')
            if (n === null) {
              // A shape change here must not be read as "found": that is exactly how
              // a silent false success starts.
              return { error: `get count returned an unexpected shape: ${short(count.parsed?.data)}`, raw: count.raw }
            }
            if (n <= 0) return { parsed: { success: true, data: { found: false, count: 0 } }, raw: count.raw }
            const visible = await invoke(['is', 'visible', op.selector])
            if (visible.error) return visible
            const vis = fieldBool(visible.parsed?.data, 'visible')
            if (vis === null) {
              return { error: `is visible returned an unexpected shape: ${short(visible.parsed?.data)}`, raw: visible.raw }
            }
            return { parsed: { success: true, data: { found: vis, count: n } }, raw: visible.raw }
          })
        case 'click':
          return result(async () => {
            const r = await invoke(['click', op.selector])
            if (r.error) return r
            return { parsed: { success: true, data: { clicked: true } }, raw: r.raw }
          })
        case 'fill':
          return result(async () => {
            const r = await invoke(['fill', op.selector, op.text])
            if (r.error) return r
            return { parsed: { success: true, data: { filled: true } }, raw: r.raw }
          })
        default: {
          const never: never = op
          throw new Error(`unknown delegate op: ${JSON.stringify(never)}`)
        }
      }
    },
  }
}

/** The receipt shape the relay uses, for the field-by-field comparison in the test. */
export const RELAY_RECEIPT_KEYS = ['id', 'result', 'error', 'swMs'] as const

/** `data.count` when it is a number, else null (a shape change, never a guess). */
function fieldNumber(data: unknown, key: string): number | null {
  if (typeof data === 'number') return data
  if (data && typeof data === 'object' && typeof (data as Record<string, unknown>)[key] === 'number') {
    return (data as Record<string, number>)[key]!
  }
  return null
}

/** `data.visible` when it is a boolean, else null. */
function fieldBool(data: unknown, key: string): boolean | null {
  if (typeof data === 'boolean') return data
  if (data && typeof data === 'object' && typeof (data as Record<string, unknown>)[key] === 'boolean') {
    return (data as Record<string, boolean>)[key]!
  }
  return null
}

function short(v: unknown): string {
  return JSON.stringify(v)?.slice(0, 120) ?? String(v)
}
