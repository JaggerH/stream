/**
 * 动作 recipe 的**文件产物**落盘（`output.files`，见 `RecipeOutput.files` 头注）。
 *
 * 页内脚本只能把二进制编成 base64 交出来；这里把它写成文件，结果里那一格换成绝对路径。
 * 调用方拿到路径就是它要的东西（拿到 base64 的第一件事本来就是写盘），而账本
 * （`agent-runs.db`）里存的结果从几十 MB 变成几百字节——账本拒收超过 1MB 的 result
 * （`RESULT_MAX_BYTES`），所以文件类产物**没有第二条路**。
 *
 * 目录是平的：`<dir>/<时间戳>-<随机>.<ext>`，回收按文件 mtime（`pruneArtifacts`）。不按 runId
 * 分目录，因为同步壳（没有 run 库的装配）根本没有 runId，而回收本来就只看时间。
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { RecipeOutputFile } from '../replay/recipe.ts'

/** 产物默认留多久。拿走就没用了，7 天是给「异步跑完、隔天才来轮询」留的余量。 */
export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60_000

/** `png` / `jpg:0.8` / `../x` → `png` / `jpg` / `bin`：只留字母数字，冒号后的质量参数丢掉。 */
export function artifactExt(spec: RecipeOutputFile, item: Record<string, unknown>): string {
  const raw = spec.ext ?? (spec.extFrom ? String(item[spec.extFrom] ?? '') : '')
  const cleaned = raw.split(':')[0].toLowerCase().replace(/[^a-z0-9]/g, '')
  return cleaned || 'bin'
}

/**
 * 把 `items` 里声明为文件的字段写成文件，**原地**把字段值换成绝对路径；回写了几个。
 * 字段缺席 / 不是字符串就跳过——缺不缺由 recipe 的 `assert` 说，这里不重复判。
 */
export function spillArtifacts(
  dir: string,
  files: Record<string, RecipeOutputFile>,
  items: Record<string, unknown>[],
): number {
  let written = 0
  for (const item of items) {
    for (const [field, spec] of Object.entries(files)) {
      const v = item[field]
      if (typeof v !== 'string' || !v) continue
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
      const path = resolve(join(dir, `${stamp}-${randomBytes(4).toString('hex')}.${artifactExt(spec, item)}`))
      writeFileSync(path, Buffer.from(v, 'base64'))
      item[field] = path
      written++
    }
  }
  return written
}

/** 删掉 mtime 早于保留期的产物文件；目录不存在 = 0。 */
export function pruneArtifacts(dir: string, keepMs = ARTIFACT_RETENTION_MS, now = Date.now()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const p = join(dir, name)
    try {
      if (statSync(p).mtimeMs < now - keepMs) {
        unlinkSync(p)
        removed++
      }
    } catch {
      // 并发删掉了 / 不是普通文件：跳过，不让一条坏文件把整轮清理掀翻。
    }
  }
  return removed
}
