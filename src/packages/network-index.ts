import type { PackageNetwork } from '../devices/placement.ts'

/** 包的执行位置相关声明投影。hosts 缺省 = credentials：能拿到哪个站的登录态，就能访问哪个站。 */
export function packageNetwork(pkg: { id: string; facility?: string; credentials?: string[]; network?: { hosts: string[] } }): PackageNetwork {
  return {
    packageId: pkg.id,
    facility: pkg.facility ?? pkg.id,
    hosts: pkg.network?.hosts ?? pkg.credentials ?? [],
  }
}
