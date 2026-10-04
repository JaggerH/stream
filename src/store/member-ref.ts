const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 一个 `ProviderMemberRef` 的**运行时判据**——类型只在编译期，而成员从两条路进来：
 * 用户 PATCH（`src/http/app.ts`）与包声明（`package.json#stream.providers`，见
 * `src/packages/descriptor.ts`）。两处必须是同一条判据，否则包能声明一个 HTTP 面会拒的形状。
 */
export function isProviderMemberRef(v: unknown): boolean {
  if (!isObject(v)) return false
  if (v.params !== undefined && !isObject(v.params)) return false
  // name = 实例名（可选，**仅 {source} 成员**用）：同一个源带不同 params 多次进同一行时的寻址键。
  // 其余成员形状的寻址键不是它（auto 段展开出的成员按 source id，{provider} 组合成员按子行 id，
  // {fn} 按 fn 名），收下一个永远不会被读的 name = 让用户以为自己给这一档起了名字。
  const named = v.name !== undefined
  if (named && (typeof v.name !== 'string' || !v.name.length)) return false
  if (typeof v.fn === 'string' && v.fn.length > 0) return !named
  if (typeof v.source === 'string' && v.source.length > 0) return true
  if (typeof v.provider === 'string' && v.provider.length > 0) return !named // composition: 成员是另一个 Provider
  if (v.mode === 'auto' && typeof v.provides === 'string' && (v.provides as string).length > 0) return !named
  if (v.mode === 'auto' && typeof v.matches === 'string' && (v.matches as string).length > 0) return !named
  if (v.mode === 'auto' && typeof v.category === 'string' && (v.category as string).length > 0) return !named
  return false
}
