import { api, type Connection } from './api.ts'
import { candidateKey } from '@subscribe/memberKey.ts'
import type { Candidate, ChannelSummary, StreamCreateBody, SubscribeTransport } from '@subscribe/types.ts'
import type { ChannelView, StreamCreate } from './types.ts'

interface RadarResult {
  input: string
  fallback: 'generic-url' | 'unknown'
  matches: Array<{ sourceId: string; params: Record<string, unknown>; title: string }>
}

export function toCandidates(radar: RadarResult): Candidate[] {
  return radar.matches.map((m) => ({ sourceId: m.sourceId, params: m.params, title: m.title }))
}

const VARIANTS = ['timeline', 'search', 'audio', 'video'] as const
function asVariant(kind: string): ChannelSummary['variant'] {
  return (VARIANTS as readonly string[]).includes(kind) ? (kind as ChannelSummary['variant']) : 'timeline'
}

export function toChannelSummaries(channels: ChannelView[]): ChannelSummary[] {
  return channels.map((c) => ({
    id: c.id,
    label: c.label,
    variant: asVariant(c.kind),
    streamIds: c.streams.map((s) => s.id),
    members: c.streams.flatMap((s) =>
      s.sources.map((src) => ({ key: candidateKey(src.source.id, src.params), streamId: s.id })),
    ),
  }))
}

export function webTransport(conn: Connection): SubscribeTransport {
  return {
    createStream: (body: StreamCreateBody) =>
      api.subscribe(conn, body as unknown as StreamCreate).then((s) => ({ id: (s as { id: string }).id })),
    setChannelStreams: (channelId, streamIds) =>
      api.updateChannel(conn, channelId, { stream_ids: streamIds }).then(() => {}),
    deleteStream: (streamId) => api.unsubscribe(conn, streamId).then(() => {}),
  }
}
