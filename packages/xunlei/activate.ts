import type { ActivateFn } from '../../src/packages/activate.ts'
import { XunleiSubtitleAdapter } from './adapter.ts'

/** 这个包贡献的代码：一个 adapter（`xunlei-subtitle`），执行 `manifests.yaml` 里的字幕搜刮源。
 *  不碰 cookie（接口零注册）。 */
export const activate: ActivateFn = () => ({
  adapters: { 'xunlei-subtitle': new XunleiSubtitleAdapter() },
})
