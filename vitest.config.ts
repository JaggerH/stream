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
//
// 时区钉成 CI 那个（`.github/workflows/test.yml` 的 `TZ`）：排期与丢班判定的用例按本地时区算整点，
// 在 UTC 的机器上跑会挂 7 条。worker 进程继承这里的环境。
process.env.TZ = 'Asia/Shanghai'
// 跑测试会在系统临时目录里留两个工具缓存：Node 的编译缓存（worker 启动时建）与 tsx 自己的
// 缓存（测试里 spawn 的 tsx 进程建）。它们不是测试数据，但会污染「全量跑完 TMPDIR 里剩什么」
// 的检查；关掉即可，代价只是重复跑时多一点编译时间。
process.env.NODE_DISABLE_COMPILE_CACHE ??= '1'
process.env.TSX_DISABLE_CACHE ??= '1'
export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    // sidequest 不外部化：它的 inline runner 会在运行期原生 import jobs 清单（→ stream-task-job.ts
    // → task-routes.ts 的进程级路由表）。外部化时那份 import 绕开 vite，造出第二份模块图——
    // 路由表登记在 vite 那份上，job 跑在原生那份上，永远 "no route for this job"（双实例测试
    // 场景 3 的任务因此只能记 failed）。inline 进 vite 后，同一条 import 走模块 runner，
    // 两边是同一份模块、同一张路由表。
    server: { deps: { inline: [/sidequest/] } },
    exclude: [
      '**/node_modules/**',
      'app/**',
      'extension/**',
      'hosts/**',
      '**/.claude/**',
      // 运行期数据目录（gitignored）。跑着后端的检出里，`data/repair-work/<id>/` 下是 AI 修复
      // 留的整包副本——连测试文件一起，而它们的相对 import 在那个位置解析不到，于是每份副本
      // 给全量添 5 个 FAIL。它们不是这个仓库的测试。
      'data/**',
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
