import type { ActivateFn } from '../../src/packages/activate.ts'
import { FirecrawlAdapter } from './adapter.ts'

/** 这个包贡献的东西：一个 adapter（`firecrawl`），执行 `manifests.yaml` 里的 `article-firecrawl` 源。
 *  它不碰 cookie、不碰容器：key 由宿主按 manifest 的 `runtime_config` 解析好递进 `fetch`。 */
export const activate: ActivateFn = () => ({
  adapters: { firecrawl: new FirecrawlAdapter() },
})
