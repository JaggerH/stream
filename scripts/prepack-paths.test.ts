// scripts/prepack-paths.test.ts
//
// `prepack` 是 publish 前唯一那道闸（`scripts/assert-npm-artifact.mjs`：断言 `files` 里列的
// 每一项在盘上真有东西，防的是干净检出里发出一个空壳包）。它靠一条**相对包目录**的路径找到
// 自己，而那条路径没有任何东西守着。
//
// 为什么值得单独一条测试：路径错了不会在任何地方变红——它在 `npm publish` 那一刻才失败，
// 也就是**闸自己的引路条坏了，闸就等于不存在**，而你要到发版当天才知道。包一搬家（四个能力包
// 搬进 `capabilities/<x>/` 那次就深了一层）这条路径必然要改，且改漏了毫无症状。
//
// 判据只问一件事：`node <相对路径>` 里那个相对路径，从包目录 resolve 出来是不是一个真文件。
// 不执行它，也不关心它是哪个脚本——往后有包换用别的 prepack 脚本，这条照样守得住。
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { repoRoot } from '../src/http/build-identity.ts'

/** 会出货到 npm 的包清单（相对仓库根的 package.json 路径）。目录不在就跳过。 */
function packageManifests(): string[] {
  const out: string[] = []

  const capDir = join(repoRoot, 'capabilities')
  if (existsSync(capDir)) {
    for (const name of readdirSync(capDir)) {
      const p = join('capabilities', name, 'package.json')
      if (existsSync(join(repoRoot, p))) out.push(p)
    }
  }

  const platDir = join(repoRoot, 'capabilities/desktop/platforms')
  if (existsSync(platDir)) {
    for (const name of readdirSync(platDir)) {
      const p = join('capabilities/desktop/platforms', name, 'package.json')
      if (existsSync(join(repoRoot, p))) out.push(p)
    }
  }

  for (const p of ['hosts/dsh/package.json', 'cli/package.json']) {
    if (existsSync(join(repoRoot, p))) out.push(p)
  }

  return out
}

/** 从 `node <path> [args...]` 里择出那个相对路径；不是这个形状就返回 undefined。 */
function prepackScriptPath(prepack: string): string | undefined {
  const m = prepack.trim().match(/^node\s+(\S+)/)
  return m?.[1]
}

describe('prepack 的相对路径指得到真文件', () => {
  const manifests = packageManifests()

  // 清单本身要有内容：`packageManifests()` 全靠 existsSync，一旦目录整体改名它会安静地返回
  // 空数组，下面的 it.each 一条都不跑——那正是"全绿但什么都没验"。
  it('扫到了包清单', () => {
    expect(manifests.length).toBeGreaterThanOrEqual(5)
  })

  it.each(manifests)('%s', (rel) => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as {
      name?: string
      scripts?: Record<string, string>
    }
    const prepack = pkg.scripts?.prepack
    if (!prepack) return // 没有 prepack 的包不在本条判据范围内

    const scriptPath = prepackScriptPath(prepack)
    expect(scriptPath, `${rel} 的 prepack 不是 \`node <path>\` 形状：${prepack}`).toBeTruthy()

    const abs = resolve(join(repoRoot, dirname(rel)), scriptPath as string)
    expect(
      existsSync(abs),
      `${rel} (${pkg.name}) 的 prepack 指向 ${scriptPath}，从包目录 resolve 成 ${abs}，那里没有文件。` +
        '发布闸靠这条路径找到自己——路径断了，publish 当天才会知道，而那时闸已经形同虚设。',
    ).toBe(true)
  })
})
