/**
 * 「这串 OpenList token 是不是 48h JWT」——Stream 侧（决定要不要先去换永久 token 再递给插件）与
 * DSH 网盘插件侧（拒收 JWT）用同一把尺子（netdisk spec §5.3）。两份判据分家的后果是：Stream 认为
 * 递的是永久 token、插件认为收到的是 JWT（或反过来），而两边单看都正常。
 *
 * 判据按结构：三段 `.` 分隔的 base64url，且首段解出来是 `{"alg"…}` 那种 header。OpenList 的永久 token
 * 形如 `alist-<uuid><随机串>`，一眼分得开；这里不按前缀判——前缀是上游实现细节，JWT 的三段结构才是标准。
 */
export function isJwtLike(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return false
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: unknown }
    return typeof header === 'object' && header !== null && 'alg' in header
  } catch {
    return false
  }
}
