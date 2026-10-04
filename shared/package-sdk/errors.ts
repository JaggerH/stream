/**
 * 包抛给宿主的两种"有含义的错误"。住在 `shared/` 是因为**宿主和包各吃一份同一源码**：
 * 带代码的包被 tsdown 打成自包含的 `dist/index.js`，这两个类会被 inline 进包的 bundle——
 * 于是宿主进程里同时存在两份类，包抛出的实例 `instanceof` 宿主那份**必然为 false**。
 *
 * 所以判定一律按**鸭子**：实例自带 `validation: true` / `unavailable: true` 自述标记，宿主只看字段
 * （`isValidationError` / `isUnavailable`），不认类。一个 `{ validation: true }` 谁都认得，跨 bundle、
 * 跨 SDK 版本都成立。**宿主任何地方不许写 `instanceof ValidationError`**——那会让包抛的 400 静默
 * 变成 502（调用方写错参数被报成"上游坏了"），没有一处会喊。
 */

/** 「调用方给错了参数」。包抛它，宿主翻 400；其余异常一律 502。 */
export class ValidationError extends Error {
  readonly validation = true as const
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** `e` 是否自述「参数不合法」：类实例或任何带 `validation: true` 字段的对象都算。 */
export function isValidationError(e: unknown): boolean {
  return e instanceof ValidationError
    || (typeof e === 'object' && e !== null && (e as { validation?: unknown }).validation === true)
}

/**
 * 「内容本身没有」——成员去站方要一件东西，站方明确答"这件不存在 / 被删了 / 没权限看"。
 *
 * 它和"解析器坏了"是两回事，混在一起两边都吃亏：
 *  - 调用点：一件被作者删掉的作品，回 502 是在说"我们这边挂了"，用户会去重试、去报修；
 *    正确的回执是 **404 + 站方原话**（`/api/media/play|dash` 的空结果分支据此分档）。
 *  - 健康账：把它记成源的 error，一个用户收藏夹里几十条失效链接就能把一个好端端的源刷成满屏红。
 *    成员管道（`src/providers/member-pipeline.ts`）对它**不记账**，同 `retryable` / `blocked` 那两档的待遇。
 *
 * 形状照 `retryable`（`src/retryable.ts`）/ `blocked`（`src/blocked.ts`）：错误自带 `unavailable: true`
 * 自述标记，由成员管道在 catch 处**一次性**判定并结构化带成 `InvokeMiss.unavailable`，下游只看
 * 字段、**不做字符串匹配**。
 *
 * 包侧用法：adapter 认出站方的"内容不可用"回执后 `throw new ContentUnavailableError(<站方原话>)`。
 */
export class ContentUnavailableError extends Error {
  readonly unavailable = true as const
  constructor(message: string) {
    super(message)
    this.name = 'ContentUnavailableError'
  }
}

/** `e` 是否自述「内容不可用」：类实例或任何带 `unavailable: true` 字段的对象都算。 */
export function isUnavailable(e: unknown): boolean {
  return e instanceof ContentUnavailableError
    || (typeof e === 'object' && e !== null && (e as { unavailable?: unknown }).unavailable === true)
}
