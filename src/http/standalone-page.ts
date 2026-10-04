// 8900 的独立正门——**没有任何对话宿主**时用户看到的那张脸（spec 2026-09-05 §6.0）。
//
// 它挂的是 `app/dist-panel/` 那几份 IIFE bundle（由 `mountPanelAssets` 从 `/panel/*` 发）：
// 主面板（收件箱 / 影视 / 音乐 / 研究，附属 bundle 由主面板自己按需装）与管理面板
// （包 / 凭据 / 组件）。左列的「空间 → 频道」树是同一份 bundle 的**第二个挂载点**
// （`mountNav`，DSH 侧栏挂的是同一份），这张页只决定把它摆在哪。**不恢复旧 SPA、不引
// Vite**：面板的挂载接口本来就支持无宿主挂载（不传 onAskChat 引用类动作自己说人话拒绝）。
//
// **版面**：整页只有两列——左边导航（`mountNav`）、右边内容（`mount`）。**没有顶栏**：
// 「Stream」这个标题、「管理」入口、明暗切换全在导航树自己那条 footer 里（面板的 `footer`
// 选项，见 `app/src/panel/nav/NavTree.tsx`），这张页只把回调递进去。
//
// **管理是一层弹层**，不是另一个页：内容区**挂一次就不再卸**（`#root` 上那棵树从头活到尾），
// 管理面板挂在盖在上面的 `#manage` 里，关掉就卸。这样"看一眼设置"不会把收件箱的滚动位置、
// 正在播的音频、已展开的详情全丢掉——切页那种做法每次都丢，而且不报错。
// 两份 bundle 的样式表因此**长期共存**（DSH 里的设置弹窗本来就是这样），谁也不摘谁。
//
// **为什么是一段自包含 HTML 字符串**：它服务的正是"什么都还没起来"的时刻——任何需要构建
// 产物、需要另一个服务的方案都会在真正需要它的那一刻一起失效。没有 import、没有构建步骤。
//
// **明暗**：面板跟的是 `document.body` 的 `data-ds-dark-theme`（`app/src/panel/hostTheme.ts`，
// 那是 DSH 的投影点）。独立页没有 DSH，由内联脚本自己维护这个属性：初值取
// prefers-color-scheme，导航 footer 里那颗按钮切换时写 localStorage 并同步属性。属性名与
// hostTheme.ts 逐字相同，由 standalone-page.test.ts 对照它的导出——两处分家 = 独立页永远
// 浅色，零报错。
import type { Hono } from 'hono'

/** 与 `app/src/panel/hostTheme.ts` 的 `HOST_DARK_ATTRIBUTE` 逐字相同（测试对照）。 */
const DARK_ATTR = 'data-ds-dark-theme'

/** 后端自己应答的前缀——兜底 `*` 绝不碰它们（与已退役的 mountStatic 同一张排除表，多一个 /panel）。 */
function ownedByBackend(pathname: string): boolean {
  return pathname.startsWith('/api') || pathname.startsWith('/_p') || pathname === '/ws'
    || pathname.startsWith('/panel') || pathname.startsWith('/assets')
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stream</title>
<!-- 主面板默认就挂，提前拉取；管理面板要点了「管理」才挂，只做低优先级预取。 -->
<link rel="preload" as="script" href="/panel/panel.js" />
<link rel="preload" as="style" href="/panel/panel.css" />
<link rel="prefetch" as="script" href="/panel/panel-manage.js" />
<link rel="prefetch" as="style" href="/panel/panel-manage.css" />
<style>
  /* color-scheme 跟着 body 上的主题属性走，不写 \`light dark\`：那样浏览器按系统偏好画滚动条与
     表单控件，用户切到浅色后滚动条仍是深的。 */
  :root { color-scheme: light }
  :root:has(body[${DARK_ATTR}]) { color-scheme: dark }
  html, body { margin:0; height:100% }
  body { display:flex; flex-direction:column; font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#f6f6f7; color:#1c1c1e }
  body[${DARK_ATTR}] { background:#111214; color:#e6e7e9 }
  #main { flex:1; min-height:0; display:flex }
  /* 左列是面板的导航挂载点（mountNav）：这张页自己不写任何导航逻辑，只决定摆在哪。
     「Stream」标题、「管理」入口、明暗切换都在那棵树自己的 footer 里。 */
  #nav { flex:none; width:280px; min-height:0; overflow:hidden; border-right:1px solid rgba(127,127,127,.25);
         display:flex; flex-direction:column }
  #nav > * { flex:1; min-height:0 }
  #root { flex:1; min-width:0; min-height:0; position:relative }
  /* 管理是盖在内容上的一层，不是另一个页——内容区那棵树从头活到尾，不会被"切页"卸掉。 */
  #manage { position:fixed; inset:0; z-index:50; display:flex; flex-direction:column;
            background:#f6f6f7; color:#1c1c1e }
  body[${DARK_ATTR}] #manage { background:#111214; color:#e6e7e9 }
  #manage-bar { flex:none; display:flex; align-items:center; gap:.75rem; padding:.4rem .9rem;
                border-bottom:1px solid rgba(127,127,127,.25) }
  #manage-bar b { flex:1; font-weight:600 }
  #manage-bar button { font:inherit; padding:.2rem .7rem; border:1px solid rgba(127,127,127,.4);
                       border-radius:999px; background:transparent; color:inherit; cursor:pointer }
  #manage-root { flex:1; min-height:0; position:relative; overflow:auto }
  #err { margin:1rem; padding:.75rem; border-radius:8px; background:rgba(255,80,80,.12);
         white-space:pre-wrap; font-size:12px }
  [hidden] { display:none !important }
