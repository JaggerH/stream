/**
 * Shared plumbing for the browser-driver bench and its test: start a private
 * headless Chromium, serve the fixture pages, and run the external CLI.
 *
 * Every process started here is owned by the caller and must be closed; nothing
 * touches a browser or profile that already exists on the machine.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 16-hex card identity, the shape `src/replay/card-id.ts` keys on. */
export const hexId = (i: number) => i.toString(16).padStart(16, '0')

function resolveChrome(): string {
  const candidates = [
    process.env.AGENT_BROWSER_BENCH_CHROME,
    join(homedir(), '.cache/ms-playwright/chromium-1255/chrome-linux-arm64/chrome'),
    join(homedir(), '.cache/ms-playwright/chromium-1255/chrome-linux/chrome'),
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean) as string[]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error('no Chromium found; set AGENT_BROWSER_BENCH_CHROME')
}

export const CHROME = resolveChrome()
export const AGENT_BROWSER_BIN =
  process.env.AGENT_BROWSER_BIN ?? join(homedir(), '.local/ab-bench/node_modules/.bin/agent-browser')

export interface TestBrowser {
  cdpUrl: string
  port: number
  pid: number
  close(): Promise<void>
}

export async function startChromium(): Promise<TestBrowser> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'ab-bench-chromium-'))
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
  )
  child.unref()
  const pid = child.pid ?? 0
  const portFile = join(userDataDir, 'DevToolsActivePort')
  let port = 0
  for (let i = 0; i < 800 && !port; i++) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? ''
      if (/^\d+$/.test(first)) port = Number(first)
    }
    await sleep(25)
  }
  if (!port) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
    rmSync(userDataDir, { recursive: true, force: true })
    throw new Error('Chromium did not write DevToolsActivePort')
  }
  const cdpUrl = `http://127.0.0.1:${port}`
  for (let i = 0; i < 400; i++) {
    try {
      if ((await fetch(`${cdpUrl}/json/version`)).ok) break
    } catch {
      /* not listening yet */
    }
    await sleep(25)
  }
  return {
    cdpUrl,
    port,
    pid,
    async close() {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      await sleep(150)
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

export async function startFixtureServer(): Promise<{ base: string; close(): Promise<void> }> {
  const child = spawn(process.execPath, [join(here, 'server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<number>((res, rej) => {
    const t = setTimeout(() => rej(new Error('fixture server did not print a port in 10s')), 10_000)
    child.stdout!.on('data', (b: Buffer) => {
      const m = /"port":\s*(\d+)/.exec(String(b))
      if (m) {
        clearTimeout(t)
        res(Number(m[1]))
      }
    })
  })
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      child.kill('SIGKILL')
    },
  }
}

export interface CliResult {
  code: number | null
  out: string
  err: string
  ms: number
}

export function runCli(cmd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((res) => {
    const started = performance.now()
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_BROWSER_NO_VERSION_CHECK: '1' },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout!.on('data', (b) => (out += String(b)))
    child.stderr!.on('data', (b) => (err += String(b)))
    child.on('close', (code) => {
      clearTimeout(timer)
      res({ code, out, err, ms: performance.now() - started })
    })
  })
}

/** RSS of every agent-browser process currently alive (the session daemon). */
export function agentBrowserRss(): Array<{ pid: string; rssKb: number }> {
  const out: Array<{ pid: string; rssKb: number }> = []
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
      if (!cmd.includes('agent-browser-linux')) continue
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      if (m) out.push({ pid, rssKb: Number(m[1]) })
    } catch {
      /* raced with exit */
    }
  }
  return out
}
