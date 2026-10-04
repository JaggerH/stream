#!/usr/bin/env node
/**
 * 给带代码的内置包出 npm 用的预编译产物：`packages/<x>/activate.ts` → `packages/<x>/dist/index.js`。
 *
 * 用法：
 *   node scripts/bundle-code-packages.mjs                 # 全部：`packages/*` 里填了 `stream.code` 的每一个
 *   node scripts/bundle-code-packages.mjs packages/xhs    # 只这几个目录（包自己的 `bundle` 脚本传 `.`）
 *
 * 为什么是根脚本而不是每包 `"bundle": "tsdown"`：内置包目录没有各自的 node_modules，`tsdown` 只装在
 * 仓库根；哪个包该出 dist 也不该靠手写清单——判据就是 `package.json#stream.code` 在不在，和装载器
 * 同一把尺（漏一个的表现是那个包发上 npm 之后 `stream.code.entry` 指着一个不存在的文件，装得进、
 * 起不来）。
 *
 * 每个包的形状在它自己的 `tsdown.config.ts`（单入口、`noExternal` 全内联、不出 dts）；这里只负责
 * 找到 tsdown、逐包以包目录为 cwd 调它、任一包非 0 就整体失败。
 *
 * tsdown 从根 `node_modules/.bin/tsdown` 取；`STREAM_TSDOWN_BIN` 可以指一份别处的二进制（worktree 里
 * 根依赖没刷新时借主检出那份用）。两处都没有就带着安装提示退出 1——静默跳过等于"构建成功、产物没有"。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(repoRoot, 'packages')

/** `packages/*` 里填了 `stream.code` 的包目录（绝对路径），按目录名排序，输出稳定。 */
export function codePackageDirs(dir = packagesDir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const pkgDir = join(dir, name)
    const manifest = join(pkgDir, 'package.json')
    if (!statSync(pkgDir).isDirectory() || !existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (pkg?.stream?.code) out.push(pkgDir)
  }
  return out
}

export function resolveTsdown() {
  const candidates = [process.env.STREAM_TSDOWN_BIN, join(repoRoot, 'node_modules', '.bin', 'tsdown')].filter(Boolean)
  return candidates.find((p) => existsSync(p))
}

function main(argv) {
  const dirs = argv.length ? argv.map((a) => resolve(process.cwd(), a)) : codePackageDirs()
  if (dirs.length === 0) {
    console.error('[bundle-code-packages] 没找到任何带 stream.code 的包——packages/ 目录搬了？')
    return 1
  }
  const tsdown = resolveTsdown()
  if (!tsdown) {
    console.error(
      '[bundle-code-packages] 找不到 tsdown：根 node_modules/.bin/tsdown 不存在，STREAM_TSDOWN_BIN 也没指。\n' +
        '  在仓库根 `pnpm add -D tsdown`（能力包用的是 ^0.9.9，同一个版本），或临时 export STREAM_TSDOWN_BIN=<路径>。',
    )
    return 1
  }
  for (const pkgDir of dirs) {
    const config = join(pkgDir, 'tsdown.config.ts')
    if (!existsSync(config)) {
      console.error(`[bundle-code-packages] ${pkgDir} 没有 tsdown.config.ts——带 stream.code 的包必须有一份（照 packages/xhs/ 的）。`)
      return 1
    }
    console.log(`[bundle-code-packages] ${pkgDir}`)
    const r = spawnSync(tsdown, ['-c', config], { cwd: pkgDir, stdio: 'inherit' })
    if (r.status !== 0) {
      console.error(`[bundle-code-packages] ${pkgDir}: tsdown 退出 ${r.status ?? r.signal}，中止。`)
      return 1
    }
    const out = join(pkgDir, 'dist', 'index.js')
    if (!existsSync(out) || statSync(out).size === 0) {
      console.error(`[bundle-code-packages] ${pkgDir}: tsdown 退出 0 但 dist/index.js 不在或为空。`)
      return 1
    }
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