</style>
</head>
<body>
<div id="main">
  <div id="nav"></div>
  <div id="root"></div>
</div>
<div id="manage" hidden>
  <div id="manage-bar">
    <b>管理</b>
    <button id="manage-close" type="button">关闭</button>
  </div>
  <div id="manage-root"></div>
</div>
<pre id="err" hidden></pre>
<script>
(() => {
  const DARK = '${DARK_ATTR}'
  const KEY = 'stream-theme'
  const backend = location.origin
  const root = document.getElementById('root')
  const nav = document.getElementById('nav')
  const err = document.getElementById('err')
  const manage = document.getElementById('manage')
  const manageRoot = document.getElementById('manage-root')

  // ── 明暗：独立页自己当投影点（hostTheme.ts 盯的就是 body 上这个属性）──
  // 开关那颗按钮不在这张页上，在导航树自己的 footer 里；这里只把「读 / 切」两件事递过去。
  const applyTheme = (dark) => { if (dark) document.body.setAttribute(DARK, '') ; else document.body.removeAttribute(DARK) }
  let dark
  try { dark = localStorage.getItem(KEY) === 'dark' || (localStorage.getItem(KEY) === null && matchMedia('(prefers-color-scheme: dark)').matches) }
  catch { dark = matchMedia('(prefers-color-scheme: dark)').matches }
  applyTheme(dark)
  const theme = {
    isDark: () => dark,
    toggle: () => {
      dark = !dark
      try { localStorage.setItem(KEY, dark ? 'dark' : 'light') } catch {}
      applyTheme(dark)
    },
  }

  const fail = (e) => { err.hidden = false; err.textContent = String(e && e.message || e) }

  // ── 注入一份 bundle（marker 属性判单例，与 panelBundleLoader.ts 同一套约定）──
  const ensureStylesheet = (file) => {
    if (document.querySelector('link[data-stream-bundle="' + file + '"]')) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.setAttribute('data-stream-bundle', file)
    link.href = backend + '/panel/' + file + '.css'
    document.head.appendChild(link)
  }
  const ensureScript = (file, global) => new Promise((resolve, reject) => {
    // 样式表**先于**那条早退保证到位：脚本只装一次、全局对象此后一直在，而样式表是另一个
    // 元素——它一旦不在（早年切页时被摘过），后面每次都从这儿早退，那份 CSS 再也回不来，
    // 表现是管理面板整块无样式，零报错。
    ensureStylesheet(file)
    if (window[global]) return resolve(window[global])
    const s = document.createElement('script')
    s.setAttribute('data-stream-bundle', file)
    s.src = backend + '/panel/' + file + '.js'
    s.onload = () => window[global] ? resolve(window[global]) : reject(new Error(file + '.js 加载了但没有导出 ' + global))
    s.onerror = () => { s.remove(); reject(new Error('加载 /panel/' + file + '.js 失败——后端没起，或还没 npm run build:panel')) }
    document.head.appendChild(s)
  })

  // ── 管理：盖在内容上的一层，开了才装它那份 bundle ──
  // 内容区不动（不卸不重挂），所以关掉弹层回到的是**原来那个现场**：滚动位置、正在播的
  // 音频、展开的详情都还在。两份 bundle 的样式表长期共存，谁也不摘谁。
  let manageMod
  const openManage = async (target) => {
    err.hidden = true
    try {
      manageMod = await ensureScript('panel-manage', '__streamPanelManage')
      if (!manage.hidden) { manageMod.show?.(target || { view: 'source-health' }); return }
      manageMod.mount(manageRoot, { backend, initial: target })
      manage.hidden = false
    } catch (e) { fail(e) }
  }
  const closeManage = () => {
    if (manage.hidden) return
    manage.hidden = true
    manageMod?.unmount()
    manageRoot.replaceChildren()
  }
  document.getElementById('manage-close').addEventListener('click', closeManage)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeManage() })

  // ── 内容与导航：挂一次，此后不再卸 ──
  ensureScript('panel', '__streamPanel').then((m) => {
    m.mountNav(nav, { backend, footer: { onManage: openManage, theme } })
    m.mount(root, { backend, manageWidth: false })
  }).catch(fail)
})()
</script>
</body>
</html>
`

/**
 * 挂独立正门：`/` 与 SPA 兜底 `*` 都回这张页。**必须最后挂**（在 mountPanelAssets 之后），
 * 否则 `*` 会抢先吞掉 /panel/*。
 */
export function mountStandalonePage(app: Hono): void {
  app.get('*', (c) => {
    const p = new URL(c.req.url).pathname
    if (ownedByBackend(p)) return c.notFound()
    // 只对"人在用浏览器看"的请求发这张页。取资源的请求拿到一段 HTML 只会变成一个语法错误
    // 或一张裂图，不如照实 404。
    const accept = c.req.header('accept') ?? ''
    if (!accept.includes('text/html')) return c.text('[stream] not found', 404)
    return c.html(PAGE)
  })
}
