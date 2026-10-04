import { defineConfig } from 'vitest/config'

// globals:true 已去掉——这份 suite 也被根 vitest.config.ts 收进 CI 的 `pnpm test`（那份配置没有
// `globals`），两边都跑就必须两边都过；每个测试文件本来就显式 `import { describe, it, expect }
// from 'vitest'`，不依赖全局注入，去掉它不影响本地单独跑（`node_modules/.bin/vitest run`）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
