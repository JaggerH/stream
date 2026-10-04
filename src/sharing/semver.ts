export interface Semver { major: number; minor: number; patch: number }

export function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3] }
}

/** -1 若 a<b, 0 若相等, 1 若 a>b。无法解析的一侧按 0.0.0 处理。 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a) ?? { major: 0, minor: 0, patch: 0 }
  const pb = parseSemver(b) ?? { major: 0, minor: 0, patch: 0 }
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] > pb[k]) return 1
    if (pa[k] < pb[k]) return -1
  }
  return 0
}

export function sameMajor(a: string, b: string): boolean {
  return (parseSemver(a)?.major ?? 0) === (parseSemver(b)?.major ?? 0)
}
