import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RsshubClient } from './rsshub-client.ts'

/**
 * The REAL rsshub-worker harness, driven by RsshubClient, against a fake pkg (no RSSHub, no
 * network — deterministic, runs in CI). Proves the four things the harness is responsible for:
 * loading pkg from workerData.pkgPath, installing the React global BEFORE pkg runs, applying env
 * to the worker's process.env on init, and turning a pkg throw into a rejected request.
 *
 * (An opt-in smoke test against the real RSSHub checkout lives in
 * rsshub-worker.live.integration.test.ts, gated on STREAM_LIVE.)
 */
const HARNESS = new URL('./rsshub-worker.ts', import.meta.url)
const FAKE_PKG = fileURLToPath(new URL('./__fixtures__/fake-rsshub-pkg.ts', import.meta.url))

let client: RsshubClient | null = null
let checkoutDir: string | null = null
const make = () => {
  client = new RsshubClient({ entry: HARNESS, pkgPath: FAKE_PKG })
  return client
}
afterEach(async () => {
  await client?.dispose()
  client = null
  if (checkoutDir) rmSync(checkoutDir, { recursive: true, force: true })
  checkoutDir = null
})

describe('rsshub-worker harness (fake pkg)', () => {
  it('loads a checkout using its own tsconfig aliases rather than the host config', async () => {
    checkoutDir = mkdtempSync(join(tmpdir(), 'stream-rsshub-checkout-'))
    writeFileSync(join(checkoutDir, 'package.json'), JSON.stringify({ type: 'module' }))
    mkdirSync(join(checkoutDir, 'lib'))
    writeFileSync(join(checkoutDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { paths: { '@/*': ['./lib/*'] } },
    }))
    writeFileSync(join(checkoutDir, 'lib', 'feed.ts'), 'export const title = "checkout feed"')
    writeFileSync(join(checkoutDir, 'lib', 'pkg.ts'),
      'import { title } from "@/feed"; export async function init() {} export async function request() { return { title, item: [] } }')
    client = new RsshubClient({ entry: HARNESS, pkgPath: join(checkoutDir, 'lib', 'pkg.ts') })
    await expect(client.request('/feed')).resolves.toEqual({ title: 'checkout feed', item: [] })
  })

  it('loads pkg from workerData.pkgPath and returns its Data object', async () => {
    const data = (await make().request('bilibili/user/dynamic/2267573')) as { title: string; item: unknown[] }
    expect(data.title).toBe('fake feed for bilibili/user/dynamic/2267573')
    expect(data.item).toHaveLength(1)
  })

  it('installs the React global before importing pkg (JSX routes need it)', async () => {
    const data = (await make().request('any/route')) as { hasReact: boolean }
    expect(data.hasReact).toBe(true)
  })

  it('applies init env to the worker process.env (cookie hot-reload)', async () => {
    const c = make()
    // Cookieless first — a public route path.
    expect(((await c.request('public/route')) as { cookie: string | null }).cookie).toBeNull()
    // A cookie arrives later; init must land it in the worker so the next request sees it.
    await c.init({ FAKE_COOKIE: 'sess=xyz' })
    expect(((await c.request('private/route')) as { cookie: string | null }).cookie).toBe('sess=xyz')
  })

  it('turns a pkg throw into a rejected request, not a crash', async () => {
    const c = make()
    await expect(c.request('__throw__')).rejects.toThrow('fake pkg boom')
    // Worker survives — a normal request still works.
    expect(((await c.request('ok')) as { title: string }).title).toBe('fake feed for ok')
  })
})
