/**
 * 包的运行时 SDK——带代码的 Stream 包（内置 7 个与第三方）**唯一允许**在运行时 import 的宿主代码。
 *
 * 包只靠三样东西：**类型**（`import type` 宿主 `src/`，编译期抹掉）、**`shared/`**（这里，纯函数 /
 * 常量 / 带鸭子标记的错误类，宿主与包同吃一份源码，被 inline 进包的 bundle 无害）、**`ctx`**
 * （`backendUrl` / `withAwake` / `readSource` / `cookieFor` / `login` / `log`——一切宿主单例只经它）。
 * 任何非类型的 `src/` import 都会被 `src/packages/self-contained.guard.test.ts` 判红：bundle 会把
 * 那份代码复制一遍——复制类让宿主 `instanceof` 失效，复制单例得到一张永远为空的表。
 */
export { ValidationError, isValidationError, ContentUnavailableError, isUnavailable } from './errors.ts'
export { mediaPlayUrl } from './media-url.ts'
export { extractImages, extractLinks, firstLink, toText, stripImages } from './html.ts'
export { BROWSER_UA } from './browser-ua.ts'
export { compareVersions, isStrictlyHigher, parseVersion, type ParsedVersion } from './semver.ts'
