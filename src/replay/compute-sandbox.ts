import crypto from 'node:crypto'
import type IvmModule from 'isolated-vm' // type-only：build 期擦除，不产生运行时加载

/**
 * The compute hook: run a recipe-authored PURE snippet in an isolated-vm heap that has
 * NOTHING — no fetch, no process, no crypto, no require, no host globals. It can only call
 * the pure-function capabilities the host explicitly injects by name (a WHITELIST), and it
 * only ever returns a JSON value. I/O stays in the engine; the sandbox computes.
 *
 * This is what lets a shared recipe carry code safely: a hostile author still cannot reach
 * the host, exfiltrate a cookie, or spin forever — isolation, a heap cap, and a wall-clock
 * timeout are all enforced by the VM, not by trusting the code.
 */

/** A capability = a host-implemented pure function the sandbox may call by name. It takes
 *  JSON in, returns JSON out; it must not close over I/O, secrets, or mutable host state. */
type Capability = (...args: unknown[]) => unknown

/** The whitelist. Adding a name here is a security decision — it must stay a pure function
 *  of its arguments (no network, no fs, no ambient secret), because the sandbox can call it
 *  with any arguments an untrusted snippet chooses. */
const CAPABILITIES: Record<string, Capability> = {
  hmacSha256: (secret, msg) =>
    crypto.createHmac('sha256', String(secret)).update(String(msg)).digest('hex'),
  md5: (msg) => crypto.createHash('md5').update(String(msg)).digest('hex'),
  sha256: (msg) => crypto.createHash('sha256').update(String(msg)).digest('hex'),
  /** AES-256-GCM decrypt of a base64 {key,iv,ciphertext,tag} envelope → plaintext string. */
  aesGcmDecrypt: (env) => {
    const e = env as { key: string; iv: string; ciphertext: string; tag: string }
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(e.key, 'base64'), Buffer.from(e.iv, 'base64'))
    d.setAuthTag(Buffer.from(e.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(e.ciphertext, 'base64')), d.final()]).toString('utf8')
  },
  base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
  base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
}

export type CapabilityName = keyof typeof CAPABILITIES

/** The capability whitelist as a plain name set — for load-time validation of a recipe's
 *  declared `compute.capabilities` without importing the implementations. */
export const COMPUTE_CAPABILITIES: Record<string, true> = Object.fromEntries(
  Object.keys(CAPABILITIES).map((k) => [k, true]),
)

export class ComputeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComputeError'
  }
}

/**
 * isolated-vm 是原生 addon，且 tier-0 boot **不**依赖它（desktop-packaging D-native）。首次 runCompute
 * 时才动态 import——这样一个不带 isolated-vm 的打包 core 仍能 boot；缺失时降级为清晰的 ComputeError，
 * 而非崩溃。加载失败会重置缓存的 promise，让下次重试（例如用户补装后无需重启）。
 */
let ivmPromise: Promise<typeof IvmModule> | undefined
async function loadIvm(): Promise<typeof IvmModule> {
  if (!ivmPromise) {
    ivmPromise = import('isolated-vm')
      .then((m) => (m.default ?? m) as unknown as typeof IvmModule)
      .catch((e) => {
        ivmPromise = undefined
        throw new ComputeError(
          `compute step 需要 "isolated-vm" 原生模块，但当前构建未安装它（${e instanceof Error ? e.message : String(e)}）`,
        )
      })
  }
  return ivmPromise
}

export interface ComputeSpec {
  /** the recipe-authored snippet; an expression whose value is the result. `input` and each
   *  declared capability are in scope. */
  code: string
  /** JSON payload the engine hands in (e.g. the key/ip/timestamp for a signature). */
  input: unknown
  /** which host capabilities this snippet may call. Anything not listed is absent. */
  capabilities: CapabilityName[]
  /** wall-clock cap; a CPU bomb is killed here. Default 500ms — a signature/decrypt is µs. */
  timeoutMs?: number
  /** heap cap in MB; a memory bomb is killed here. Default 32. */
  memoryMb?: number
}

/**
 * Run one compute snippet to a JSON value. Every failure — isolation breach attempt,
 * timeout, OOM, syntax error, a capability throwing — surfaces as ComputeError so the
 * caller treats it as recipe failure, never a host crash.
 */
export async function runCompute(spec: ComputeSpec): Promise<unknown> {
  for (const c of spec.capabilities) {
    if (!(c in CAPABILITIES)) throw new ComputeError(`unknown capability "${String(c)}"`)
  }

  const ivm = await loadIvm()
  const iso = new ivm.Isolate({ memoryLimit: spec.memoryMb ?? 32 })
  try {
    const ctx = await iso.createContext()
    const jail = ctx.global

    // Hand in the input as a deep copy (no live host reference crosses the boundary).
    await jail.set('input', new ivm.ExternalCopy(spec.input).copyInto())

    // Inject ONLY the declared capabilities, each as an ivm.Callback: a plain sync function
    // the snippet calls directly. isolated-vm structure-clones args in and the return value
    // out, so the sandbox passes JSON and gets JSON — the host fn body never enters the heap.
    for (const name of spec.capabilities) {
      const fn = CAPABILITIES[name]
      await jail.set(name, new ivm.Callback((...args: unknown[]) => fn(...args) as never))
    }

    const result = await ctx.eval(`(${spec.code})`, { timeout: spec.timeoutMs ?? 500, copy: true })
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ComputeError(msg)
  } finally {
    iso.dispose()
  }
}
