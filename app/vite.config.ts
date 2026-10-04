import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // dedupe react so a newly-added dep (e.g. vaul) can never pull a second copy →
  // "Invalid hook call" / null dispatcher. One React instance, always.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Shared pure-TS subscribe logic lives at the repo root and is consumed by both
      // the web app and the extension; the bundler inlines it at build (see shared/subscribe).
      '@subscribe': path.resolve(__dirname, '../shared/subscribe'),
      // 「这条 item 的正文该怎么取」的唯一判定（planExtract）——后端选分支、前端定按钮，
      // 同一份代码（shared/extract），别在前端复刻嗅探逻辑。
      '@extract': path.resolve(__dirname, '../shared/extract'),
      // npm 包名文法（isValidPackageName）——后端守安装门、前端判「这是不是包名」，
      // 同一份代码（shared/recipe-market），漂移了不会有测试报警。
      '@recipe-market': path.resolve(__dirname, '../shared/recipe-market'),
      // 「这首歌的专辑名是什么」的唯一解析（albumFromText）——两侧的结果流进同一个下游
      // （写进音频文件的 ID3 专辑标签：行内菜单下载走前端、下载整单走后端），
      // 判据一分家就是同一首歌两个入口下出两个专辑名，且没有测试会响。
      '@music': path.resolve(__dirname, '../shared/music'),
      // 一张卡的文案里最多点名几个集（MAX_CARD_EPISODES）——后端拼一句、前端拼另一句，
      // 两处对"列几个"给出两个答案时，读的人会以为它们说的是两件事，而漂移了没有测试会响。
      '@reconcile': path.resolve(__dirname, '../shared/reconcile'),
      // research run 的 feed guid 前缀（runGuid / runIdFromGuid）——后端拼、前端剥，
      // 同一份代码。分家过一次：前端拿带前缀的 guid 当 run id 去导航，详情路由的段校验
      // 不放行 `:`，整条列表点进去每一行都是 400，而两侧的测试夹具各写各的、都绿。
      '@research': path.resolve(__dirname, '../shared/research'),
      // 条目投影的出线形状 + 动作图标词表（ITEM_ACTION_ICONS）——后端装载期拿词表拒掉不认识的图标，
      // 前端拿它挑组件。两份各写一张，后端放行了一个前端画不出来的图标，按钮就静默消失。
      '@item': path.resolve(__dirname, '../shared/item'),
    },
    dedupe: ['react', 'react-dom'],
  },
  clearScreen: false,
  // allow Vite dev server to serve files from the repo root (for @subscribe outside app/)
  // 页面本身是从后端那扇门（:8900）取的——后端把非 /api、/ws、/_p 的路径反代到这里
  // （src/http/dev-frontend.ts）。但 HMR 是 WebSocket，那一层不转发 WS，所以让浏览器直连
  // Vite 自己的口：VITE_HMR_CLIENT_PORT=5273（scripts/dev.sh 设）。不设时保持默认行为
  // （clientPort = 页面端口），容器时代经 Caddy 的那条路正是靠默认值工作的。
  server: {
    host: '0.0.0.0',
    port: 5273,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname, '..')] },
    ...(process.env.VITE_HMR_CLIENT_PORT ? { hmr: { clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) } } : {}),
  },
  test: {
    // `dir` 是白名单，不是黑名单——app 的测试全在 src/ 下，这么声明一次，磁盘上再出现什么都进不来。
    //
    // 用 exclude 列举「不该扫的地方」是治标：磁盘上多一个产物目录，黑名单就得再追一条——而少追
    // 的那次不会报错，只会红一片（副本里的 *.test.ts 被当成前端测试跑、相对路径指不回源码）。
    // 出货侧也不拷测试件（scripts/build-server.mjs 的 SHIP_SKIP），两头都堵。
    dir: 'src',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // 每个测试跑完把所有 spy 还原。**这不是洁癖，是一类假红/假绿的来源**：对同一个方法二次
    // `vi.spyOn` 时 vitest **复用同一个 mock 实例、连调用记录一起留着**，于是后一个测试的
    // `spy.mock.calls` 里混着前一个测试的调用——断言"只调了一次"会看到两次，而单独跑那条又是绿的
    // （最难查的形状）。反过来也危险：忘了设实现的测试会悄悄跑在上一个测试的 mock 上。
    //
    // 代价：还原发生在**每个测试之前**，所以 `vi.mock` 工厂里（模块求值那一刻）设的行为
    // 连第一个测试都活不到——`vi.fn().mockResolvedValue(x)` 会变回返回 `undefined`，桩本身还在。
    // 于是组件里 `api.foo(...).then(...)` 炸在「读不到 then」上，**报错指向组件、不指向测试**，
    // 极难往测试配置上想（这条开关落地时就当场压红了 4 个测试）。
    // 规矩：工厂里只放 `vi.hoisted(() => vi.fn())` 的**空桩**，行为一律在 `beforeEach` 里装。
    restoreMocks: true,
    // `restoreMocks` **只管 `vi.spyOn` 造出来的 spy**——上面那条规矩要求的 `vi.hoisted(() => vi.fn())`
    // 空桩它一个都碰不到，调用记录会从文件第一个测试一路累加到最后一个。表现是"恰好调了 N 次"
    // 这类断言从第二条测试起必然失败，而每条**单独跑又都是绿的**；配上 `waitFor` 还会伪装成
    // 超时（永远等不到"恰好 1 次"，等满超时才报错），读起来像界面没反应，其实界面好好的。
    // RecipesPage 那一整片红灯就是这么来的，从 `0428bf78` 起就没绿过。
    // `clearMocks` 只清 `mock.calls`、不动实现，且在 `beforeEach` 之前跑，与上面那条规矩兼容。
    clearMocks: true,
  },
})
