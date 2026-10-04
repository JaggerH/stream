import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ContentCache } from './content-cache.ts'

describe('ContentCache', () => {
  let dir: string
  let dbPath: string
  let clock: { t: number }
  let cache: ContentCache

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'content-cache-'))
    dbPath = join(dir, 'cache.db')
    clock = { t: 1_000_000 }
    cache = new ContentCache(dbPath, { now: () => clock.t })
    cache.register('facts', { ttlMs: 10_000 })
  })
  afterEach(() => {
    cache.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('miss runs fn once, hit within TTL serves without fn', async () => {
    let calls = 0
    const fn = async () => { calls++; return { v: calls } }
    expect(await cache.tryGet('facts', 'k', fn)).toEqual({ v: 1 })
    clock.t += 9_999
    expect(await cache.tryGet('facts', 'k', fn)).toEqual({ v: 1 })
    expect(calls).toBe(1)
  })

  it('expired entry refetches', async () => {
    let calls = 0
    const fn = async () => { calls++; return { v: calls } }
    await cache.tryGet('facts', 'k', fn)
    clock.t += 10_000
    expect(await cache.tryGet('facts', 'k', fn)).toEqual({ v: 2 })
    expect(calls).toBe(2)
  })

  it('persists across close/reopen (the point of the sqlite backing)', async () => {
    await cache.tryGet('facts', 'k', async () => ({ v: 'durable' }))
    cache.close()
    cache = new ContentCache(dbPath, { now: () => clock.t })
    cache.register('facts', { ttlMs: 10_000 })
    let called = false
    expect(await cache.tryGet('facts', 'k', async () => { called = true; return { v: 'refetched' } })).toEqual({ v: 'durable' })
    expect(called).toBe(false)
  })

  it('version bump turns old rows into misses — no migration', async () => {
    await cache.tryGet('facts', 'k', async () => ({ shape: 'old' }))
    cache.register('facts', { ttlMs: 10_000, version: 2 })
    expect(await cache.tryGet('facts', 'k', async () => ({ shape: 'new' }))).toEqual({ shape: 'new' })
    // and the new row is served under the new version
    expect(await cache.tryGet('facts', 'k', async () => ({ shape: 'newer' }))).toEqual({ shape: 'new' })
  })

  it('null results are NOT cached unless the namespace opts into negative caching', async () => {
    let calls = 0
    const fn = async () => { calls++; return null }
    await cache.tryGet('facts', 'k', fn)
    await cache.tryGet('facts', 'k', fn)
    expect(calls).toBe(2)

    cache.register('neg', { ttlMs: 10_000, negativeTtlMs: 2_000 })
    let negCalls = 0
    const negFn = async () => { negCalls++; return null }
    expect(await cache.tryGet('neg', 'dead', negFn)).toBeNull()
    expect(await cache.tryGet('neg', 'dead', negFn)).toBeNull() // negative hit
    expect(negCalls).toBe(1)
    clock.t += 2_000 // negative TTL is its own, shorter window
    await cache.tryGet('neg', 'dead', negFn)
    expect(negCalls).toBe(2)
  })

  it('staleFallback serves the expired last-known-good when fn throws; off by default', async () => {
    cache.register('sf', { ttlMs: 1_000, staleFallback: true })
    await cache.tryGet('sf', 'k', async () => ({ v: 'good' }))
    clock.t += 5_000
    expect(await cache.tryGet('sf', 'k', async () => { throw new Error('upstream down') })).toEqual({ v: 'good' })
    // without the opt-in, the error propagates
    await cache.tryGet('facts', 'k2', async () => ({ v: 1 }))
    clock.t += 60_000
    await expect(cache.tryGet('facts', 'k2', async () => { throw new Error('boom') })).rejects.toThrow('boom')
  })

  it('concurrent callers single-flight onto one fn run', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fn = async () => { calls++; await gate; return { v: calls } }
    const [a, b] = [cache.tryGet('facts', 'sf-key', fn), cache.tryGet('facts', 'sf-key', fn)]
    release()
    expect(await a).toEqual({ v: 1 })
    expect(await b).toEqual({ v: 1 })
    expect(calls).toBe(1)
  })

  it('a waiter retries its own fn when the in-flight run fails', async () => {
    let fail!: (e: Error) => void
    const failing = new Promise<never>((_, rej) => { fail = rej })
    const p1 = cache.tryGet('facts', 'rk', () => failing)
    const p2 = cache.tryGet('facts', 'rk', async () => ({ v: 'retry' }))
    fail(new Error('first died'))
    await expect(p1).rejects.toThrow('first died')
    expect(await p2).toEqual({ v: 'retry' })
  })

  it('fresh bypasses the hit but refills the cache', async () => {
    await cache.tryGet('facts', 'k', async () => ({ v: 1 }))
    expect(await cache.tryGet('facts', 'k', async () => ({ v: 2 }), { fresh: true })).toEqual({ v: 2 })
    expect(await cache.tryGet('facts', 'k', async () => ({ v: 3 }))).toEqual({ v: 2 })
  })

  it('delete forces the next read to refetch', async () => {
    await cache.tryGet('facts', 'k', async () => ({ v: 1 }))
    cache.delete('facts', 'k')
    expect(await cache.tryGet('facts', 'k', async () => ({ v: 2 }))).toEqual({ v: 2 })
  })

  it('prune drops expired rows (and runs at construction)', async () => {
    await cache.tryGet('facts', 'a', async () => ({ v: 1 }))
    await cache.tryGet('facts', 'b', async () => ({ v: 2 }))
    clock.t += 10_000
    expect(cache.prune()).toBe(2)
    expect(cache.prune()).toBe(0)
  })

  it('throws on an unregistered namespace', async () => {
    await expect(cache.tryGet('nope', 'k', async () => ({}))).rejects.toThrow(/not registered/)
  })
})
