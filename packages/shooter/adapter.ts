import type { Adapter } from '../../src/adapters/types.ts'
import { fetchShooterSubtitle, searchShooter, type RangeReader } from './client.ts'

/**
 * `shooter-subtitle` 源的执行后端——宿主 `subtitle-search` 行的 auto 成员（`provides: [search-subtitle]`）。
 * 两个操作，从 params 读（成员合同见 src/providers/system/subtitle-search.ts）：
 *  - `op: 'search'` + `name` + `size` + `read` → 候选（算 filehash 要按字节读视频；缺了就 `[]`）。
 *  - `op: 'fetch'` + `id`（本包给出的直链）→ `[{ bytes }]`；取不到就抛。
 */
export class ShooterSubtitleAdapter implements Adapter {
  readonly id = 'shooter-subtitle'

  constructor(private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  async init(): Promise<void> {}

  async fetch(params: Record<string, unknown>): Promise<unknown[]> {
    if (params.op === 'search' && typeof params.name === 'string' && params.name) {
      return searchShooter({
        videoFile: params.name,
        size: typeof params.size === 'number' ? params.size : undefined,
        read: typeof params.read === 'function' ? (params.read as RangeReader) : undefined,
        fetchImpl: this.fetchImpl,
      })
    }
    if (params.op === 'fetch' && typeof params.id === 'string') {
      return [{ bytes: await fetchShooterSubtitle(params.id, this.fetchImpl) }]
    }
    return []
  }
}
