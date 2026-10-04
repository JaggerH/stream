/**
 * 「这个 URL 是谁家的哪一条曲目」——认领函数（`src/links/recognize.ts`）的曲目视图。
 *
 * **源码不认识任何站**：文法来自包的 `package.json#stream.links.patterns`（kind `track`，命名组 `id`；
 * 老写法 `stream.trackUrl` 装载时翻译进来）。`platform` 由认领它的包声明（缺省 = 包的 facility），
 * 一个平台只归一个包（撞了装载期拒）——所以一个包不能把曲目挂进别家的 `platform:id` 空间。
 * spec 2026-09-26-link-recognition-design。
 */
import { recognizeLinkSync } from '../links/recognize.ts'

export interface TrackRef { platform: string; track_id: string }

/** 命中某包的 track pattern → `{platform, track_id}`，否则 null。 */
export function trackRefFromUrl(url: string): TrackRef | null {
  const r = recognizeLinkSync(url)
  return r?.kind === 'track' && r.id ? { platform: r.platform, track_id: r.id } : null
}
