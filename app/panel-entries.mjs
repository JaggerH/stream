/**
 * 面板那几份 IIFE bundle 的入口表——**唯一一份**，`vite.panel.config.ts` 和
 * `scripts/build-panel.mjs` 都从这里读。
 *
 * 为什么单独一个 `.mjs`：构建脚本要在不启动 vite 的情况下知道"一共有哪几份"（`build:panel`
 * 不带参数时要挨个构建），而 vite 配置是 TS、由 vite 自己加载。两边各写一份清单的话，加了
 * 第六个 bundle 只改一处**不会报错**——只会少构建一份，而那一份要等到运行时才报「加载了
 * 但没有导出」。
 *
 * 加一个 bundle = 这里加一行 + 写它的 `src/panel/<name>-entry.tsx` + 在装载侧登记
 * （app 内部用 `createPanelBundleLoader`，工作台侧用 `createAssetLoader`）。
 */

/** 入口名 → 这一份产物的三格：入口源文件、IIFE 挂上去的全局名、产物基名。 */
export const PANEL_ENTRIES = {
  main: { src: 'src/panel/entry.tsx', global: '__streamPanel', file: 'panel' },
  detail: { src: 'src/panel/detail-entry.tsx', global: '__streamPanelDetail', file: 'panel-detail' },
  movie: { src: 'src/panel/movie-entry.tsx', global: '__streamPanelMovie', file: 'panel-movie' },
  research: { src: 'src/panel/research-entry.tsx', global: '__streamPanelResearch', file: 'panel-research' },
  manage: { src: 'src/panel/manage-entry.tsx', global: '__streamPanelManage', file: 'panel-manage' },
}

/** 入口名列表（`build:panel` 不带参数时按这个顺序全量构建）。 */
export const PANEL_ENTRY_NAMES = Object.keys(PANEL_ENTRIES)
