import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 正则元字符按字面比。sourceId 的局部名里 `.` `-` 都合法（`a.b`），不转义就会把别人的文件认成自己的。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `<dataDir>/failures/<local>-<epochMs>.jpg` 里最近的 n 张（新的在前，绝对路径）。
 *
 * 任务书里塞给 agent 的「上次失败时页面长这样」就是这几张（`buildTaskBook.failureShots`）。
 * **目录不存在回空数组，不抛**：从来没失败过的源没有这个目录，那是常态不是错——为它抛一下
 * 会把整条修复会话变成 `agent_spawn_failed`，而真正的原因只是没有截图。
 */
export function latestFailureShots(dir: string, local: string, n: number): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const re = new RegExp(`^${escapeRe(local)}-(\\d+)\\.jpg$`)
  return names
    .map((f) => ({ f, at: Number(re.exec(f)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => b.at - a.at)
    .slice(0, n)
    .map((x) => join(dir, x.f))
}
