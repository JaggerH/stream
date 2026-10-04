/**
 * 第三方包唯一被受理的**代码文件路径**。
 *
 * 三处判据读同一个字面量，所以它住在这里而不是任一处：安装门的白名单
 * （`src/replay/recipe-install.ts` 的 `isAllowedPackageFile` —— 「任何含 `/` 的路径一律拒」
 * 的铁律只对这一个字符串开例外，用 `===` 比）、描述符 schema 里 `stream.code.entry` 与
 * `stream.capability` 各自的取值。分成两份的代价是安静的：schema 松一格、门紧一格，
 * 包就变成「装得进描述、过不了门」或反之，而两边单看都正常。
 */
export const PACKAGE_CODE_ENTRY = 'dist/index.js'
