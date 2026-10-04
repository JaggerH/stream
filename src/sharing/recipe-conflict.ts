import { compareSemver, sameMajor } from './semver.ts'

export type RecipeDecision =
  | { action: 'install' }
  | { action: 'upgrade'; from: string; to: string }
  | { action: 'reuse'; keep: string }
  | { action: 'ask'; from: string; to: string }

export function resolveRecipeConflict(
  incoming: { id: string; version?: string },
  installed: { id: string; version?: string } | null,
): RecipeDecision {
  if (!installed) return { action: 'install' }
  // T3 降级：无 version 信息（当前 facility 单包）→ 覆盖式 install。外部 scoped-身份 change
  // 补上 version 后，下面三分支自然生效，无需改此函数的调用点。
  if (!incoming.version || !installed.version) return { action: 'install' }
  if (!sameMajor(incoming.version, installed.version)) {
    return { action: 'ask', from: installed.version, to: incoming.version }
  }
  const cmp = compareSemver(incoming.version, installed.version)
  if (cmp > 0) return { action: 'upgrade', from: installed.version, to: incoming.version }
  return { action: 'reuse', keep: installed.version }
}
