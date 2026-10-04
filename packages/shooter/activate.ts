import type { ActivateFn } from '../../src/packages/activate.ts'
import { ShooterSubtitleAdapter } from './adapter.ts'

/** 这个包贡献的代码：一个 adapter（`shooter-subtitle`），执行 `manifests.yaml` 里的字幕搜刮源。 */
export const activate: ActivateFn = () => ({
  adapters: { 'shooter-subtitle': new ShooterSubtitleAdapter() },
})
