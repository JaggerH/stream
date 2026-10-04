import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // 真包的 client 产物是 DSH 页面装载器的信封（`window.__ModuleLoader__.load`），
      // vitest 一 import 就炸。浏览器里那条路是对的（我们的产物 require 同一个 id，
      // 和 DSH 自家客户端包同形），只有测试要个替身。理由详见替身文件头注。
      '@deepseek-ai/dsh-api-session-controller/client': new URL('./test/stubs/dsh-api-session-controller.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    server: {
      deps: {
        // 壳从 ui-primitives 引图标/Tooltip，它的入口带一条 `import "katex/….css"`。
        // 不内联时 Node 的 ESM loader 直接吃到 .css 报 Unknown file extension；
        // 内联让 Vite 管这条 import（测试里 css 是 no-op）。
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
