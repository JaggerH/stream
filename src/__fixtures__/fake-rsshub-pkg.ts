/**
 * Test fixture — a stand-in for RSSHub's lib/pkg.ts (exports init + request). Loaded by the REAL
 * rsshub-worker harness (via workerData.pkgPath) so rsshub-worker.integration.test.ts can exercise
 * the harness end-to-end — import mechanism, React shim, env application, init/request routing —
 * with no RSSHub checkout and no network.
 *
 * request() reports things only observable from INSIDE the worker, so the test can assert the
 * harness set them up before the pkg ran:
 *   - hasReact: the harness installs globalThis.React (hono/jsx) before importing pkg
 *   - cookie:   init() copied env into the worker's process.env
 */
let initCount = 0

export async function init(): Promise<void> {
  initCount += 1
}

export async function request(path: string): Promise<unknown> {
  if (path === '__throw__') throw new Error('fake pkg boom')
  return {
    title: `fake feed for ${path}`,
    item: [{ title: `item for ${path}`, link: `https://example.test/${path}` }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hasReact: typeof (globalThis as any).React?.createElement === 'function',
    cookie: process.env.FAKE_COOKIE ?? null,
    initCount,
  }
}
