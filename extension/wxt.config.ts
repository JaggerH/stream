import { defineConfig } from 'wxt'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// WXT config. Entry points live under src/entrypoints (srcDir: 'src').
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  // dev 期的浏览器是**用户自己那个**（带登录态、带他的窗口和标签），不是 web-ext 现开的一次性
  // 干净 profile —— 这条扩展链路（cookie 同步 / driver 骑他的标签）在干净 profile 里根本没有
  // 意义。所以关掉 web-ext 的自动开浏览器：`wxt` 只做「监视 + 重建 + 推重载」，装载由用户在
  // chrome://extensions 手动做**一次**（装 .output/chrome-mv3-dev），此后每次改代码扩展自己
  // runtime.reload()，不用再点。
  webExt: { disabled: true },
  // dev server 的口 —— 扩展里的 reload 客户端就连这里。挑一个不撞 8900/5273 的。
  //
  // **`host` 和 `origin` 都必须显式给，别用默认值**（2026-08-08 实测踩过）：
  // 默认 origin 是 `http://localhost:5279`，WXT 把它烘成 `__DEV_SERVER_ORIGIN__` 写进 bundle，
  // 于是扩展去连 `ws://localhost:5279`。而我们的 Chrome 在 Windows、dev server 在 WSL——
  // **Windows 的 Chrome 解析 `localhost` 优先拿到 `::1`**，那儿没人监听（默认只绑 IPv4 的
  // 127.0.0.1），于是 `ERR_CONNECTION_REFUSED`。
  //
  // 症状极其误导：磁盘上的 `.output/chrome-mv3-dev` 是新的（WXT 确实在重建），跑着的却一直是
  // 旧代码，而且**没有任何一处会喊**——SW 常驻一条 relay WS 永不回收，等不到"SW 重启顺带
  // 重连"那条自愈路径。真发生过：热重载断了两小时没人发现，最后是靠后端报
  // "unknown op" 才反推出来的。
  //
  // 所以：`host: '0.0.0.0'` 让它两个协议族都听得到，`origin` 给一个**字面 IPv4**，
  // 彻底绕开 `localhost` 的解析顺序。
  dev: { server: { host: '0.0.0.0', port: 5279, origin: 'http://127.0.0.1:5279' } },
  vite: () => ({
    plugins: [tailwindcss()],
    // Shared pure-TS subscribe logic lives at the repo root; WXT/Vite inlines it at build,
    // so the same logic is shared with the web app without a workspace package.
    resolve: { alias: {
      '@subscribe': path.resolve(__dirname, '../shared/subscribe'),
      '@browser-relay': path.resolve(__dirname, '../shared/browser-relay'),
    } },
    server: {
      fs: { allow: [path.resolve(__dirname, '..')] },
      // **走轮询不走 inotify**，和后端那条腿同一个理由、同一个开关（`dev.sh` 的
      // `CHOKIDAR_USEPOLLING`）——但必须在这里显式接进来：WXT 的重建监视复用的是 **Vite dev
      // server 自己的 watcher**（`server.watcher`，见 wxt/dist/core/create-server.mjs），
      // Vite 不读那个环境变量，所以 dev.sh 里 export 了也对扩展这条腿无效。
      //
      // 漏的形状很刁：inotify 档下 `git checkout` 改的文件**能**捕获，`git merge` 改的**捕获不到**
      // （实测 2026-08-19：同一个文件、同一个 watcher，checkout 12s 内重建并 reload，紧接着的
      // ff-merge 过 15s 产物 mtime 纹丝不动）。于是「改了没生效」只在 ff-merge 落地那一刻发生
      // ——也就是 agent 把活干完合进 main 的那一刻，而磁盘上的源码是新的、watcher 进程活着、
      // 日志干净，没有任何一处会喊。
      watch: {
        usePolling: process.env.CHOKIDAR_USEPOLLING !== '0',
        interval: Number(process.env.CHOKIDAR_INTERVAL ?? 100),
      },
      // **dev 期的 popup 是从这个 server 取模块的，而它的 origin 是 `chrome-extension://<id>`。**
      // Vite 默认只放行 http(s) 的 localhost 源（`defaultAllowedOrigins`），扩展页那个 origin
      // 不在里面：请求回 200 但**不带 `Access-Control-Allow-Origin`**，浏览器于是丢掉这个
      // 跨源 module script —— popup 一片空白，Network 里还全是 200，最难查的那种。
      // （background 不受影响：它是整包 bundle，不从 dev server 取模块。）
      cors: { origin: [/^chrome-extension:\/\//, /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/] },
    },
  }),
  manifest: {
    // 固定扩展 ID = dmhlfkdjljnilhnfajjpaobehenbokij（由此公钥派生，unpacked 装载也稳定）。
    // 私钥留存于 ~/.secrets/stream-extension/ext-key.pem，仅上架商店/自打包 crx 时需要（本地不需）。
    // 后端 /api/ext/{verify,cookies} 的 Origin 门控、以及 native messaging 清单的
    // allowed_origins，都精确匹配这个 ID。
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3J1pwzql3petxGDZQAVgvfUjO43NbudqqVzsGVajQ5u821WYwf91pmAh+noeJy4kaq7OV6wAtJYm82sstBrg4tEggBeUe1xG2uFPZfubB8Q1wVPRBVjD3w1ECtowz5VgCgGscLLqXXgfbGzYkzsa65k1aou6/7spu8evu/QShyaTVDLH0A8wO88xdYJI+/SqZhEG83Lgv3YAc6llZIDMd6BFS+Ts2vTFQjE6pfLIkbyfZQJq/n1/lKRNEitMf0ep0HVadZ9PY8FQ+7A4fMnvD+BJCxHuztwxW6mUI0BTFJspHiEWRgK9B4GtPrMbpu71aRBuUy2wuTKDD3rGEM/FvwIDAQAB',
    name: 'Stream Companion',
    description: 'Sync cookies into Stream and subscribe sources for the current page.',
    // tabGroups：给会话标签组起名/上色。归属模型的前提是这个组对用户可见可辨（拖进=授权、
    // 拖出=撤销），一块灰色无字的组认不出来，边界就没长在用户眼里。仅用于 update 标题/颜色。
    // system.display：零窗口时造采集窗口要按主显示器 workArea 显式给 bounds —— 因为
    // focused:false 与 state:'maximized' 是 Chrome 明令禁止的组合（详见 lib/driver.ts
    // 的 createUnfocusedFullscreenWindow）。没有它只能退回 Chrome 默认的窄窗口。
    // nativeMessaging：认后端身份的带外通道。扩展读不了文件，但拉得起 `stream-desktop`，
    // 由它去读 `data/ext-relay-token`（只有同一个用户读得到）。见 lib/native-host.ts —— 没有
    // 这一条，token 就只能向对端索取，谁抢到 127.0.0.1:8900 谁就拿走全部登录态。
    permissions: [
      'cookies',
      'storage',
      'alarms',
      'tabs',
      'tabGroups',
      'debugger',
      'system.display',
      'nativeMessaging',
    ],
    host_permissions: ['<all_urls>'],
  },
})
