import { defineConfig } from 'vitest/config'
import path from 'path'

// WXT's `vite()` hook in wxt.config.ts is a WXT build hook, not a config vitest reads,
// so the @subscribe alias must be declared here too for `vitest run`. Mirrors the build
// alias so tests resolve the repo-root shared/subscribe module the same way the bundle does.
export default defineConfig({
  resolve: {
    alias: {
      '@subscribe': path.resolve(__dirname, '../shared/subscribe'),
      '@browser-relay': path.resolve(__dirname, '../shared/browser-relay'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: { fs: { allow: [path.resolve(__dirname, '..')] } },
})
