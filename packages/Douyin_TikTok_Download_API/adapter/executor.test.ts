import { describe, it, expect } from 'vitest'
import { resolveQuery, pickList, runDeclarative, type DeclApiBinding } from './executor.ts'

describe('resolveQuery', () => {
  it('maps from → upstream, applies defaults, omits blanks', () => {
    const q = {
      secUid: { from: 'sec_uid', required: true },
      cursor: { from: 'cursor', default: 0 },
      count: { from: 'count', default: 35 },
    }
    expect(resolveQuery(q, { sec_uid: 'ABC', count: 10 })).toEqual({
      secUid: 'ABC',
      cursor: '0', // default applied
      count: '10', // param wins over default
    })
  })

  it('throws when a required param resolves blank', () => {
    const q = { secUid: { from: 'sec_uid', required: true } }
    expect(() => resolveQuery(q, {})).toThrow(/sec_uid/)
    expect(() => resolveQuery(q, { sec_uid: '' })).toThrow(/sec_uid/)
  })

  it('omits an optional blank param entirely (no empty-string key)', () => {
    const q = { secUid: { from: 'sec_uid' }, uniqueId: { from: 'unique_id' } }
    expect(resolveQuery(q, { unique_id: 'name' })).toEqual({ uniqueId: 'name' })
  })

  it('handles an empty/undefined query map', () => {
    expect(resolveQuery(undefined, { a: 1 })).toEqual({})
  })
})

describe('pickList', () => {
  it('returns a nested array at the dot-path', () => {
    expect(pickList({ code: 200, data: { itemList: [1, 2] } }, 'data.itemList')).toEqual([1, 2])
  })

  it('wraps a single object into a one-item array', () => {
    expect(pickList({ data: { bvid: 'BV1' } }, 'data')).toEqual([{ bvid: 'BV1' }])
  })

  it('digs multiple levels', () => {
    expect(pickList({ data: { list: { vlist: [{ x: 1 }] } } }, 'data.list.vlist')).toEqual([{ x: 1 }])
  })

  it('returns [] when the path is missing or nil', () => {
    expect(pickList({ data: {} }, 'data.itemList')).toEqual([])
    expect(pickList({ code: 500 }, 'data.list.vlist')).toEqual([])
    expect(pickList(null, 'data')).toEqual([])
  })
})

describe('runDeclarative', () => {
  const binding: DeclApiBinding = {
    endpoint: '/api/tiktok/web/fetch_user_post',
    query: { secUid: { from: 'sec_uid', required: true }, count: { from: 'count', default: 35 } },
    unwrap: 'data.itemList',
  }

  it('resolves query, calls the endpoint, and unwraps the list', async () => {
    const seen: Array<{ path: string; query: Record<string, string> }> = []
    const get = async (path: string, query: Record<string, string>) => {
      seen.push({ path, query })
      return { code: 200, data: { itemList: [{ id: 'a' }, { id: 'b' }] } }
    }
    const items = await runDeclarative(binding, { sec_uid: 'SEC' }, get)
    expect(seen).toEqual([{ path: '/api/tiktok/web/fetch_user_post', query: { secUid: 'SEC', count: '35' } }])
    expect(items).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('applies a registered normalizer to each item', async () => {
    const b: DeclApiBinding = { endpoint: '/e', unwrap: 'data', normalize: 'wrap' }
    const get = async () => ({ data: [{ n: 1 }, { n: 2 }] })
    const items = await runDeclarative(b, {}, get, { wrap: (raw) => ({ wrapped: raw }) })
    expect(items).toEqual([{ wrapped: { n: 1 } }, { wrapped: { n: 2 } }])
  })

  it('throws on an unknown normalize name', async () => {
    const b: DeclApiBinding = { endpoint: '/e', unwrap: 'data', normalize: 'missing' }
    await expect(runDeclarative(b, {}, async () => ({ data: [] }))).rejects.toThrow(/missing/)
  })

  it('propagates a missing required param before calling get', async () => {
    let called = false
    const get = async () => {
      called = true
      return {}
    }
    await expect(runDeclarative(binding, {}, get)).rejects.toThrow(/sec_uid/)
    expect(called).toBe(false)
  })
})
