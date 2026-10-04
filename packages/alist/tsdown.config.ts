/**
 * 一个入口、一个产物：`activate.ts` → `dist/index.js`。
 *
 * **这个文件名是契约，不是习惯**：第三方层装载带代码的 Stream 包时，`stream.code.entry` 只认
 * `dist/index.js` 这一个字面量（`src/packages/code-entry.ts`），安装门（`src/replay/recipe-install.ts`
 * 的 `isAllowedPackageFile`）的 tarball 白名单也只放行它。切出第二个 chunk 或改个目录名，包装得进去、
 * 后端 import 时才 `ERR_MODULE_NOT_FOUND`——整条链上没有一处会红，直到用户那边坏掉。
 *
 * 所以 **不切 chunk、不出 dts**：`shared/**` 那些相对 import 全部 inline 进这一个文件（装到的
 * `<dataDir>/recipes/<包>/` 下没有 node_modules，任何外部 import 都解不开）；`src/` 只允许
 * `import type`（守卫 `src/packages/self-contained.guard.test.ts`），bundle 时被抹掉。
 * `.d.ts` 对这个包没有消费者——它只被后端在运行时动态 import。
 *
 * **内置层不读这份产物**：`packages/index.ts` 的静态表仍 import `./activate.ts`；dist 只给 npm。
 *
 * 写成裸对象而不是 `defineConfig(...)`：包目录没有自己的 node_modules，这份文件又落在根 tsconfig 的
 * `include: packages/**` 里，`import 'tsdown'` 会让根 typecheck 依赖一个只为构建装的包。
 * 形状与 tsdown 的 `UserConfig` 一致；构建由根脚本 `scripts/bundle-code-packages.mjs` 统一调起
 * （`pnpm packages:bundle`）。
 */
export default {
  // 键名就是产物名：写成数组会出 `dist/activate.js`，装载器找的是 `dist/index.js`（实测过）。
  entry: { index: 'activate.ts' },
  format: 'esm',
  outDir: 'dist',
  dts: false,
  // 单入口理论上不会切 chunk，写死它是为了让"切了"变成构建期的失败而不是运行期的失败。
  noExternal: [/.*/],
  // 上一代产物留在盘上就会跟着进 tarball（`files` 出的是整个 `dist/`）。publish 闸
  // （`scripts/assert-npm-artifact.mjs`）会拒掉 dist 里的第二个文件，但那是 prepack 那一刻才红；
  // 每次构建先清空，让这件事根本不发生。
  clean: true,
}
