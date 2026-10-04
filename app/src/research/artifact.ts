// app/src/research/artifact.ts — research present 的取数与契约类型。
// 字段名与后端逐字对齐（spec Global Constraints），别在这一层重命名——
// 改名会让"artifact 自描述"这件事在前端断掉，而断得毫无声响。
import { get, type Connection } from '../lib/api.ts'

export interface ArtifactRef { name: string; view: string }

export interface RunManifest {
  schema: string
  id: string
  name: string
  variant: string | null
  tags: string[]
  params: Record<string, unknown>
  status: string
  metrics: Record<string, unknown>
  artifacts: ArtifactRef[]
  created_at: string
  finished_at: string | null
}

export interface Artifact {
  schema: string
  view: string
  name: string
  data: unknown
  /** 显示配置（xlabel / ylabel 等），随数据走。**必须透传给 view 组件**——
   *  上一版把它丢了，图表因此全都渲染成没有轴标签的样子。 */
  config: Record<string, unknown>
}

/** live 列表一条。**逐字对齐 `src/live/service.ts` 的 `LiveItem`**——那边填什么这里就声明什么。
 *  少声明一个字段不会报错，只会让它对所有类型化的消费方隐形，和 artifact 的 `config` 被丢掉
 *  是同一种失效：数据在响应里，却没人看得见。 */
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

const enc = encodeURIComponent

export const fetchLiveItems = (c: Connection, streamId: string): Promise<LiveItem[]> =>
  get<{ items: LiveItem[] }>(c, `/api/live/streams/${enc(streamId)}/items`).then((r) => r.items)

export const fetchRunManifest = (c: Connection, streamId: string, runId: string): Promise<RunManifest> =>
  get<RunManifest>(c, `/api/research/streams/${enc(streamId)}/runs/${enc(runId)}`)

export const fetchArtifact = (c: Connection, streamId: string, runId: string, name: string): Promise<Artifact> =>
  get<Artifact>(c, `/api/research/streams/${enc(streamId)}/runs/${enc(runId)}/artifacts/${enc(name)}`)
