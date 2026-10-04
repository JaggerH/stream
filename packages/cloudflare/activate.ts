import type { ActivateFn } from '../../src/packages/activate.ts'
import { CloudflareAdapter } from './adapter.ts'

/** 这个包贡献的代码：一个 adapter（`cloudflare`），执行 `manifests.yaml` 里的 `cf-whisper` 源。
 *  不碰 cookie、不碰容器：钥匙由宿主按 manifest 的 `runtime_config` 解析好递进 `fetch`。 */
export const activate: ActivateFn = () => ({
  adapters: { cloudflare: new CloudflareAdapter() },
})
