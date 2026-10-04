import type { ActivateFn } from '../../src/packages/activate.ts'
import { movieNormalizer } from './movie.ts'

/** 这个包贡献的代码：一个 normalizer（`movie`：本包 `manifests.yaml` 里影视榜单路由的渲染规则）。
 *  RSSHub adapter 本身不在这儿——它是宿主四件之一（依赖宿主基础设施，见 docs/PACKAGE.md §3.5）。 */
export const activate: ActivateFn = () => ({
  normalizers: { movie: movieNormalizer },
})
