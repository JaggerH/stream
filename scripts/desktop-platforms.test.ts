// scripts/desktop-platforms.test.ts
//
// 这张表是「rust triple ↔ npm 平台包」的唯一真相源。钉三件事：
//   1. 认识的 triple 给出对的包（含 Windows 的 msvc/gnu 两条都指向同一个包——我们从 Linux
//      交叉编译到 windows-gnu，发布机可能用 msvc，两条都得认）。
//   2. 不认识的 triple **抛错**而不是猜：猜错的后果是二进制落进一个没人装的包，
//      而 npm 安装照样成功、插件运行时才报「没装」，真因离现场十万八千里。
//   3. 包名与它自己的 os/cpu 不许分家——分家了 npm 会在错的
//      平台上装它，同样不报错。（包名形状：`desktop-<os>-<cpu>`。）
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_AGENT_PLATFORMS, platformForTriple } from './desktop-platforms.mjs'

describe('platformForTriple', () => {
  it('Windows 两种 ABI 都指向同一个 win32-x64 包，且带 .exe', () => {
    expect(platformForTriple('x86_64-pc-windows-msvc')).toEqual({
      pkg: 'desktop-win32-x64', os: 'win32', cpu: 'x64', ext: '.exe',
    })
    expect(platformForTriple('x86_64-pc-windows-gnu').pkg).toBe('desktop-win32-x64')
  })

  it('mac 两个 triple 都有出货形态，且产物**没有扩展名**', () => {
    // mac 出的是「配对那一半」：桌面控制仍然只有 Windows（判据在 binary.ts 的
    // DESKTOP_CONTROL_PLATFORMS）。ext 为空串不是漏填——写成 '.exe' 的表现是二进制落在
    // 一个解析侧永远找不到的文件名上，而报出来的却是「平台包没装」。
    expect(platformForTriple('x86_64-apple-darwin')).toEqual({
      pkg: 'desktop-darwin-x64', os: 'darwin', cpu: 'x64', ext: '',
    })
    expect(platformForTriple('aarch64-apple-darwin')).toEqual({
      pkg: 'desktop-darwin-arm64', os: 'darwin', cpu: 'arm64', ext: '',
    })
  })

  it('linux 的 triple 抛错——没在真机上验过，也没人要，不是漏填', () => {
    expect(() => platformForTriple('x86_64-unknown-linux-gnu')).toThrow(/没有出货形态/)
  })

  it('不认识的 triple 抛错，且错误里带着那个 triple', () => {
    expect(() => platformForTriple('riscv64-unknown-linux-gnu')).toThrow(/riscv64-unknown-linux-gnu/)
  })

  it('每一项的包名与它的 os/cpu 一致（防止表自己内部分家）', () => {
    for (const [triple, p] of Object.entries(HOST_AGENT_PLATFORMS)) {
      expect(`desktop-${p.os}-${p.cpu}`, `${triple} 的包名和 os/cpu 对不上`).toBe(p.pkg)
    }
  })
})

describe('平台包目录', () => {
  it('表里每个 pkg 都有一个目录，且它的 package.json 与表一致', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    for (const p of new Set(Object.values(HOST_AGENT_PLATFORMS).map((x) => JSON.stringify(x)))) {
      const { pkg, os, cpu } = JSON.parse(p)
      const manifest = JSON.parse(
        readFileSync(join(root, 'capabilities/desktop/platforms', pkg, 'package.json'), 'utf8'),
      )
      expect(manifest.name).toBe(`@streamapp/${pkg}`)
      expect(manifest.os).toEqual([os])
      expect(manifest.cpu).toEqual([cpu])
      // 声明了 exports，插件那边按子路径 require.resolve 会解析失败——而症状是运行时
      // 「平台包没装」，与真的没装一模一样。
      expect(manifest.exports, `${pkg} 不该声明 exports`).toBeUndefined()
    }
  })

  /**
   * 插件包的 `optionalDependencies` 必须**逐字**钉着各平台包自己的 version。
   *
   * 分家的样子和"这台机器没这个平台包"一模一样：npm 装不到那个版本 → optional 依赖静默跳过
   * → 运行时只有一行「平台包没装」。发版时改了平台包却忘了改 pin，就是这个形状。
   */
  it('插件包 pin 的版本 = 各平台包自己的 version', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const plugin = JSON.parse(readFileSync(join(root, 'capabilities/desktop/package.json'), 'utf8'))
    const pkgs = new Set(Object.values(HOST_AGENT_PLATFORMS).map((x) => x.pkg))
    expect(Object.keys(plugin.optionalDependencies ?? {}).sort()).toEqual([...pkgs].map((p) => `@streamapp/${p}`).sort())
    for (const pkg of pkgs) {
      const manifest = JSON.parse(
        readFileSync(join(root, 'capabilities/desktop/platforms', pkg, 'package.json'), 'utf8'),
      )
      expect(plugin.optionalDependencies[`@streamapp/${pkg}`], `${pkg} 的 pin 和它自己的 version 分家了`)
        .toBe(manifest.version)
    }
  })
})
