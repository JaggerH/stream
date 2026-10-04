import type { Adapter, SourceExecutionContext } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import { CloudflareBackend } from './client.ts'

/** CF whisper 的单文件上限：>20MB 让给梯子后面那一档（不是失败）。 */
const MAX_BYTES = 20 * 1024 * 1024

/**
 * `cf-whisper` 源的执行后端——宿主 `transcribe` 梯子的一档成员。
 *
 * 输入是转写调用点给的对象 `{ bytes, mime, opts? }`：非 builtin 成员的对象输入由执行器按字段摊进
 * `params`（`memberCallArgs`，src/providers/invoke-types.ts），所以这里从 params 读。
 *
 * 钥匙由宿主派发：manifest 的 `runtime_config.ref: cloudflare`（`apiKey` + `accountId`），宿主在调用前
 * 解析好放进 `context.runtimeConfig`（存储值优先，空着回落部署环境变量，那张表在宿主）。包不读 env。
 *
 * decline（`[]`，让给下一档）的三种情况：要说话人分离（CF whisper 做不了）、>20MB、钥匙不全。
 * 请求失败一律**抛**——decline 是「让位」，不是「试了失败」。
 */
export class CloudflareAdapter implements Adapter {
  readonly id = 'cloudflare'

  async init(): Promise<void> {}

  async fetch(rawParams: Record<string, unknown>, _manifest: SourceManifest, context?: SourceExecutionContext): Promise<unknown[]> {
    const p = rawParams as { bytes?: unknown; mime?: unknown; opts?: { diarize?: boolean; translate?: boolean } }
    if (!(p.bytes instanceof Uint8Array)) return []
    if (p.opts?.diarize) return []
    if (p.bytes.byteLength > MAX_BYTES) return []
    const cfg = context?.runtimeConfig ?? {}
    const token = typeof cfg.apiKey === 'string' ? cfg.apiKey : ''
    const accountId = typeof cfg.accountId === 'string' ? cfg.accountId : ''
    if (!token || !accountId) return []
    const res = await new CloudflareBackend(accountId, token).transcribe(p.bytes, String(p.mime ?? ''), 'audio', undefined, p.opts)
    return [res]
  }
}
