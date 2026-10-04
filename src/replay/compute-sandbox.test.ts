import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { runCompute, ComputeError } from './compute-sandbox.ts'

describe('runCompute — the isolated-vm compute hook', () => {
  it('runs a pure snippet and returns its JSON value', async () => {
    const out = await runCompute({
      code: `({ doubled: input.n * 2, up: input.s.toUpperCase() })`,
      input: { n: 21, s: 'hi' },
      capabilities: [],
    })
    expect(out).toEqual({ doubled: 42, up: 'HI' })
  })

  // The whole security model: the sandbox has NOTHING. A shared recipe cannot reach the
  // host even if its author is hostile.
  it('denies the classic constructor escape to process', async () => {
    // reaching for process is blocked at the VM level → surfaces as ComputeError, never a value
    await expect(runCompute({
      code: `this.constructor.constructor('return process')().env`,
      input: {}, capabilities: [],
    })).rejects.toThrow(ComputeError)
  })

  it('has no ambient host globals', async () => {
    for (const probe of [`typeof require`, `typeof globalThis.fetch`, `typeof crypto`, `typeof process`]) {
      expect(await runCompute({ code: probe, input: {}, capabilities: [] })).toBe('undefined')
    }
  })

  it('kills a CPU-bomb via the timeout', async () => {
    await expect(runCompute({ code: `while(true){}`, input: {}, capabilities: [], timeoutMs: 200 }))
      .rejects.toThrow(ComputeError)
  })

  it('kills a memory-bomb via the heap limit', async () => {
    await expect(runCompute({
      code: `const a=[]; while(true) a.push(new Array(100000).fill(0));`,
      input: {}, capabilities: [], memoryMb: 16, timeoutMs: 2000,
    })).rejects.toThrow(ComputeError)
  })

  // Capabilities are a WHITELIST: a snippet can only call what it declared, and the host
  // decides what that name does. crypto never enters the sandbox — only its result does.
  it('exposes ONLY the declared capabilities', async () => {
    const withCap = await runCompute({
      code: `hmacSha256('secret', 'msg')`,
      input: {}, capabilities: ['hmacSha256'],
    })
    expect(withCap).toBe(crypto.createHmac('sha256', 'secret').update('msg').digest('hex'))

    // not declared → not present
    const without = await runCompute({ code: `typeof hmacSha256`, input: {}, capabilities: [] })
    expect(without).toBe('undefined')
  })

  it('rejects an unknown capability name at load, not silently', async () => {
    await expect(runCompute({ code: `1`, input: {}, capabilities: ['exfiltrate' as never] }))
      .rejects.toThrow(/unknown capability/)
  })

  it('provides aesGcmDecrypt for encrypted response envelopes', async () => {
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update('{"songs":[1,2]}', 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    const out = await runCompute({
      code: `JSON.parse(aesGcmDecrypt({ key: input.key, iv: input.iv, ciphertext: input.ct, tag: input.tag }))`,
      input: {
        key: key.toString('base64'), iv: iv.toString('base64'),
        ct: ct.toString('base64'), tag: tag.toString('base64'),
      },
      capabilities: ['aesGcmDecrypt'],
    })
    expect(out).toEqual({ songs: [1, 2] })
  })

  it('surfaces a syntax error in the recipe snippet as ComputeError, not a crash', async () => {
    await expect(runCompute({ code: `this is not js`, input: {}, capabilities: [] }))
      .rejects.toThrow(ComputeError)
  })

  // desktop-packaging: isolated-vm 改懒加载后，首次 runCompute 仍能拉起 VM 并算出结果（回归锁）。
  it('lazily loads isolated-vm on first use and still computes', async () => {
    const out = await runCompute({ code: `input.a + input.b`, input: { a: 2, b: 3 }, capabilities: [] })
    expect(out).toBe(5)
  })
})
