import { describe, it, expect, vi } from 'vitest'
import { extTransport, toCandidates, toChannelSummaries } from './subscribe-shell.ts'
import { candidateKey } from '@subscribe/memberKey.ts'
import type { Config } from './config.ts'

const cfg: Config = { baseUrl: 'http://127.0.0.1:8900/', domains: [], autoSync: true }

describe('toChannelSummaries', () => {
  it('keys each member by manifest source id + params', () => {
    const sums = toChannelSummaries([{
      id: 'ch1', label: 'A', kind: 'timeline',
      streams: [{ id: 's1', sources: [{ source: { id: 'rsshub:weibo/user' }, params: { uid: '99' } }] }],
    }] as never)
    expect(sums[0].members).toEqual([{ key: candidateKey('rsshub:weibo/user', { uid: '99' }), streamId: 's1' }])
  })
})

describe('toCandidates', () => {
  it('maps radar matches to candidates', () => {
    const out = toCandidates({ input: 'u', matches: [{ sourceId: 'a', params: { x: 1 }, title: 'A' }], fallback: 'unknown' } as never)
    expect(out).toEqual([{ sourceId: 'a', params: { x: 1 }, title: 'A' }])
  })

  it('回错形状（没有 matches）时给空数组，不抛——别让一个端点把整个 popup 带崩', () => {
    expect(toCandidates({ intents: [] } as never)).toEqual([])
  })
})

describe('extTransport', () => {
  it('routes to POST /api/streams, PATCH /api/channels/:id, DELETE /api/streams/:id', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) })
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'new1' }) } as Response
    }))
    const t = extTransport(cfg)
    await t.createStream({ id: 'new1', label: 'l', strategy: 'fanout', cadence_seconds: 1800, members: [], options: {} })
    await t.setChannelStreams('ch1', ['new1'])
    await t.deleteStream('new1')
    expect(calls).toEqual([
      { method: 'POST', url: 'http://127.0.0.1:8900/api/streams' },
      { method: 'PATCH', url: 'http://127.0.0.1:8900/api/channels/ch1' },
      { method: 'DELETE', url: 'http://127.0.0.1:8900/api/streams/new1' },
    ])
    vi.unstubAllGlobals()
  })
})
