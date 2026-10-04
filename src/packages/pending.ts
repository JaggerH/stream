import type { StreamPackage } from './scan.ts'
import { packageNamespace } from './scan.ts'

/** 启动那一刻「装载了什么」的一格；`diffLoadedVsDisk` 拿它和盘上现扫的同形结构对账。 */
export interface LoadedPackage {
  name: string
  version?: string
  slots: { recipes: boolean; code: boolean; capability: boolean; backend: boolean; credentials: boolean }
  /** 容器镜像引用；`needsRestart` 的判据之一（换了 tag = 重启后重建） */
  image?: string
}

export interface PendingChange {
  name: string
  kind: 'installed' | 'updated' | 'removed'
  from?: string
  to?: string
  needsRestart: boolean
  /** 给人看的一句话：为什么要 / 不要重启 */
  why: string
}

/** 从包描述符投影成对账用的形状。`recipes` 看 `pkg.dir` 下有没有 `*.recipe.json`——这里不读盘：
 *  调用方（PackagesService）已经知道每个包有没有 recipe（inventory 的 `slots.recipes`），传进来即可。 */
export function loadedFromPackage(pkg: StreamPackage, hasRecipes: boolean): LoadedPackage {
  return {
    name: packageNamespace(pkg),
    ...(pkg.pkgVersion ? { version: pkg.pkgVersion } : {}),
    slots: {
      recipes: hasRecipes,
      code: !!pkg.code,
      capability: !!pkg.capability,
      backend: !!pkg.backend,
      credentials: (pkg.credentials?.length ?? 0) > 0,
    },
    ...(pkg.backend?.image ? { image: pkg.backend.image } : {}),
  }
}

/** 装上 / 换版后要不要重启：只有「进程内装载」和「容器」两类槽位要。 */
function restartReasonForPresence(p: LoadedPackage): string | null {
  if (p.slots.code) return '代码包要重启才装载'
  if (p.slots.capability) return '能力包（工具）要重启才挂上'
  if (p.slots.backend) return `容器要重启后按 ${p.image ?? '声明的镜像'} 重建`
  return null
}

/**
 * 「启动时装载的」vs「盘上现在的」——差异就是待生效清单。**不记账本**：账本会漂（手删目录、装完崩溃、
 * 两条 CLI 并发），而这两份都是可以随时重算的事实。判据只看槽位：recipe 数据热生效；代码 / 能力 /
 * 容器走启动路径，所以变了就要重启。凭证域**不单独算**判据（装 / 换 / 卸三条路同一把尺）：它是给
 * 代码 / 容器用的许可名单，脱开那三格自己没有意义，而那三格已经把「要重启」判出来了——单看它会让
 * 卸载和安装两条路得出不一样的答案。`slots.credentials` 留在结构里只为 `changed` 的逐格比较。
 */
export function diffLoadedVsDisk(loaded: LoadedPackage[], disk: LoadedPackage[]): PendingChange[] {
  const byName = (xs: LoadedPackage[]) => new Map(xs.map((x) => [x.name, x]))
  const l = byName(loaded)
  const d = byName(disk)
  const out: PendingChange[] = []
  for (const cur of disk) {
    const was = l.get(cur.name)
    if (!was) {
      const why = restartReasonForPresence(cur)
      out.push({ name: cur.name, kind: 'installed', ...(cur.version ? { to: cur.version } : {}), needsRestart: why !== null, why: why ?? 'recipe 数据已热生效' })
      continue
    }
    // slots 用 JSON 串比：靠的是两边都出自 `loadedFromPackage`、键序固定。换个来源（手拼对象）就会把同值判成变了。
    const changed = was.version !== cur.version || was.image !== cur.image || JSON.stringify(was.slots) !== JSON.stringify(cur.slots)
    if (!changed) continue
    const why = restartReasonForPresence(cur)
    out.push({
      name: cur.name, kind: 'updated',
      ...(was.version ? { from: was.version } : {}), ...(cur.version ? { to: cur.version } : {}),
      needsRestart: why !== null, why: why ?? 'recipe 数据已热生效',
    })
  }
  for (const was of loaded) {
    if (d.has(was.name)) continue
    // 与 restartReasonForPresence 同一把尺：进程内装载的（代码 / 能力）与容器要重启才真卸掉。
    const stillLoaded = was.slots.code || was.slots.capability || was.slots.backend
    out.push({
      name: was.name, kind: 'removed', ...(was.version ? { from: was.version } : {}),
      needsRestart: stillLoaded, why: stillLoaded ? '已装载的代码 / 能力 / 容器要重启才卸掉' : 'recipe 数据已热卸掉',
    })
  }
  return out
}
