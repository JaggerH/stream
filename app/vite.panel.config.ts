/**
 * 面板 bundle 的构建：IIFE，产物 `app/dist-panel/panel.js` + `panel.css`，
 * 由后端在 `/panel/*` 发出去（`src/http/panel-mount.ts`）。
 *
 * **必须是 IIFE 不能是 ES module**：面板由 DSH 那个口的页面跨源加载，
 * `<script type="module">` 要 CORS，普通 `<script>` 不要。
 *
 * alias 与主应用逐条一致——两份配置漂移了不会有任何测试报警，改一处记得改另一处。
 *
 * **一个入口一次调用**：`PANEL_ENTRY` 选下面那张表里的一行（不传 = `main`）。为什么不是
 * Vite lib 模式的多入口数组——Vite 对 `formats:['iife']` 只认单一入口（多入口是 umd/iife
 * 报的硬限制），而每份产物本来就该各自 `emptyOutDir`（后一次跑不能把前一次的产物冲掉），
 * 拆成多次独立调用最直接。附属 bundle 为什么必须是"另一个 IIFE"而不是 `React.lazy` 走
 * Rollup 自己的 chunk 分裂——见 `src/panel/panelBundleLoader.ts` 头注：IIFE/UMD 格式下
 * Rollup 没有跨 chunk 加载器，动态 `import()` 会静默内联回主文件，实测体积几乎不变、
 * 没有任何报错。
 *
 * **加第四个 bundle 就往表里加一行**，别再引第二个布尔——三个入口以上按布尔分叉会退化成
 * 一串互相排斥的三元表达式，而每一格（入口路径 / 全局名 / 产物基名）本来就是同一行数据。
 * 装载侧同样是加一行：`createPanelBundleLoader({ globalName, file, ... })`。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { PANEL_ENTRIES } from './panel-entries.mjs'

// 入口清单是**共享的一份**（`panel-entries.mjs`）：构建脚本要在不启动 vite 的情况下知道
// 一共有哪几份。两边各抄一份的话，加了第六个 bundle 只改一处不会报错——只会少建一份。
const ENTRIES = PANEL_ENTRIES

const entryName = process.env.PANEL_ENTRY ?? 'main'
// 打错一个名字就静默构建出 main 那份、覆盖掉它——比构建失败坏得多（产物看着齐全，
// 少的那一份运行时才报「加载了但没有导出」）。所以这里当场炸。
if (!(entryName in ENTRIES)) {
  throw new Error(`PANEL_ENTRY=${entryName} 不认识；可选：${Object.keys(ENTRIES).join(', ')}`)
}
const entry = ENTRIES[entryName as keyof typeof ENTRIES]!

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 面板走后端 `/panel/:file` 单层挂载（见 src/http/panel-mount.ts），那条路由永远够不到
  // `public/` 底下的东西（brand/、favicon.svg……）——默认行为会把整个 `app/public/` 拷进
  // `dist-panel/`，产物里全是永远发不出去的死重。关掉默认拷贝。
  publicDir: false,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@subscribe': path.resolve(__dirname, '../shared/subscribe'),
      '@extract': path.resolve(__dirname, '../shared/extract'),
      '@recipe-market': path.resolve(__dirname, '../shared/recipe-market'),
      '@music': path.resolve(__dirname, '../shared/music'),
      '@reconcile': path.resolve(__dirname, '../shared/reconcile'),
      '@research': path.resolve(__dirname, '../shared/research'),
      '@item': path.resolve(__dirname, '../shared/item'),
    },
    dedupe: ['react', 'react-dom'],
  },
  // **lib 模式不会替 `process.env.NODE_ENV`**（它假定消费方还有一层打包器会替），
  // 而 React 的 dev/prod 分支就读这个值 —— 于是产物一进浏览器就
  // `ReferenceError: process is not defined`，全局压根没设上，面板报「加载了但没有导出」。
  // 这条**测试和构建都抓不到**：jsdom 里 `process` 是存在的，构建也不求值。
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist-panel',
    // 每次调用共享同一个 outDir：后一次跑不能清空前一次刚写好的产物，反过来也一样。
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, entry.src),
      formats: ['iife'],
      name: entry.global,
      fileName: () => `${entry.file}.js`,
    },
    rollupOptions: {
      output: { assetFileNames: `${entry.file}.[ext]` },
    },
  },
})
