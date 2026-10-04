/**
 * Test fixture — a stand-in for the real rsshub-worker harness that speaks the SAME
 * message protocol but echoes instead of calling RSSHub. Lets rsshub-client.test.ts exercise
 * the transport (correlation ids, concurrency, crash/respawn, env replay) deterministically,
 * with no RSSHub checkout and no network.
 *
 * Protocol (mirror of rsshub-worker.ts):
 *   in : { id, type:'init', env } | { id, type:'request', path }
 *   out: { id, ok:true, data? } | { id, ok:false, error }
 *
 * Magic request paths drive the failure modes the client must handle:
 *   __crash__  → process.exit(1)  (worker dies mid-flight)
 *   __error__  → { ok:false, error:'boom' }
 *   __slow__   → reply after 50ms (to interleave with a later fast request)
 *   __workerdata__ → echo back the workerData this worker was spawned with — that's how the test
 *                    proves the client re-resolves RSSHub at SPAWN time, not at construction.
 */
import { parentPort, workerData } from 'node:worker_threads'

// Remembered across messages so a 'request' can report the env a prior 'init' loaded — this is
// how the test proves the client replays accumulated env into a respawned worker.
const loadedEnv: Record<string, string> = {}

parentPort!.on('message', (msg: { id: number; type: string; path?: string; env?: Record<string, string> }) => {
  const { id, type } = msg
  if (type === 'init') {
    Object.assign(loadedEnv, msg.env ?? {})
    parentPort!.postMessage({ id, ok: true })
    return
  }
  if (type === 'request') {
    const path = msg.path ?? ''
    if (path === '__crash__') {
      process.exit(1)
      return
    }
    if (path === '__workerdata__') {
      parentPort!.postMessage({ id, ok: true, data: workerData })
      return
    }
    if (path === '__error__') {
      parentPort!.postMessage({ id, ok: false, error: 'boom' })
      return
    }
    if (path === '__slow__') {
      setTimeout(() => parentPort!.postMessage({ id, ok: true, data: { echo: path, env: { ...loadedEnv } } }), 50)
      return
    }
    parentPort!.postMessage({ id, ok: true, data: { echo: path, env: { ...loadedEnv } } })
    return
  }
  parentPort!.postMessage({ id, ok: false, error: `unknown type: ${type}` })
})
