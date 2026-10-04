import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Registry } from './registry.ts'
import { loadManifests } from '../manifest/loader.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(id: string, provides?: string[], priority?: number): SourceManifest {
  return {
    schema_version: 1, id, adapter: 'fake', type: 'post', description: id,
    topics: [], example_queries: [], capabilities: ['timeline'],
    auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true,
    provides, priority,
  }
}

describe('Registry.providersOf', () => {
  it('returns sources declaring the target-type, ordered by priority asc', () => {
    const r = new Registry([mk('zuna', ['netease-track'], 1), mk('tobiec', ['netease-track'], 2)])
    expect(r.providersOf('netease-track').map((m) => m.id)).toEqual(['zuna', 'tobiec'])
  })

  it('treats an absent priority as last (default 100)', () => {
    const r = new Registry([mk('browser', ['xhs-author']), mk('rsshub', ['xhs-author'], 1)])
    expect(r.providersOf('xhs-author').map((m) => m.id)).toEqual(['rsshub', 'browser'])
  })

  it('excludes sources that do not declare the type', () => {
    const r = new Registry([mk('zuna', ['netease-track'], 1), mk('other', ['xhs-author'], 1)])
    expect(r.providersOf('netease-track').map((m) => m.id)).toEqual(['zuna'])
  })

  it('breaks priority ties deterministically by id', () => {
    const r = new Registry([mk('b', ['t'], 5), mk('a', ['t'], 5)])
    expect(r.providersOf('t').map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('returns empty for an unknown target-type', () => {
    const r = new Registry([mk('zuna', ['netease-track'], 1)])
    expect(r.providersOf('nope')).toEqual([])
  })
})

describe('manifest loader carries provides/priority', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'man-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses provides + priority from YAML', () => {
    writeFileSync(join(dir, 'm.yaml'),
      'id: zuna\nadapter: fake\ncapabilities: [timeline]\nauth: {type: none}\ncadence_hint_seconds: 1800\nprovides: [netease-track]\npriority: 2\n')
    const m = loadManifests(dir)[0]
    expect(m.provides).toEqual(['netease-track'])
    expect(m.priority).toBe(2)
  })
})
