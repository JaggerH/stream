import type { Adapter, SourceExecutionContext } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import type { VideoLookupIdentity } from '../../src/video/types.ts'
import { omdbLookup, omdbMetadata, omdbPoster } from './client.ts'

/** 执行器把影视详情调用点的身份对象按字段摊进 params（`memberCallArgs`，src/providers/invoke-types.ts）。 */
function identityOf(params: Record<string, unknown>): VideoLookupIdentity | null {
  if (typeof params.title !== 'string' || !params.title) return null
  const externalIds = params.externalIds && typeof params.externalIds === 'object' ? params.externalIds as Record<string, string> : {}
  return { ...(params as Partial<VideoLookupIdentity>), title: params.title, externalIds }
}

/**
 * `omdb-metadata` / `omdb-images` 两个源的执行后端——宿主 `video-metadata` / `video-images` 两行的成员
 * （TMDb 优先、OMDb 补空，顺序是宿主的判断）。哪个源由 manifest 的 `fixed_params.mode` 定。
 *
 * 钥匙由宿主派发：manifest 的 `runtime_config.ref: omdb`，宿主在调用前解析好放进 `context.runtimeConfig`
 * （配置页的值；老的影视源设置里的 OMDb key 由宿主投影成同一个 ref）。包不读宿主配置、不读 env。
 *
 * decline（`[]`）：没钥匙、输入没有标题、OMDb 查不到或对不上身份。HTTP 失败一律**抛**。
 */
export class OmdbAdapter implements Adapter {
  readonly id = 'omdb'

  async init(): Promise<void> {}

  async fetch(params: Record<string, unknown>, _manifest: SourceManifest, context?: SourceExecutionContext): Promise<unknown[]> {
    const mode = params.mode
    if (mode !== 'omdb-metadata' && mode !== 'omdb-images') throw new Error(`[omdb] unknown mode ${String(mode)}`)
    const identity = identityOf(params)
    const apiKey = typeof context?.runtimeConfig.apiKey === 'string' ? context.runtimeConfig.apiKey : ''
    if (!identity || !apiKey) return []
    const detail = await omdbLookup(identity, apiKey)
    if (!detail) return []
    if (mode === 'omdb-metadata') return [omdbMetadata(detail)]
    const poster = omdbPoster(detail)
    return poster ? [poster] : []
  }
}
