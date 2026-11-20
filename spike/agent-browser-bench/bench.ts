/**
 * Browser-driver comparison bench: what the shipped browser recipes do today over
 * the CDP binding (in-process relay ops + the shared page driver) vs. the same
 * tasks delegated to an external `agent-browser` CLI attached to the same
 * Chromium with `--cdp`.
 *
 * Run with:  pnpm exec tsx spike/agent-browser-bench/bench.ts [--iterations N]
 *
 * Everything is local: a headless Chromium from the playwright cache (or
 * AGENT_BROWSER_BENCH_CHROME), a fixture server on 127.0.0.1, and a throwaway
 * profile per run. Nothing touches the user's browser or any real account.
 * The script cleans up every process it starts, including the external CLI's
 * daemon, on both the success and the failure path.
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  AGENT_BROWSER_BIN as AB,
  CHROME,
  agentBrowserRss,
  hexId,
  here,
  runCli,
  sleep,
  startChromium,
  startFixtureServer,
} from './harness.ts'

import { CdpConnection } from '../../src/cdp-binding/cdp-connection.ts'
import { CdpRelayOps } from '../../src/cdp-binding/ops.ts'
import { makeExtRawPage, type RawPageRelay } from '../../shared/browser-relay/ext-page.ts'
import { waitForSelector } from '../../shared/browser-relay/page-driver.ts'
import { makeExtPageDriver } from '../../src/replay/browser-ext-drive.ts'
import { locateCard } from '../../src/replay/actions.ts'

const SESSION = `bench-${process.pid}`

/** Poll the URL until it ends with `suffix` (navigation is async on both paths). */
async function waitUrl(driver: { currentUrl?: () => Promise<string> }, suffix: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let url = (await driver.currentUrl?.().catch(() => '')) ?? ''
  while (!url.endsWith(suffix) && Date.now() < deadline) {
    await sleep(100)
    url = (await driver.currentUrl?.().catch(() => '')) ?? url
  }
  return url
}

const iterations = (() => {
  const i = process.argv.indexOf('--iterations')
  return i > 0 ? Number(process.argv[i + 1]) || 3 : 3
})()

interface Step {
  name: string
  ms: number
  ok: boolean
  detail?: string
}
interface TaskResult {
  task: string
  path: 'relay' | 'delegate'
  ok: boolean
  steps: Step[]
  detail?: string
}

// ── processes ────────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void> | void> = []
async function cleanupAll() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn()
    } catch {
      /* cleanup must not mask the result */
    }
  }
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void cleanupAll().then(() => process.exit(130))
  })
}


/** One `agent-browser` command against the shared Chromium. */
function ab(args: string[]) {
  return runCli(AB, ['--cdp', String(sharedPort), '--session', SESSION, ...args])
}

// ── relay path (what the product does today) ─────────────────────────────────

let sharedPort = 0

function makeRelay(ops: CdpRelayOps, tabId: number): RawPageRelay {
  let id = 1
  return {
    async sendCommand(_tabId, method, params, expectDomain, sessionId) {
      const msg = {
        id: id++,
        tabId,
        method,
        params,
        ...(expectDomain ? { expectDomain } : {}),
        ...(sessionId ? { sessionId } : {}),
      }
      const reply = await ops.dispatch(msg)
      if (!reply) throw new Error(`no receipt for ${method}`)
      if (reply.error) throw new Error(reply.error)
      return reply.result
    },
  }
}

async function openTab(ops: CdpRelayOps, url: string): Promise<number> {
  const reply = await ops.dispatch({ id: 1, op: 'newTab', url, waitUntil: 'load' })
  if (!reply || reply.error) throw new Error(reply?.error ?? 'newTab: no receipt')
  return (reply.result as { tabId: number }).tabId
}

// ── tasks ────────────────────────────────────────────────────────────────────

const TASKS = ['search-read', 'form-fill', 'feed-locate', 'overlay', 'churn', 'states'] as const
type TaskName = (typeof TASKS)[number]

