import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { DiscoveredChannels } from './discovered.ts'

describe('DiscoveredChannels', () => {
  let dir: string
  let d: DiscoveredChannels
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'disc-'))
    d = new DiscoveredChannels(join(dir, 'disc.db'))
  })
  afterEach(() => {
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('accumulates channels and counts occurrences across calls', () => {
    d.record('pansou-search', ['a', 'b'])
    d.record('pansou-search', ['b', 'c'])
    const list = d.list('pansou-search')
    expect(list.map((x) => x.channel).sort()).toEqual(['a', 'b', 'c'])
    expect(list.find((x) => x.channel === 'b')!.count).toBe(2)
  })

  it('dedups within a single record call and ignores blanks', () => {
    d.record('pansou-search', ['x', 'x', '', '  '])
    const list = d.list('pansou-search')
    expect(list).toHaveLength(1)
    expect(list[0].count).toBe(1)
  })

  it('scopes channels per source', () => {
    d.record('pansou-search', ['a'])
    d.record('other', ['b'])
    expect(d.list('pansou-search').map((x) => x.channel)).toEqual(['a'])
    expect(d.list('other').map((x) => x.channel)).toEqual(['b'])
  })

  it('adopts legacy discovered.db into stream.db once and renames the legacy file', () => {
    const streamDb = join(dir, 'stream.db')
    const legacyDb = join(dir, 'discovered.db')
    const legacy = new Database(legacyDb)
    legacy.exec(`
      CREATE TABLE discovered_channel (
        source_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        PRIMARY KEY (source_id, channel)
      );
      INSERT INTO discovered_channel (source_id, channel, count, first_seen)
      VALUES ('legacy-source', 'legacy-ch', 5, '2026-07-02T00:00:00.000Z');
    `)
    legacy.close()

    const first = new DiscoveredChannels(streamDb, legacyDb)
    expect(first.list('legacy-source')).toEqual([
      { channel: 'legacy-ch', count: 5, first_seen: '2026-07-02T00:00:00.000Z' }
    ])
    expect(existsSync(`${legacyDb}.imported`)).toBe(true)
    first.close()

    const second = new DiscoveredChannels(streamDb, legacyDb)
    expect(second.list('legacy-source')).toEqual([
      { channel: 'legacy-ch', count: 5, first_seen: '2026-07-02T00:00:00.000Z' }
    ])
    second.close()
  })
})
