import { defineConfig } from 'vitest/config'

// Backend tests only — the frontend (app/) and the browser extension (extension/) are
// self-contained packages with their own vitest config (jsdom env / @subscribe alias) and are
// not pnpm workspace members, so they're excluded here and run via their own `test` script.
//
// hosts/ is excluded too — each host bundle (hosts/dsh/ …) carries its own package manager and
// vitest config, and runs in CI through the dedicated `hosts` job, not through root `pnpm test`.
//
// 两个能力包（desktop / netdisk）都**不**排除——它们的 suite 跟着 CI 的根
// `pnpm test` 一起跑，这正是后端与包之间那几份契约（stream-desktop 平台包版本、cookie 服务名）
// 不漂的原因。desktop 那批不需要真的 stream-desktop 二进制（有二进制那几条自己会跳过），
// 所以也在这里。每个测试文件都显式 `import { describe, it, expect } from 'vitest'`
// （不吃 `globals: true`），这是能在这儿收编它们的前提。
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      'app/**',
      'extension/**',
      'hosts/**',
      '**/.claude/**',
    ],
    // 单 worker 实测可达 2.4GB，16 worker 峰值曾把 23GB 打穿；8 是 qrun 锁失守时的第二道保险（墙钟 58s→约 75s）。
    maxWorkers: 8,
    // 默认 5s 超时抓的是挂死，不是并行争抢——但本机全量并行下耗时是"轮"的属性不是测试的属性：
    // 2026-07-23 连跑 15 轮逐条记账，好轮全场最慢 1.2s，坏轮(全局抖动)里平时 500–900ms 的
    // sqlite 夹具测试被集体放大 8 倍冲到 4.4s、谁在抖动窗口里谁穿线——历史上"偶发变红的频道测试"
    // 就是这么来的（受害者随机，追单条测试永远追不到）。15s 让出争抢尾巴，仍能抓真·挂死。
    testTimeout: 15_000,
    // hook 也要一起抬：全局抖动打的是**整轮**，重 sqlite 夹具的 `beforeEach` 先于 `it` 撞线
    // （实测 `src/http/app.test.ts` 报 `Hook timed out in 10000ms`）。只抬 testTimeout 等于
    // 把同一个抖动挪到 hook 上报，坏轮照样红。
    hookTimeout: 15_000,
  },
})
