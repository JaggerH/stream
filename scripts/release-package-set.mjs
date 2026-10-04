/**
 * 发行包里默认带哪些内置包的唯一例外名单。
 *
 * 这些内容类适配器仍是独立、可发布的 `@streamapp/<id>` 包；只是不替新装用户
 * 默认选择。用户需要时经 `stream add @streamapp/<id>` 安装，和其他可选包走同一
 * 条安装与审计链路。
 */
export const OPT_IN_CONTENT_PACKAGES = Object.freeze([
  '1lou',
  'bt0',
  'btbtla',
  'iqiyi',
  'shooter',
  'toubiec',
  'zuna',
])

const optInPackages = new Set(OPT_IN_CONTENT_PACKAGES)

/** 包目录名是否属于默认发行集合。 */
export function shouldShipPackage(id) {
  return !optInPackages.has(id)
}
