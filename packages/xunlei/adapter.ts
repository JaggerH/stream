import type { Adapter } from '../../src/adapters/types.ts'
import { fetchXunleiSubtitle, searchXunlei } from './client.ts'

/**
 * `xunlei-subtitle` 源的执行后端——宿主 `subtitle-search` 行的 auto 成员（`provides: [search-subtitle]`）。
 * 两个操作，从 params 读（成员合同见 src/providers/system/subtitle-search.ts）：
 *  - `op: 'search'` + `name`（视频文件名）→ 候选；搜不到 / 出错 → `[]`。
 *  - `op: 'fetch'` + `id`（本包给出的直链）→ `[{ bytes }]`；取不到就抛。
 * 别的输入 → `[]`（不是我的活）。
 */
export class XunleiSubtitleAdapter implements Adapter {
  readonly id = 'xunlei-subtitle'

  constructor(private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  async init(): Promise<void> {}

  async fetch(params: Record<string, unknown>): Promise<unknown[]> {
    if (params.op === 'search' && typeof params.name === 'string' && params.name) {
      return searchXunlei(params.name, this.fetchImpl)
    }
    if (params.op === 'fetch' && typeof params.id === 'string') {
      return [{ bytes: await fetchXunleiSubtitle(params.id, this.fetchImpl) }]
    }
    return []
  }
}