interface Ctx {
  base: string
  ops: CdpRelayOps
}

async function relayTask(ctx: Ctx, task: TaskName): Promise<TaskResult> {
  const steps: Step[] = []
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now()
    try {
      const v = await fn()
      steps.push({ name, ms: performance.now() - t, ok: true })
      return v
    } catch (e) {
      steps.push({ name, ms: performance.now() - t, ok: false, detail: String(e instanceof Error ? e.message : e) })
      throw e
    }
  }
  const { base, ops } = ctx
  let tabId = 0
  try {
    switch (task) {
      case 'search-read': {
        tabId = await step('newTab', () => openTab(ops, `${base}/search?q=agent-browser`))
        const driver = makeExtPageDriver(makeExtRawPage(makeRelay(ops, tabId), tabId))
        const items = await step('readItems', () =>
          driver.readItems!('#rso > div.card', {
            title: { selector: 'h3' },
            link: { selector: 'a[href]', attr: 'href' },
            snippet: { selector: '[data-sncf]' },
          }),
        )
        const ok = items.length === 10 && (items[0]!.title ?? '').includes('Result 1')
        const bytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
        return { task, path: 'relay', ok, steps, detail: `${items.length} items, ${bytes} B of item JSON` }
      }
      case 'form-fill': {
        tabId = await step('newTab', () => openTab(ops, `${base}/form`))
        const driver = makeExtPageDriver(makeExtRawPage(makeRelay(ops, tabId), tabId))
        await step('type#name', () => driver.type('#name', 'Ada Lovelace'))
        await step('type#email', () => driver.type('#email', 'ada@example.invalid'))
        await step('type#msg', () => driver.type('#msg', 'hello from the bench'))
        await step('click#send', () => driver.click('#send'))
        const text = await step('read#ok', () => driver.evalJson!('document.getElementById("ok").textContent'))
        const ok = String(text).includes('Ada Lovelace')
        return { task, path: 'relay', ok, steps, detail: String(text) }
      }
      case 'feed-locate': {
        tabId = await step('newTab', () => openTab(ops, `${base}/feed`))
        const driver = makeExtPageDriver(makeExtRawPage(makeRelay(ops, tabId), tabId))
        // The feed lands the last ten cards at 1.5s; a recipe waits on its expect
        // before acting, so both paths start from the same fully rendered page.
        await step('waitCard30', () => waitForSelector(driver, 'a.card[data-id="30"]', { timeout: 6000 }))
        const ids = Array.from({ length: 30 }, (_, i) => hexId(i + 1))
        const located = await step('locateCard(27)', () => locateCard(driver, 'a.card', ids, hexId(27)))
        const found = await step('openTarget(27)', () => driver.openTarget!('a.card', hexId(27)))
        const url = await step('waitUrl', () => waitUrl(driver, `/explore/${hexId(27)}`))
        const ok = located === true && found === true && url.endsWith(`/explore/${hexId(27)}`)
        return { task, path: 'relay', ok, steps, detail: url }
      }
      case 'overlay': {
        tabId = await step('newTab', () => openTab(ops, `${base}/overlay`))
        const driver = makeExtPageDriver(makeExtRawPage(makeRelay(ops, tabId), tabId))
        const returned = await step('click#next(covered)', () => driver.click('#next'))
        const title = await step('readTitle', () => driver.evalJson!('document.title'))
        // A click that lands on the banner leaves the page title alone; the driver
        // still reports success. That is the false-success case under test.
        const ok = returned === true && String(title) === 'page 2'
        return {
          task,
          path: 'relay',
          ok,
          steps,
          detail: `click returned ${String(returned)}, title "${String(title)}"`,
        }
      }
      case 'churn': {
        tabId = await step('newTab', () => openTab(ops, `${base}/churn`))
        const driver = makeExtPageDriver(makeExtRawPage(makeRelay(ops, tabId), tabId))
        await sleep(1000) // the re-render lands at 800ms
        const clicked = await step('click(.row[data-id=3])', () => driver.click('.row[data-id="3"]'))
        const log = await step('read#clicked', () => driver.evalJson!('document.getElementById("clicked").textContent'))
        const ok = clicked === true && String(log) === 'clicked 3'
        return { task, path: 'relay', ok, steps, detail: String(log) }
      }
      case 'states': {
        tabId = await step('newTab', () => openTab(ops, `${base}/states`))
        const driver = makeExtPageDriver(makeExtRawPage(makeRelay(ops, tabId), tabId))
        const off = await step('click#off(disabled)', () => driver.click('#off'))
        const ghost = await step('click#ghost(hidden)', () => driver.click('#ghost'))
        const log = await step('read#log', () => driver.evalJson!('document.getElementById("log").textContent'))
        // Fails the task on purpose when the driver reports success for
        // elements a person could not click — that is the finding.
        const ok = off !== true && ghost !== true && String(log) === ''
        return {
          task,
          path: 'relay',
          ok,
          steps,
          detail: `disabled=${String(off)} hidden=${String(ghost)} log="${String(log)}"`,
        }
      }
    }
    return { task, path: 'relay', ok: false, steps, detail: `unknown task: ${task}` }
  } catch (e) {
    return { task, path: 'relay', ok: false, steps, detail: String(e instanceof Error ? e.message : e) }
  } finally {
    if (tabId) await ops.dispatch({ id: 99_999, op: 'closeTab', tabId }).catch(() => null)
  }
}

