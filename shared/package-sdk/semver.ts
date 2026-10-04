/**
 * 「两层同一个包，谁的版本高」的唯一尺子——归并（`mergeRecipePackagesByFacility`）与激活
 * （`pickCodeLayer`）都用它，两处判据一分家就会出现「声明用了用户层的、代码却跑内置的」。
 *
 * 只认 `x.y.z`，可带 `-<预发布>` 后缀：
 *  - 三段数字逐段比；
 *  - 同核心版本时，正式版 > 预发布版（semver 自己的序）；两个预发布按字符串比（不做完整的
 *    semver 标识符逐段比较——包的版本由作者写，这里的目的只是排出「高者」，不是做范围解析）；
 *  - 任一侧缺失或不合法 → `null`。调用方把 `null` 一律读成「不比内置高」：**看不懂的版本号不许
 *    赢**，猜赢了就是拿一个来路不明的包顶掉随宿主同版本出货的内置。
 *
 * `v` 前缀 / `1.2` 两段 / `^1.0.0` 范围 全部算不合法：这是 `package.json#version` 的字面值，
 * npm 自己就拒这些写法，宿主不替它们猜。
 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export interface ParsedVersion {
  core: [number, number, number]
  prerelease?: string
}

export function parseVersion(v: string | undefined | null): ParsedVersion | null {
  if (typeof v !== 'string') return null
  const m = VERSION_PATTERN.exec(v)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] }
}

/** a>b → 正数；a<b → 负数；相等 → 0；任一侧不合法 → `null`。 */
export function compareVersions(a: string | undefined | null, b: string | undefined | null): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  if (pa.prerelease === pb.prerelease) return 0
  if (pa.prerelease == null) return 1   // 正式版 > 预发布
  if (pb.prerelease == null) return -1
  return pa.prerelease < pb.prerelease ? -1 : 1
}

/** `a` 严格高于 `b` 才 true；相等、任一侧不合法都 false（那两种情形调用方都该选内置）。 */
export function isStrictlyHigher(a: string | undefined | null, b: string | undefined | null): boolean {
  const cmp = compareVersions(a, b)
  return cmp != null && cmp > 0
}
