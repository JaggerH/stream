import { describe, it, expect, vi } from 'vitest'
import { toCandidates, toChannelSummaries, webTransport } from './subscribe-shell.ts'
import { candidateKey } from '@subscribe/memberKey.ts'
import type { ChannelView } from './types.ts'

describe('toChannelSummaries', () => {
  it('keys each member by its manifest source id + params', () => {
    const channels: ChannelView[] = [{
      id: 'ch1', label: 'A', kind: 'timeline', present: 'timeline', space_id: 'default-space',
      streams: [{
        id: 's1', description: 'x', cadence_seconds: 1800, vault_subdir: 's1',
        sources: [{ source: { id: 'rsshub:weibo/user', pluginId: 'rsshub', pluginName: 'RSSHub', title: 'w', categories: [], capabilities: [], auth: 'none', paramCount: 1, requiredParamCount: 1 }, params: { uid: '99' } }],
      }],
    }]
    const [sum] = toChannelSummaries(channels)
    expect(sum.streamIds).toEqual(['s1'])
    expect(sum.members).toEqual([{ key: candidateKey('rsshub:weibo/user', { uid: '99' }), streamId: 's1' }])
  })
})

describe('toCandidates', () => {
  it('maps a radar result to shared Candidates', () => {
    const cs = toCandidates({ input: 'u', fallback: 'generic-url', matches: [{ sourceId: 'rsshub:weibo/user', params: { uid: '99' }, title: '微博' }] })
    expect(cs).toEqual([{ sourceId: 'rsshub:weibo/user', params: { uid: '99' }, title: '微博' }])
  })
})

describe('webTransport', () => {
  it('routes create/setChannelStreams/delete to the existing api endpoints', async () => {
    const conn = { baseUrl: '' }
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) })
      return { ok: true, json: async () => ({ id: 'new1' }) } as Response
    }))
    const t = webTransport(conn)
    await t.createStream({ id: 'new1', label: 'l', strategy: 'fanout', cadence_seconds: 1800, members: [], options: {} })
    await t.setChannelStreams('ch1', ['new1'])
    await t.deleteStream('new1')
    expect(calls).toEqual([
      { method: 'POST', url: '/api/streams' },
      { method: 'PATCH', url: '/api/channels/ch1' },
      { method: 'DELETE', url: '/api/streams/new1' },
    ])
    vi.unstubAllGlobals()
  })
})
