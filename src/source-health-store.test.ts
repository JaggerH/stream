import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SourceHealthStore } from './source-health-store.ts'

describe('SourceHealthStore', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-'))
    path = join(dir, 'source-health.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('ok resets counters, bumps lifetime, stays healthy', () => {
    const s = new SourceHealthStore(path)
    const h = s.record('a', { kind: 'ok', itemCount: 3 })
    expect(h.state).toBe('healthy')
    expect(h.lifetimeItemCount).toBe(3)
    expect(h.consecutiveEmpty).toBe(0)
    expect(h.consecutiveError).toBe(0)
  })

  it('empty on a never-productive source stays healthy', () => {
    const s = new SourceHealthStore(path, { K: 4 })
    for (let i = 0; i < 10; i++) s.record('a', { kind: 'empty' })
    expect(s.stateOf('a')).toBe('healthy')
  })

  it('error records category + stack + a rolling failure history', () => {
    const s = new SourceHealthStore(path)
    s.record('a', { kind: 'error', message: 'no items array', category: 'drift', stack: 'STACK1' })
    const h = s.record('a', { kind: 'error', message: 'HTTP 412', category: 'blocked', stack: 'STACK2' })
    expect(h.lastError).toBe('HTTP 412')
    expect(h.lastErrorCategory).toBe('blocked')
    expect(h.lastErrorStack).toBe('STACK2')
    expect(h.recentFailures?.map((f) => f.category)).toEqual(['blocked', 'drift']) // newest first
    expect(h.recentFailures?.[1].stack).toBe('STACK1')
  })

  it('history caps at 5 (newest kept)', () => {
    const s = new SourceHealthStore(path)
    for (let i = 0; i < 7; i++) s.record('a', { kind: 'error', message: `e${i}`, category: 'unknown' })
    const h = s.get('a')!
    expect(h.recentFailures).toHaveLength(5)
    expect(h.recentFailures?.[0].message).toBe('e6')
  })

  it('a later ok clears current error fields but keeps the history', () => {
    const s = new SourceHealthStore(path)
    s.record('a', { kind: 'error', message: 'boom', category: 'network', stack: 'S' })
    const h = s.record('a', { kind: 'ok', itemCount: 1 })
    expect(h.lastError).toBeUndefined()
    expect(h.lastErrorCategory).toBeUndefined()
    expect(h.recentFailures).toHaveLength(1) // track preserved
  })

  it('K consecutive empties on a productive source → degraded', () => {
    const s = new SourceHealthStore(path, { K: 4 })
    s.record('a', { kind: 'ok', itemCount: 2 })
    s.record('a', { kind: 'empty' })
    s.record('a', { kind: 'empty' })
    s.record('a', { kind: 'empty' })
    expect(s.stateOf('a')).toBe('healthy') // only 3 empties
    s.record('a', { kind: 'empty' })
    expect(s.stateOf('a')).toBe('degraded') // 4th empty
  })

  it('hard error degrades on 1, dies on errK consecutive', () => {
    const s = new SourceHealthStore(path, { errK: 2 })
    s.record('a', { kind: 'error', message: 'boom' })
    expect(s.stateOf('a')).toBe('degraded')
    s.record('a', { kind: 'error', message: 'boom' })
    expect(s.stateOf('a')).toBe('dead')
  })

  it('ok recovers a dead source to healthy', () => {
    const s = new SourceHealthStore(path, { errK: 2 })
    s.record('a', { kind: 'error', message: 'x' })
    s.record('a', { kind: 'error', message: 'x' })
    expect(s.stateOf('a')).toBe('dead')
    s.record('a', { kind: 'ok', itemCount: 1 })
    expect(s.stateOf('a')).toBe('healthy')
  })

  it('markHealthy forces healthy and clears counters', () => {
    const s = new SourceHealthStore(path, { errK: 2 })
    s.record('a', { kind: 'error', message: 'x' })
    s.record('a', { kind: 'error', message: 'x' })
    s.markHealthy('a')
    expect(s.stateOf('a')).toBe('healthy')
    expect(s.get('a')?.consecutiveError).toBe(0)
  })

  it('stateOf an unknown source is healthy (cold start)', () => {
    const s = new SourceHealthStore(path)
    expect(s.stateOf('never-seen')).toBe('healthy')
  })

  it('persists and reloads from disk', () => {
    const s1 = new SourceHealthStore(path, { errK: 2 })
    s1.record('a', { kind: 'ok', itemCount: 5 })
    s1.record('a', { kind: 'error', message: 'x' })
    const s2 = new SourceHealthStore(path, { errK: 2 })
    expect(s2.get('a')?.lifetimeItemCount).toBe(5)
    expect(s2.get('a')?.consecutiveError).toBe(1)
    expect(s2.stateOf('a')).toBe('degraded')
  })

  it('snapshot returns all sources', () => {
    const s = new SourceHealthStore(path)
    s.record('a', { kind: 'ok', itemCount: 1 })
    s.record('b', { kind: 'empty' })
    expect(Object.keys(s.snapshot()).sort()).toEqual(['a', 'b'])
  })
})