async function delegateTask(ctx: Ctx, task: TaskName): Promise<TaskResult> {
  const steps: Step[] = []
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now()
    try {
      const v = await fn()
      steps.push({ name, ms: performance.now() - t, ok: true })
      return v
    } catch (e) {
      steps.push({ name, ms: performance.now() - t, ok: false, detail: String(e instanceof Error ? e.message : e) })
      throw e
    }
  }
  const { base } = ctx
  const cli = async (name: string, args: string[]) =>
    step(name, async () => {
      const r = await ab(args)
      if (r.code !== 0) throw new Error(`agent-browser ${args[0]} exited ${r.code}: ${(r.err || r.out).trim()}`)
      return r.out
    })
  try {
    switch (task) {
      case 'search-read': {
        await cli('open', ['open', `${base}/search?q=agent-browser`])
        const snap = await cli('snapshot -i', ['snapshot', '-i'])
        const read = await cli('read', ['read'])
        const titles = snap.match(/"Result \d+ — a distinctive title[^"]*"/g) ?? []
        const ok = titles.length >= 10 && read.includes('Result 10')
        return { task, path: 'delegate', ok, steps, detail: `${titles.length} result titles in snapshot` }
      }
      case 'form-fill': {
        await cli('open', ['open', `${base}/form`])
        await cli('fill#name', ['fill', '#name', 'Ada Lovelace'])
        await cli('fill#email', ['fill', '#email', 'ada@example.invalid'])
        await cli('fill#msg', ['fill', '#msg', 'hello from the bench'])
        await cli('click#send', ['click', '#send'])
        const text = await cli('get text #ok', ['get', 'text', '#ok'])
        const ok = text.includes('Ada Lovelace')
        return { task, path: 'delegate', ok, steps, detail: text.trim() }
      }
      case 'feed-locate': {
        await cli('open', ['open', `${base}/feed`])
        await cli('wait card30', ['wait', 'a.card[data-id="30"]'])
        await cli('click a[data-id=27]', ['click', 'a[data-id="27"]'])
        await cli('wait url', ['wait', '--url', `**/explore/${hexId(27)}`])
        const url = await cli('get url', ['get', 'url'])
        const ok = url.trim().endsWith(`/explore/${hexId(27)}`)
        return { task, path: 'delegate', ok, steps, detail: url.trim() }
      }
      case 'overlay': {
        await cli('open', ['open', `${base}/overlay`])
        let blocked = ''
        try {
          await cli('click#next(covered)', ['click', '#next'])
        } catch (e) {
          blocked = String(e instanceof Error ? e.message : e)
        }
        if (!blocked) return { task, path: 'delegate', ok: false, steps, detail: 'covered click did not fail' }
        await cli('click#accept', ['click', '#accept'])
        await cli('click#next(retry)', ['click', '#next'])
        const title = await cli('get title', ['get', 'title'])
        const ok = title.trim() === 'page 2'
        return { task, path: 'delegate', ok, steps, detail: `blocked once (${blocked.slice(0, 90)}…), then ${title.trim()}` }
      }
      case 'churn': {
        await cli('open', ['open', `${base}/churn`])
        const snap = JSON.parse(await cli('snapshot -i --json', ['snapshot', '-i', '--json'])) as {
          data?: { refs?: Record<string, { name?: string; role?: string }> }
        }
        const ref = Object.entries(snap.data?.refs ?? {}).find(([, v]) => v.name === 'Row 3')?.[0]
        if (!ref) return { task, path: 'delegate', ok: false, steps, detail: 'Row 3 ref not found in snapshot' }
        await sleep(1000) // nodes are replaced at 800ms
        let stale = ''
        try {
          await cli(`click @${ref}(stale)`, ['click', `@${ref}`])
        } catch (e) {
          stale = String(e instanceof Error ? e.message : e)
        }
        const log = await cli('get text #clicked', ['get', 'text', '#clicked']).catch(() => '')
        const staleActed = String(log).includes('clicked 3')
        // Even when the stale ref still acts, the flow after a DOM change is
        // "snapshot again": measure what that costs.
        const snap2 = JSON.parse(await cli('snapshot -i --json (re-locate)', ['snapshot', '-i', '--json'])) as {
          data?: { refs?: Record<string, { name?: string; role?: string }> }
        }
        const ref2 = Object.entries(snap2.data?.refs ?? {}).find(([, v]) => v.name === 'Row 3')?.[0]
        let recovered = false
        if (ref2) {
          await cli(`click @${ref2}(fresh)`, ['click', `@${ref2}`])
          recovered = (await cli('get text #clicked', ['get', 'text', '#clicked'])).includes('clicked 3')
        }
        const ok = staleActed || recovered
        return {
          task,
          path: 'delegate',
          ok,
          steps,
          detail: `${stale ? `stale ref failed (${stale.slice(0, 70)}…)` : 'stale ref acted'}; fresh ref ${ref2 ?? 'missing'}`,
        }
      }
      case 'states': {
        await cli('open', ['open', `${base}/states`])
        const results: string[] = []
        let ok = true
        for (const [sel, what] of [
          ['#off', 'disabled'],
          ['#ghost', 'hidden'],
        ] as const) {
          try {
            await cli(`click${sel}(${what})`, ['click', sel])
            ok = false
            results.push(`${what}: acted`)
          } catch (e) {
            results.push(`${what}: failed — ${String(e instanceof Error ? e.message : e).slice(0, 120)}`)
          }
        }
        const log = await cli('read#log', ['get', 'text', '#log']).catch(() => '')
        ok = ok && !String(log).includes('clicked')
        return { task, path: 'delegate', ok, steps, detail: results.join(' | ') }
      }
    }
  } catch (e) {
    return { task, path: 'delegate', ok: false, steps, detail: String(e instanceof Error ? e.message : e) }
  }
}

