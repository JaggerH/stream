import type { Config } from './config.ts'
import { candidateKey } from '@subscribe/memberKey.ts'
import type { Candidate, ChannelSummary, SubscribeTransport } from '@subscribe/types.ts'
import type { RadarResult } from './stream-api.ts'

const base = (c: Config) => c.baseUrl.replace(/\/$/, '')

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

/** Minimal channel shape the popup reads from GET /api/channels (same payload as the web ChannelView). */
export interface RawChannel {
  id: string; label: string; kind: string
  streams: Array<{ id: string; sources: Array<{ source: { id: string }; params: Record<string, unknown> }> }>
}

export const getChannels = (c: Config): Promise<RawChannel[]> => req<RawChannel[]>(`${base(c)}/api/channels`)

/** `matches` 缺席时按"没有候选"处理，**不抛**——这是炸伤范围的闸门，不是 schema 校验：
 *  radar 一个端点回错形状（2026-08-02 真发生过：`/api/intents` 被别的资源占了，回的是
 *  `{intents:[…]}`），不该把整个 popup 连同 cookie 同步那半边一起带崩成一条空壳。
 *  真正拦住那类事故的是后端的路由撞车守卫（`src/http/route-collisions.test.ts`）。 */
export function toCandidates(radar: RadarResult): Candidate[] {
  return (radar.matches ?? []).map((m) => ({ sourceId: m.sourceId, params: m.params, title: m.title }))
}

const VARIANTS = ['timeline', 'search', 'audio', 'mixed'] as const
export function toChannelSummaries(channels: RawChannel[]): ChannelSummary[] {
  return channels.map((c) => ({
    id: c.id,
    label: c.label,
    variant: (VARIANTS as readonly string[]).includes(c.kind) ? (c.kind as ChannelSummary['variant']) : 'timeline',
    streamIds: c.streams.map((s) => s.id),
    members: c.streams.flatMap((s) => s.sources.map((src) => ({ key: candidateKey(src.source.id, src.params), streamId: s.id }))),
  }))
}

export function extTransport(cfg: Config): SubscribeTransport {
  const b = base(cfg)
  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return {
    createStream: (body) => req<{ id: string }>(`${b}/api/streams`, jsonInit('POST', body)),
    setChannelStreams: (id, streamIds) => req<unknown>(`${b}/api/channels/${id}`, jsonInit('PATCH', { stream_ids: streamIds })).then(() => {}),
    deleteStream: (id) => req<unknown>(`${b}/api/streams/${id}`, { method: 'DELETE' }).then(() => {}),
  }
}

/** Create a new channel (inline "new channel" flow in the popup). */
export const createChannel = (c: Config, label: string): Promise<RawChannel> =>
  req<RawChannel>(`${base(c)}/api/channels`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, variant: 'timeline', stream_ids: [], options: {} }),
  })