// ── clearAuthFailure：登录墙点得亮，就必须熄得掉 ──────────────────────────────────────
//
// readSource 的失败路径对 auth 破例（ad-hoc read 也记 health），好让一个从不被调度的
// search-only facility 的登录墙能浮出来。破例只开一半就成了单向阀：用户重新登录、采集
// 恢复正常，那条「登录已失效」永远挂着（2026-07-28 活体撞到）。这里是另一半。
describe('SourceHealthStore.clearAuthFailure', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-auth-'))
    path = join(dir, 'source-health.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('clears an auth failure and reports that it did', () => {
    const s = new SourceHealthStore(path)
    s.record('xhs-search', { kind: 'error', message: 'needs re-login', category: 'auth' })
    expect(s.clearAuthFailure('xhs-search')).toBe(true)
    const h = s.get('xhs-search')!
    expect(h.lastOutcome).toBe('ok')
    expect(h.lastErrorCategory).toBeUndefined()
    expect(h.consecutiveError).toBe(0)
    expect(s.stateOf('xhs-search')).toBe('healthy')
  })

  it('refuses to touch a NON-auth failure — this is not a whitewash tool', () => {
    // 窄到只碰 auth 是有意的：否则 preview 一次就能把任何真坏掉的源洗成健康。
    const s = new SourceHealthStore(path)
    s.record('flaky', { kind: 'error', message: 'upstream 500', category: 'network' })
    expect(s.clearAuthFailure('flaky')).toBe(false)
    expect(s.get('flaky')?.lastOutcome).toBe('error')
    expect(s.get('flaky')?.lastErrorCategory).toBe('network')
  })

  it('is a no-op on a healthy or unknown source', () => {
    const s = new SourceHealthStore(path)
    s.record('fine', { kind: 'ok', itemCount: 3 })
    expect(s.clearAuthFailure('fine')).toBe(false)
    expect(s.clearAuthFailure('never-heard-of-it')).toBe(false)
  })

  it('keeps the failure history — clearing the current state is not forgetting', () => {
    // recentFailures 是排错用的账本，解除当前断言不该抹掉"它曾经掉过登录态"这个事实。
    const s = new SourceHealthStore(path)
    s.record('xhs-search', { kind: 'error', message: 'needs re-login', category: 'auth' })
    s.clearAuthFailure('xhs-search')
    expect(s.get('xhs-search')?.recentFailures?.length).toBe(1)
  })

  it('survives a reload', () => {
    const s1 = new SourceHealthStore(path)
    s1.record('xhs-search', { kind: 'error', message: 'needs re-login', category: 'auth' })
    s1.clearAuthFailure('xhs-search')
    expect(new SourceHealthStore(path).get('xhs-search')?.lastOutcome).toBe('ok')
  })
})
