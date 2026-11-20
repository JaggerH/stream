/**
 * Receipt-shape test for the delegation prototype.
 *
 * It answers three questions with running code:
 * 1. can `find` / `click` / `fill` be expressed through the external CLI against
 *    a browser we started (never the user's), and
 * 2. does the answer fit `RelayReply` (`{id, result?, error?, swMs}`), and
 * 3. does an action a person could not perform come back as an error rather
 *    than as a success.
 *
 * Skips, with the reason printed, when the browser or the CLI is not installed —
 * a silent skip would read as "this passed".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import {
  AGENT_BROWSER_BIN,
  CHROME,
  runCli,
  startChromium,
  startFixtureServer,
  type TestBrowser,
} from './harness.ts'
import { cdpPortOf, makeAgentBrowserDelegate, RELAY_RECEIPT_KEYS, type AgentBrowserDelegate } from './delegate.ts'

const hasBrowser = existsSync(CHROME)
const hasCli = existsSync(AGENT_BROWSER_BIN)
const skipReason = !hasBrowser
  ? `no Chromium at ${CHROME}`
  : !hasCli
    ? `no agent-browser at ${AGENT_BROWSER_BIN}`
    : null
if (skipReason) console.warn(`[agent-browser-delegate] ${skipReason} — skipping`)

const SESSION = `delegate-test-${process.pid}`
let browser: TestBrowser | null = null
let fixtures: Awaited<ReturnType<typeof startFixtureServer>> | null = null
let delegate: AgentBrowserDelegate | null = null

/** Navigate the delegate's session to a fixture page. */
async function open(path: string): Promise<void> {
  const r = await runCli(AGENT_BROWSER_BIN, [
    '--cdp',
    String(browser!.port),
    '--session',
    SESSION,
    'open',
    `${fixtures!.base}${path}`,
  ])
  if (r.code !== 0) throw new Error(`open ${path} failed: ${r.err || r.out}`)
}

/** Read a value through the CLI itself, so the assertion is not checked by the code under test. */
async function getText(selector: string): Promise<string> {
  const r = await runCli(AGENT_BROWSER_BIN, [
    '--cdp',
    String(browser!.port),
    '--session',
    SESSION,
    'get',
    'text',
    selector,
  ])
  return r.out.trim()
}

beforeAll(async () => {
  if (skipReason) return
  browser = await startChromium()
  fixtures = await startFixtureServer()
  delegate = makeAgentBrowserDelegate({ bin: AGENT_BROWSER_BIN, cdpUrl: browser.cdpUrl, session: SESSION })
  await open('/form') // start the daemon once, outside the timed assertions
}, 60_000)

afterAll(async () => {
  if (!skipReason) {
    await runCli(AGENT_BROWSER_BIN, ['--session', SESSION, 'close', '--all']).catch(() => null)
  }
  await browser?.close()
  await fixtures?.close()
})

describe.skipIf(skipReason)('agent-browser delegation prototype', () => {
  it('refuses a CDP endpoint that is not loopback', () => {
    expect(() => cdpPortOf('http://10.0.0.5:9222')).toThrow(/non-loopback/)
    expect(cdpPortOf('http://127.0.0.1:9222')).toBe('9222')
  })

  it('find reports presence and count for a selector', async () => {
    await open('/form')
    const hit = await delegate!.call({ id: 1, op: 'find', selector: '#name' })
    expect(hit.error).toBeUndefined()
    expect(hit.result).toEqual({ found: true, count: 1 })
    const missing = await delegate!.call({ id: 2, op: 'find', selector: '#nope' })
    expect(missing.error).toBeUndefined()
    expect(missing.result).toEqual({ found: false, count: 0 })
  })

  it('fill replaces the field text (not appends)', async () => {
    await delegate!.call({ id: 3, op: 'fill', selector: '#name', text: 'Ada' })
    await delegate!.call({ id: 4, op: 'fill', selector: '#name', text: 'Ada Lovelace' })
    // Read the value back through the CLI, not through the delegate.
    const value = await runCli(AGENT_BROWSER_BIN, [
      '--cdp',
      String(browser!.port),
      '--session',
      SESSION,
      'get',
      'value',
      '#name',
    ])
    expect(value.out.trim()).toBe('Ada Lovelace')
  })

  it('a click a person could not perform is an error, not a success', async () => {
    await open('/states')
    const disabled = await delegate!.call({ id: 10, op: 'click', selector: '#off' })
    expect(disabled.error).toMatch(/disabled/i)
    const hidden = await delegate!.call({ id: 11, op: 'click', selector: '#ghost' })
    expect(hidden.error).toMatch(/not visible/i)
    await open('/overlay')
    const covered = await delegate!.call({ id: 12, op: 'click', selector: '#next' })
    expect(covered.error).toMatch(/covered by/i)
  })

  it('missing selector is an error for click and fill (no silent no-op)', async () => {
    const click = await delegate!.call({ id: 20, op: 'click', selector: '#nope' })
    expect(click.error).toMatch(/not found/i)
    const fill = await delegate!.call({ id: 21, op: 'fill', selector: '#nope', text: 'x' })
    expect(fill.error).toMatch(/not found/i)
  })

  it('the receipt carries only the relay receipt fields', async () => {
    await open('/form')
    const ok = await delegate!.call({ id: 30, op: 'find', selector: '#name' })
    for (const k of Object.keys(ok)) expect(RELAY_RECEIPT_KEYS).toContain(k)
    expect(ok.error).toBeUndefined()
    expect(typeof ok.swMs).toBe('number')
    expect(ok.id).toBe(30)

    // The relay folds a failure into `error` with no result; so does the delegate.
    const bad = await delegate!.call({ id: 31, op: 'click', selector: '#nope' })
    for (const k of Object.keys(bad)) expect(RELAY_RECEIPT_KEYS).toContain(k)
    expect(bad.result).toBeUndefined()
    expect(typeof bad.error).toBe('string')
  })

  it('delegated actions land: the completed form shows the name', async () => {
    await open('/form')
    await delegate!.call({ id: 40, op: 'fill', selector: '#name', text: 'Ada Lovelace' })
    await delegate!.call({ id: 41, op: 'fill', selector: '#email', text: 'ada@example.invalid' })
    await delegate!.call({ id: 42, op: 'fill', selector: '#msg', text: 'hello' })
    const sent = await delegate!.call({ id: 43, op: 'click', selector: '#send' })
    expect(sent.error).toBeUndefined()
    expect(await getText('#ok')).toContain('Ada Lovelace')
  })

  it('attaching does not take ownership of the browser', () => {
    expect(() => process.kill(browser!.pid, 0)).not.toThrow()
  })
})
