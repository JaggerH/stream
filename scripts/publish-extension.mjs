#!/usr/bin/env node
// 把构建好的 Chrome 扩展发成 `@streamapp/chrome-extension`。
//
// **为什么要发这个包**：一份来源，两个消费者——Stream 后端（`shared/browser-relay/extension-dir.ts`
// 第二档）和 Stream Desktop（`@streamapp/desktop`；装它的人按定义没有 Stream 后端，也就没有面板上那张
// "物化扩展"的卡片）。两边解出的必须是同一份字节，否则扩展 id 一变就是**静默不配对**：
// native messaging 的 `allowed_origins` 只放行一个 id，对不上没有任何一处会报错。
//
// **版本号只有一个来源**：`extension/package.json` 的 `version`（wxt 把它写进 manifest）。
// 这里照抄 `manifest.json` 的 `version`，不接受命令行覆盖——手改一次，npm 上的版本和用户
// Chrome 里显示的版本就分家了，而排查"我装的是哪一版"只能靠这两个数对得上。
//
// 用法：
//   node scripts/publish-extension.mjs --dry-run   # 只组装 extension/.output/npm/，不发
//   node scripts/publish-extension.mjs             # 组装 + npm publish
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

export const BUILT_DIR = join(root, 'extension/.output/chrome-mv3')
export const NPM_DIR = join(root, 'extension/.output/npm')
export const TEMPLATE_DIR = join(root, 'extension/npm')

/**
 * 组装出可以 `npm publish` 的目录。纯函数（只吃两个路径、只碰这两个路径），好让测试不用
 * 真跑一次扩展构建就能钉住版本与 `files` 白名单。
 *
 * **先删后建**：留着上一次的 `chrome-mv3/` 残余文件，publish 出去的包里就会混着两代——
 * 症状是用户装了新版却看到旧行为，而 tarball 本身完全正常。
 *
 * @param built - 构建产物目录（`extension/.output/chrome-mv3`）。
 * @param out - 组装落点（`extension/.output/npm`）。
 * @returns 写出去的 `package.json` 内容。
 */
export function buildNpmDir(built, out) {
  const manifestPath = join(built, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `扩展产物不在：${manifestPath} —— 先跑 \`pnpm --dir extension build\`。` +
        '（不许在没有产物的情况下组装一个空包发出去：装它的人拿到的会是一个"装上了却不工作"的扩展。）',
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.version) throw new Error(`${manifestPath} 里没有 version`)

  const pkg = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'package.json'), 'utf8'))
  pkg.version = manifest.version
  // 模板自己带 `private: true`，好让在 `extension/npm/` 里手滑跑一次 `npm publish` 被 npm
  // 当场拒掉；真正要发的这一份必须把它摘掉，否则 publish 会失败。同理 `"//"` 那条只讲模板。
  delete pkg.private
  delete pkg['//']

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  cpSync(built, join(out, 'chrome-mv3'), { recursive: true })
  cpSync(join(TEMPLATE_DIR, 'index.js'), join(out, 'index.js'))
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  return pkg
}

/** 直接跑（不是被测试 import）时才动手。 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dryRun = process.argv.includes('--dry-run')

  console.log('[publish-extension] building the extension…')
  const build = spawnSync('pnpm', ['--dir', 'extension', 'build'], { cwd: root, stdio: 'inherit' })
  if (build.status !== 0) throw new Error('[publish-extension] `pnpm --dir extension build` 失败')

  const pkg = buildNpmDir(BUILT_DIR, NPM_DIR)
  console.log(`[publish-extension] staged ${NPM_DIR} — ${pkg.name}@${pkg.version}`)

  if (dryRun) {
    // 把 tarball 的文件清单打出来。`files` 白名单漏一格的症状是"包装上了、里面什么都没有"，
    // 而单测只能钉住那个数组的字面量——只有 npm 自己才知道它最终收了什么。
    spawnSync('npm', ['pack', '--dry-run'], { cwd: NPM_DIR, stdio: 'inherit' })
    console.log('[publish-extension] --dry-run：不发布。')
  } else {
    const pub = spawnSync('npm', ['publish'], { cwd: NPM_DIR, stdio: 'inherit' })
    if (pub.status !== 0) throw new Error('[publish-extension] npm publish 失败')
    console.log(`[publish-extension] published ${pkg.name}@${pkg.version}`)
  }
}
