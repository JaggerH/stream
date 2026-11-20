import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SiteIdentityStore } from './identity-store.ts'

const open = (path = join(mkdtempSync(join(tmpdir(), 'identities-')), 'stream.db'), now = () => 1000) => new SiteIdentityStore(path, { now })

describe('SiteIdentityStore 的探测旁证（D15）', () => {
  it('会话 cookie 指纹随记录落盘：重开库还在', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'identities-')), 'stream.db')
    const s = open(path)
    s.record('xhs', 'node_a', { state: 'signed-in', accountId: 'A' }, { cookieFingerprint: 'fp-1' })
    expect(s.probeState('xhs', 'node_a')).toEqual({ verifiedAt: 1000, cookieFingerprint: 'fp-1' })
    s.close()

    const again = open(path)
    expect(again.probeState('xhs', 'node_a')).toEqual({ verifiedAt: 1000, cookieFingerprint: 'fp-1' })
    expect(again.get('xhs', 'node_a')).toMatchObject({ accountId: 'A', state: 'signed-in' })
  })

  it('unknown 不写：核对时间与指纹都不动', () => {
    let t = 1000
    const s = open(undefined, () => t)
    s.record('xhs', 'node_a', { state: 'signed-in', accountId: 'A' }, { cookieFingerprint: 'fp-1' })
    t = 2000
    s.record('xhs', 'node_a', { state: 'unknown', reason: '节点断开' }, { cookieFingerprint: 'fp-2' })
    expect(s.probeState('xhs', 'node_a')).toEqual({ verifiedAt: 1000, cookieFingerprint: 'fp-1' })
  })

  it('没给指纹时保留原值；显式 null（登出）清掉', () => {
    const s = open()
    s.record('xhs', 'node_a', { state: 'signed-in', accountId: 'A' }, { cookieFingerprint: 'fp-1' })
    s.record('xhs', 'node_a', { state: 'signed-in', accountId: 'A' })
    expect(s.probeState('xhs', 'node_a')?.cookieFingerprint).toBe('fp-1')
    s.record('xhs', 'node_a', { state: 'signed-out' }, { cookieFingerprint: null })
    expect(s.probeState('xhs', 'node_a')).toEqual({ verifiedAt: 1000, cookieFingerprint: null })
  })

  it('没有记录时 probeState 为空', () => {
    expect(open().probeState('xhs', 'node_a')).toBeNull()
  })

  it('旧库（没有 cookie_fingerprint 列）能直接打开并补列', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'identities-')), 'stream.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE site_identities (
        facility TEXT NOT NULL,
        node_id TEXT NOT NULL,
        account_id TEXT,
        display_name TEXT,
        state TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        PRIMARY KEY (facility, node_id)
      );
    `)
    legacy.prepare("INSERT INTO site_identities VALUES ('xhs', 'node_a', 'A', 'A', 'signed-in', 900)")
      .run()
    legacy.close()

    const s = open(path)
    expect(s.get('xhs', 'node_a')).toMatchObject({ accountId: 'A', state: 'signed-in' })
    expect(s.probeState('xhs', 'node_a')).toEqual({ verifiedAt: 900, cookieFingerprint: null })
    s.record('xhs', 'node_a', { state: 'signed-in', accountId: 'A' }, { cookieFingerprint: 'fp-1' })
    expect(s.probeState('xhs', 'node_a')?.cookieFingerprint).toBe('fp-1')
  })
})
