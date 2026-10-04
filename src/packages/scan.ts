import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { manifestSchema } from '../manifest/loader.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { formatIssuePath, parseStreamDescriptor, type StreamDescriptor } from './descriptor.ts'
import { localNamespace, localSourceIdProblem } from '../registry/source-id.ts'

/** 一个落在盘上的 Stream 包：描述 + 它所在的目录。 */
export interface StreamPackage extends StreamDescriptor {
  /** 包目录绝对路径 */
  dir: string
}

/**
 * 这个包的 **sourceId 命名空间前缀**（全名 = `<前缀>/<局部名>`）。
 *
 * 正常情况就是它的 npm 包名——全局唯一性因此由 npm registry 保证，宿主不维护任何表。
 * 用户手放进 `<dataDir>/recipes/` 的本地开发包没有 `package.json#name`，用
 * `local/<目录名>` 兜底：不回答这一格，手放包就成了"任何名字都行"的后门，正好绕开
 * 这道边界；而 `local/` 前缀与任何 npm 名都不相等，所以它**不参与覆盖**。
 */
export function packageNamespace(pkg: Pick<StreamPackage, 'pkgName' | 'dir'>): string {
  return pkg.pkgName ?? localNamespace(basename(pkg.dir))
}

export interface ScanPackagesOptions {
  /**
   * 顶层出现 `*.yaml` / `*.yml` 时怎么办。
   * - `'throw'`（默认）：仓库自带的内置包目录（`packages/`）用这档——那里的 yaml 只可能是
   *   迁移遗漏，静默忽略会让人以为它还生效。
   * - `'ignore'`：**用户数据目录**用这档。那是用户自己的文件夹，放一个无关的 yaml 是他的自由，
   *   不该让后端启动整体失败。
   */
  leftovers?: 'throw' | 'ignore'
  /**
   * 给了它，**一个包读坏只掉它自己那一格**：报一条、跳过，接着扫下一个包；不给就照旧整层抛。
   *
   * 只有启动路径该给。启动期抛出去 = 后端起不来，而用户唯一的恢复手段是自己去文件系统把包
   * 删掉——一个坏包不该有这么大的权力。安装期、热重载期照旧抛（各自有别的接法）。
   */
  onPackageError?: (pkgDir: string, err: Error) => void
}

/**
 * 扫一层目录，把每个 `<dir>/<name>/package.json` 读成一个 Stream 包。
 * 没有 package.json 的子目录不是包（跳过）；顶层残留的 *.yaml 默认大声拒绝（见 leftovers）。
 */
export function scanPackages(dir: string, opts: ScanPackagesOptions = {}): StreamPackage[] {
  const leftovers = opts.leftovers ?? 'throw'
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
  } catch (e) {
    // ENOENT (dir doesn't exist) is the only "nothing to scan" case — treat as empty.
    // Anything else (EACCES, ENOTDIR, ...) is a real failure and must not be swallowed into
    // a silent empty set, which would look like "zero packages" instead of an error.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }

  // 一个包一格：抽成函数是为了让 onPackageError 能把 try 收在**包**的粒度上——
  // 内联在循环里就只能整层 try，那等于把「跳过坏包」变成「跳过其余全部好包」。
  const readOne = (name: string): StreamPackage | undefined => {
    const pkgDir = join(dir, name)
    const pkgPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgPath)) return undefined

    const label = `${name}/package.json`
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch (e) {
      throw new Error(`Invalid Stream package ${label}: ${(e as Error).message}`)
    }
    const desc = parseStreamDescriptor(raw, label)

    const manPath = join(pkgDir, 'manifests.yaml')
    if (existsSync(manPath)) {
      if (desc.sources) {
        throw new Error(`Stream package ${name} declares sources in both package.json and manifests.yaml`)
      }
      const rawSources = parseYaml(readFileSync(manPath, 'utf8'))
      if (rawSources != null) {
        if (!Array.isArray(rawSources)) {
          throw new Error(`Stream package ${name}: manifests.yaml must be a list of sources`)
        }
        desc.sources = rawSources.map((entry, i) => {
          const parsed = manifestSchema.safeParse(entry)
          if (!parsed.success) {
            const issue = parsed.error.issues[0]
            const path = formatIssuePath(issue?.path ?? [])
            throw new Error(`Stream package ${name}: manifests.yaml[${i}]: ${path} — ${issue?.message}`)
          }
          const m = parsed.data as SourceManifest
          // manifests.yaml 里写的同样是**局部名**（与 recipe 的 `sourceId` 同一格文法）——
          // 全名由装载期用包的 npm 名合成。在这里拒，是因为这份 yaml 与 recipe 走的是两条
          // 装载路径，只在 validateRecipe 上钉一道就会从这一侧漏过去。
          const problem = localSourceIdProblem(m.id)
          if (problem) {
            throw new Error(`Stream package ${name}: manifests.yaml[${i}]: id ${problem}`)
          }
          return m
        })
      }
    }

    return { ...desc, dir: pkgDir }
  }

  const out: StreamPackage[] = []
  for (const ent of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isDirectory()) {
      // 顶层残留 yaml 是**层**的问题不是某个包的问题（没有包可跳过），所以 onPackageError
      // 不接它——照旧按 leftovers 的立场处理。
      if (leftovers === 'throw' && (ent.name.endsWith('.yaml') || ent.name.endsWith('.yml'))) {
        throw new Error(
          `Stream package dir ${dir}: unexpected top-level ${ent.name} — a Stream package is a folder ` +
          `containing a package.json, so nothing here reads this file`,
        )
      }
      continue
    }
    if (!opts.onPackageError) {
      const pkg = readOne(ent.name)
      if (pkg) out.push(pkg)
      continue
    }
    try {
      const pkg = readOne(ent.name)
      if (pkg) out.push(pkg)
    } catch (e) {
      opts.onPackageError(join(dir, ent.name), e as Error)
    }
  }
  return out
}
