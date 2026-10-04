export interface Candidate {
  sourceId: string
  params: Record<string, unknown>
  title: string
}
export interface ChannelSummary {
  id: string
  label: string
  variant: 'timeline' | 'search' | 'audio' | 'video'
  streamIds: string[]
  members: Array<{ key: string; streamId: string }>
}
export type CandidateState = { candidate: Candidate; key: string; subscribed: boolean }
export interface StreamCreateBody {
  id: string
  label: string
  strategy: 'fanout' | 'exclusive'
  cadence_seconds: number
  members: { plugin: string; source: string; params: Record<string, unknown> }[]
  options: Record<string, unknown>
  /** 建流的同时把归属定下来（`POST /api/streams` 收它）。省掉它就有一个「这条流不属于任何
   *  频道」的中间态，而后端对没归属的流答"该采集"——于是归 live present 频道的流仍会被抓一次。
   *  没有归属可给的调用方（独立资源流）不传，行为与从前一致。 */
  channel_id?: string
}
export interface SubscribeTransport {
  createStream(body: StreamCreateBody): Promise<{ id: string }>
  setChannelStreams(channelId: string, streamIds: string[]): Promise<void>
  deleteStream(streamId: string): Promise<void>
}
