import type { BrowserCookie } from './types.ts'

/** Join a domain's cookies into one RSSHub-style `name=value; name=value` header. */
export const cookieStr = (cookies: BrowserCookie[]): string =>
  cookies.map((c) => `${c.name}=${c.value}`).join('; ')

/** A transform turns a domain's scoped cookies into env overrides when a plain
 *  `{ [name]: cookieStr }` join can't express the mapping. */
export type CookieTransform = (cookies: BrowserCookie[]) => Record<string, string>

/**
 * 宿主手写的凭证转换，按 `AuthSpec.inject.ref` 索引。**只剩不属于本仓任何包的那些**——
 * 一个 facility 要的环境变量名由它自己的包声明（`stream.rsshubCookieEnv`，先于这张表被查，
 * 见 `src/credentials/cookie-provider.ts`）。往这里加一条之前先问：这个站有包吗？
 */
export const transformRegistry: Record<string, CookieTransform> = {
  // github's token is the VALUE of a single cookie, not a joined header
  github: (cookies) => ({
    GITHUB_PERSONAL_ACCESS_TOKEN: cookies.find((c) => c.name === 'user_session')?.value ?? '',
  }),
}
