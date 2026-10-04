/**
 * hostVersion 校验：包声明它要求的宿主版本下界，安装前校验。
 * 只支持 `>=X.Y.Z`（允许前后空格）——别的写法（^、~、x-range、латест 等）一律拒绝，
 * 而不是尝试猜测语义：装作看懂了比拒绝更危险。
 */

const RANGE_PATTERN = /^>=\s*(\d+)\.(\d+)\.(\d+)$/

function parseVersion(version: string, label: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) {
    throw new Error(`${label} 不是合法的版本号（期望 X.Y.Z）：${version}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/**
 * range 为空则直接通过。只支持 `>=X.Y.Z`（前后允许空格）；
 * 宿主版本不满足要求、或 range 写法不受支持时抛错。
 *
 * `hostVersion` 可能是 undefined（宿主版本读不到，见 readHostVersion）。那时 fail-closed：
 * 声明了 hostVersion 的包一律拒装。放行等于这道闸门静默失效，而失效的闸门比拒装危险得多。
 */
export function assertHostVersion(range: string | undefined, hostVersion: string | undefined, pkgName: string): void {
  if (range === undefined) return
  if (hostVersion === undefined) {
    throw new Error(
      `包 ${pkgName} 声明了 hostVersion "${range}"，但当前宿主版本读不到——无法判定，拒绝安装`,
    )
  }

  const trimmed = range.trim()
  const match = RANGE_PATTERN.exec(trimmed)
  if (!match) {
    throw new Error(
      `包 ${pkgName} 声明的 hostVersion "${range}" 不受支持——只支持 ">=X.Y.Z" 这一种写法`,
    )
  }

  const required: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const host = parseVersion(hostVersion, '宿主版本')

  if (compareVersions(host, required) < 0) {
    throw new Error(
      `包 ${pkgName} 要求宿主版本 >=${match[1]}.${match[2]}.${match[3]}，当前宿主版本是 ${hostVersion}`,
    )
  }
}