// ── measurements ─────────────────────────────────────────────────────────────


async function main() {
  if (!existsSync(AB)) throw new Error(`no agent-browser at ${AB} (set AGENT_BROWSER_BIN)`)
  const version = (await runCli(AB, ['--version'])).out.trim()
  const chromeVersion = (await runCli(CHROME, ['--version'])).out.trim()

  const fixture = await startFixtureServer()
  cleanups.push(() => fixture.close())
  const browser = await startChromium()
  cleanups.push(() => browser.close())
  sharedPort = browser.port

  // Relay side: one CDP connection shared by every task, one tab per task.
  const connectStarted = performance.now()
  const cdp = await CdpConnection.connect(browser.cdpUrl)
  const ops = new CdpRelayOps(cdp)
  const connectMs = performance.now() - connectStarted
  cleanups.push(async () => {
    ops.dispose()
  })
  // Close the external CLI's session first so nothing lingers on this browser.
  cleanups.push(async () => {
    await runCli(AB, ['--session', SESSION, 'close', '--all'])
  })

  const ctx: Ctx = { base: fixture.base, ops }

  // Cold start for the external CLI: no daemon yet for this session.
  const coldStarted = performance.now()
  const cold = await ab(['open', `${fixture.base}/search?q=cold`])
  const coldMs = performance.now() - coldStarted
  const warm: number[] = []
  for (let i = 0; i < 5; i++) {
    const r = await ab(['get', 'url'])
    warm.push(r.ms)
  }

  // Snapshot sizes on the same pages.
  const sizes: Array<{ page: string; kind: string; bytes: number; text: string }> = []
  for (const [page, url] of [
    ['search', `${fixture.base}/search?q=agent-browser`],
    ['feed', `${fixture.base}/feed`],
    ['form', `${fixture.base}/form`],
  ] as const) {
    await ab(['open', url])
    for (const [kind, args] of [
      ['snapshot -i', ['snapshot', '-i']],
      ['snapshot', ['snapshot']],
      ['snapshot -i --json', ['snapshot', '-i', '--json']],
      ['read', ['read']],
    ] as const) {
      const r = await ab([...args])
      sizes.push({ page, kind, bytes: Buffer.byteLength(r.out, 'utf8'), text: r.out.slice(0, 200) })
    }
  }
  const daemon = agentBrowserRss()

  // Task runs.
  const results: TaskResult[] = []
  for (let i = 0; i < iterations; i++) {
    for (const task of TASKS) {
      results.push(await relayTask(ctx, task))
      results.push(await delegateTask(ctx, task))
    }
  }

  // Does the external CLI ever relaunch or kill the browser it attached to?
  let browserSurvived = true
  try {
    process.kill(browser.pid, 0)
  } catch {
    browserSurvived = false
  }

  const report = {
    when: new Date().toISOString(),
    versions: { agentBrowser: version, chrome: chromeVersion, node: process.version },
    iterations,
    coldStartMs: coldMs,
    warmCommandMs: warm,
    relayConnectMs: connectMs,
    sizes,
    daemon,
    browserSurvivedAttach: browserSurvived,
    results,
  }
  const outDir = join(here, 'results')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ outFile, summary: summarize(report) }, null, 2))

  // Leave nothing running.
  await runCli(AB, ['--session', SESSION, 'close', '--all'])
  await cleanupAll()
}

function summarize(report: { results: TaskResult[] }) {
  const byKey = new Map<string, { task: string; path: string; runs: number; ok: number; ms: number[] }>()
  for (const r of report.results) {
    const key = `${r.path}:${r.task}`
    const row = byKey.get(key) ?? { task: r.task, path: r.path, runs: 0, ok: 0, ms: [] }
    row.runs++
    if (r.ok) row.ok++
    row.ms.push(r.steps.reduce((a: number, s: Step) => a + s.ms, 0))
    byKey.set(key, row)
  }
  return [...byKey.values()].map((r) => ({
    ...r,
    medianMs: median(r.ms),
    ms: Math.round(median(r.ms)),
  }))
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? Math.round(s[Math.floor(s.length / 2)]!) : 0
}

await main().catch(async (e) => {
  console.error('bench failed:', e)
  await cleanupAll()
  process.exit(1)
})
