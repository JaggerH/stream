import { defineConfig } from 'tsdown'

/**
 * 一个入口、一个产物：`dist/index.js`。
 *
 * **这个文件名是契约，不是习惯**：Stream 包的能力槽位（`package.json#stream.capability`）只认
 * `dist/index.js` 这一个字面量，安装门（`src/replay/recipe-install.ts`）的 tarball 白名单也只
 * 放行它。切出第二个 chunk 或改个目录名，包装得进去、后端 import 时才 `ERR_MODULE_NOT_FOUND`
 * ——整条链上没有一处会红，直到用户那边坏掉。
 *
 * 所以 **不切 chunk、不出 dts**：`shared/netdisk/` 那些相对 import 全部 inline 进这一个文件
 * （装到的 `<dataDir>/recipes/<包>/` 下没有 node_modules，任何外部 import 都解不开）。
 * `.d.ts` 对这个包没有消费者——它不再被别的 TS 工程 import，只被后端在运行时动态 import。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'dist',
  dts: false,
  // 单入口理论上不会切 chunk，写死它是为了让"切了"变成构建期的失败而不是运行期的失败。
  noExternal: [/.*/],
  // 上一代产物留在盘上就会跟着进 tarball（`files` 出的是整个 `dist/`），而 publish 闸只查
  // "该在的在不在"，查不出多余的。
  clean: true,
})
