// src/live/service.ts — live 取数（spec 2026-08-25-research-present §一）。
//
// 与采集管线**刻意不共用**：那条链子上的去重 / 广告过滤 / 故事归堆 / 入库全是为「留档」
// 服务的，live 一样都不要。串进去只会让一次列表查询带上一堆它不需要的副作用，
// 而且那些副作用都是有状态的（写库、改 dedup 记录），一次页面刷新就会留下痕迹。
import type { StreamRecord } from '../store/types.ts'

export interface LiveItem {
  id: string
  stream_id: string
  source_id: string
  type: string
  title: string
  body_text?: string
  author?: string
  timestamp: string
  fetched_at: string
}

interface RawLike {
  guid?: string
  title?: string
  description?: string
  author?: string
  pubDate?: string
}

export interface LiveDeps {
  getStream(id: string): StreamRecord | null
  manifestOf(sourceId: string): { id: string; adapter: string } | undefined
  adapterFor(manifest: { adapter: string }): {
    fetch(params: Record<string, unknown>, manifest: unknown, ctx: { runtimeConfig: Record<string, unknown> }): Promise<unknown>
  } | undefined
  runtimeConfigFor(manifest: unknown): Record<string, unknown>
}

export type LiveErrorCode = 'unknown_stream' | 'unknown_source' | 'no_adapter'

export class LiveStreamError extends Error {
  constructor(public readonly code: LiveErrorCode, message: string) { super(message) }
}

export class LiveStreamService {
  constructor(private readonly deps: LiveDeps) {}

  async items(streamId: string): Promise<LiveItem[]> {
    const stream = this.deps.getStream(streamId)
    if (!stream) throw new LiveStreamError('unknown_stream', `no stream "${streamId}"`)
    const now = new Date().toISOString()
    const out: LiveItem[] = []
    for (const member of stream.members) {
      const manifest = this.deps.manifestOf(member.source)
      if (!manifest) throw new LiveStreamError('unknown_source', `stream "${streamId}" binds unknown source "${member.source}"`)
      const adapter = this.deps.adapterFor(manifest)
      if (!adapter) throw new LiveStreamError('no_adapter', `no adapter "${manifest.adapter}" for source "${member.source}"`)
      // 源抛错原样上抛：live 面没有"上游今天空了"这种合法空结果，
      // 吞成 [] 就是把"读不到"伪装成"没有"——用户会以为 run 真的没了。
      const got = await adapter.fetch(member.params ?? {}, manifest, { runtimeConfig: this.deps.runtimeConfigFor(manifest) })
      const raws = (Array.isArray(got) ? got : (got as { items?: unknown[] }).items ?? []) as RawLike[]
      for (const r of raws) {
        out.push({
          id: r.guid ?? `${member.source}:${out.length}`,
          stream_id: streamId,
          source_id: member.source,
          type: 'article',
          title: r.title ?? '',
          body_text: r.description,
          author: r.author,
          timestamp: r.pubDate ?? now,
          fetched_at: now,
        })
      }
    }
    return out
  }
}
