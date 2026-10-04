import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { EmbeddedRecipePackage } from './bundle-format.ts'
import { dirNameFor, assertValidPackageName } from '../replay/recipe-install.ts'

/** 单个安全路径段判据（防内嵌包 facility 目录穿越 = 任意文件写）。判据本体住
 *  `src/safe-segment.ts`——HTTP 的 research 详情面守的是同一件事，两份会漂。 */
export { isSafeSegment } from '../safe-segment.ts'
import { isSafeSegment } from '../safe-segment.ts'

/** package.json 文本里的 `name` 字段（非字符串/空/坏 JSON → undefined）。 */
function parsePackageName(packageJson: string): string | undefined {
  try {
    const name = (JSON.parse(packageJson) as { name?: unknown }).name
    return typeof name === 'string' && name ? name : undefined
  } catch {
    return undefined
  }
}

/** 一个内嵌包的**落盘 / 去重身份**：优先 package.json#name（含 scope），无 name 才回落 facility 单段。
 *  npm 装的同一 logical 包走 `dirNameFor(name)` 落同名目录，两条路因此收敛到同一个目录（I-2）。
 *  这把尺同时用于分享导入去重表（installedRecipes 的 key），保证「已装」判定与「落哪个目录」一致。 */
export function embeddedPackageIdentity(pkg: EmbeddedRecipePackage): string {
  return parsePackageName(pkg.packageJson) ?? pkg.facility
}

/** 落盘身份是否合法——与 writeEmbeddedToDir 的落盘判据同源（有 name 过 npm 名语法，无 name
 *  校验 facility 单段）。返回 undefined 表示合法，否则返回原因。导入侧据此在落盘前优雅跳过坏包
 *  （pushNotice + continue），而不是让 writeEmbeddedToDir 抛出、掀翻整份 bundle 的其余配置。 */
export function embeddedDirNameIssue(pkg: EmbeddedRecipePackage): string | undefined {
  const name = parsePackageName(pkg.packageJson)
  if (name != null) {
    try {
      assertValidPackageName(name)
    } catch (e) {
      return (e as Error).message
    }
    return undefined
  }
  return isSafeSegment(pkg.facility) ? undefined : `facility 段非法（疑似目录穿越）：${pkg.facility}`
}

/** 从磁盘 recipe 包目录读成内嵌形态（原文逐字，导出侧用）。 */
export function readEmbeddedFromDir(pkgDir: string): EmbeddedRecipePackage {
  const packageJson = readFileSync(join(pkgDir, 'package.json'), 'utf8')
  const desc = JSON.parse(packageJson) as {
    author?: string
    version?: string
    stream?: { facility?: string }
  }
  const manPath = join(pkgDir, 'manifests.yaml')
  const manifestsYaml = existsSync(manPath) ? readFileSync(manPath, 'utf8') : undefined
  const recipeFiles: Record<string, string> = {}
  for (const f of readdirSync(pkgDir)) {
    if (f.endsWith('.recipe.json')) recipeFiles[f] = readFileSync(join(pkgDir, f), 'utf8')
  }
  return {
    facility: desc.stream?.facility ?? basename(pkgDir),
    author: desc.author,
    version: desc.version, // T3：当前包多半无 version，缺即 undefined
    packageJson,
    manifestsYaml,
    recipeFiles,
  }
}

/** 把内嵌包落到 <recipesUserDir>/<身份段>/（逐字写回，导入侧用）。零执行——只写文件。
 *  身份段与 npm install 对齐：有 name 走 `dirNameFor(name)`（`@scope/pkg`→`@scope__pkg`），
 *  同一 logical 包两条路因此落同一目录，交给既有 override 语义处理（I-2）。 */
export function writeEmbeddedToDir(pkg: EmbeddedRecipePackage, recipesUserDir: string): void {
  const name = parsePackageName(pkg.packageJson)
  let seg: string
  if (name != null) {
    // name 是不可信输入（bundle 来自外部）——落盘前必须过 npm name 语法，非法直接抛，别落盘。
    assertValidPackageName(name)
    seg = dirNameFor(name)
  } else {
    // C1 防目录穿越：无 name 回落 facility，仍必须是单个安全段，否则可写到 recipesUserDir 之外。
    if (!isSafeSegment(pkg.facility)) throw new Error(`非法 recipe facility 段（目录穿越）：${pkg.facility}`)
    seg = pkg.facility
  }
  const dir = join(recipesUserDir, seg)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), pkg.packageJson)
  if (pkg.manifestsYaml != null) writeFileSync(join(dir, 'manifests.yaml'), pkg.manifestsYaml)
  for (const [fileName, text] of Object.entries(pkg.recipeFiles)) {
    // 防目录穿越：只接受纯文件名
    writeFileSync(join(dir, basename(fileName)), text)
  }
}
