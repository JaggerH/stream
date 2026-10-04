import { MOUNT_PRESETS } from '../../packages/alist/presets.ts'
import type { MappingLeft, MappingSet } from './types.ts'

export interface TmdbRef {
  id: string
  media: 'movie' | 'tv'
  title: string
}

/** 转存成功后对这部作品的绑定该做什么。 */
export type BindAction =
  | { kind: 'create'; dirPath: string; left: MappingLeft }
  | { kind: 'sync'; setId: string }
  | { kind: 'rebind'; setId: string; dirPath: string }
  | { kind: 'skip'; reason: string }

/**
 * 落地目录的**唯一口径**：去掉重复斜杠与结尾斜杠的 AList 绝对路径。
 *
 * 转存那一侧写进待认领账本的目录、认领那一侧拿绑定 `right.path` 去比的目录，必须过同一个
 * 函数——两边口径分家的表现是「待认领表只涨、永远没人认领」：不报错、没有一处会喊。
 */
export function normalizeLandingDir(path: string): string {
  return path.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/**
 * 一次转存实际落在 AList 上的绝对目录（`<挂载点>/<网盘内 dest>`）。
 * 这个网盘没有挂载前缀、或转存没回落点 → `undefined`：说不清落在哪儿就别猜一个出来。
 */
export function landingDirFor(netdisk: string, dest: string | undefined): string | undefined {
  const mount = MOUNT_PRESETS.find((p) => p.id === netdisk)?.mountPath
  if (!mount || !dest) return undefined
  return normalizeLandingDir(`${mount}/${dest}`)
}

/**
 * 「转存 → 自动绑定」的决策（纯函数，路由执行它产出的动作）。
 *
 * 落点是网盘内相对路径（`From Stream/<作品名>`，见 quark-save 返回的 sanitized dest）；绑定要的是
 * AList 绝对路径，前缀是这个网盘的挂载点（`/quark`，静态取自 MOUNT_PRESETS，不必查 storage）。
 *
 * 同一作品可能转存多条分享（补集 / 换版本）——所以不是无脑新建：
 *  - 没绑过 → create
 *  - 已绑到同一目录 → sync（重算配对，多个视频文件时 solo 退让、title 兜底）
 *  - 已绑但目录变了 → rebind（换目录，指纹认亲继承 confirmed）
 * 否则同作品转存两次会建出两个绑定，播放反查撞键。
 */
export function planBinding(
  netdisk: string,
  dest: string | undefined,
  ref: TmdbRef,
  existing: MappingSet | undefined,
): BindAction {
  if (!MOUNT_PRESETS.some((p) => p.id === netdisk)) return { kind: 'skip', reason: `网盘 ${netdisk} 无挂载前缀，无法定位绑定目录` }
  if (!dest) return { kind: 'skip', reason: '转存未返回落点目录' }
  // 与待认领分享写进账本的那个目录同一个拼法（见 landingDirFor 头注）——别在这里另拼一遍。
  const dirPath = landingDirFor(netdisk, dest)!

  if (!existing) return { kind: 'create', dirPath, left: { kind: 'tmdb', ...ref } }
  // **两侧都要过 `normalizeLandingDir`。** 右边归一化了、左边没有，就会把一条历史上带了
  // 双斜杠/结尾斜杠的绑定判成"落点变了"→ 从 `sync` 翻成 `rebind`，而两个路径指的是同一个目录。
  return normalizeLandingDir(existing.right.path) === dirPath
    ? { kind: 'sync', setId: existing.id }
    : { kind: 'rebind', setId: existing.id, dirPath }
}
