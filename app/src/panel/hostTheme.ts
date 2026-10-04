/**
 * 把 DSH 宿主页面此刻的明暗态镜像到面板自己这棵子树的根元素上。
 *
 * **两处都要挂：面板根 + `document.body`。** Stream 的 dark 变体（`entry.css` 的
 * `@custom-variant dark (&:is(.dark *))`）认的是"任意祖先带 `.dark`"——挂在面板根上，
 * 面板这棵子树就都吃得到。但**我们有一批 DOM 根本不在这棵子树里**：Radix 的浮层
 * （Sheet / Dialog / Popover / DropdownMenu / HoverCard / ContextMenu / Tooltip）一律
 * portal 到 `document.body`，那是 DSH 的 body。它们在 DOM 上没有任何 `.dark` 祖先，
 * 于是**永远按浅色档渲染**：暗色宿主下「管理频道」这类 sheet 整片是白底黑字。
 * 挂到 body 上，portal 出去的那批才吃得到。
 *
 * **为什么这不算侵入宿主**：`.dark` 只改我们自己那套 token（`--background`/`--foreground`
 * 等）的取值，DSH 的界面用的是它自己的 `--dsw-*`，两套不相干。实测（2026-08-18，活体
 * 逐项对照）：加上 `.dark` 前后 DSH 的侧栏底色、按钮色、分区标题色**三项完全相等**，
 * 变的只有我们的 sheet（白 → `rgb(28,28,30)`、文字转白）。
 * 唯一被连带改到的是 `document.body` 自己的背景色——但那本来就已经是我们在画了
 * （`entry.css` 的 Tailwind preflight 是全局的），而且此前在暗色宿主下画的是**白色**，
 * 只是被上层不透明表面盖住看不见。所以这一改是把一处本来就错的颜色改对，不是新增侵入。
 *
 * **代价说清**：body 上的这个类是全页面共享的一份状态，所以卸载时必须摘掉（见下）。
 * 想彻底不碰 body，唯一的替代是给每个 Radix 浮层传 `container` 指进我们的子树——那要
 * 横穿一整套 acrylic 组件，且往后每加一个浮层都得记得传，漏一个就是静默白底。
 *
 * **真信号是什么**：DSH 的主题只有一处投影点——`@deepseek-ai/dsh-client-ui-layout`
 * 的 `ThemePresenter`（`lib/client.js`）每次 `ctx.theme` 变化（含用户手动切换）就同步
 * 把 `active.colorScheme` 写进 `document.body` 的 `data-ds-dark-theme` 属性：暗色时
 * `setAttribute`、亮色时 `removeAttribute`。这是 DSH 自己声明的"当前 colorScheme 的
 * 语义结果"，不是从背景色反推出来的猜测。同一次写入还会设
 * `document.documentElement.style.colorScheme`，语义等价；选 body 属性是因为它是纯布尔
 * 存在性，判断最直接。
 *
 * **必须跟着变，不能只读一次**：用户能在面板开着的时候切 DSH 的主题偏好——本仓库已经
 * 为"装配期取的值 = 冻住的答案"这类一次性快照吃过好几次亏，这里同样：挂
 * `MutationObserver` 盯 `body` 的这一个属性，调用方（`entry.tsx`）在 `unmount()` 时
 * 用返回的函数收掉，不能让观察者跟着面板一起卸载却还挂在 `document.body` 上。
 */
export const HOST_DARK_ATTRIBUTE = 'data-ds-dark-theme'

export function isHostDark(): boolean {
  return document.body.hasAttribute(HOST_DARK_ATTRIBUTE)
}

/**
 * 订阅宿主明暗态：立即回调一次当前值，之后每次属性翻转再回调。`watchHostTheme` 是它的一个
 * 消费者（把值镜像成 `.dark` 类）；外接面板要把同一个值推给 iframe 里的网页，是另一个。
 * @returns 停止订阅。
 */
export function subscribeHostDark(onChange: (dark: boolean) => void): () => void {
  onChange(isHostDark())
  const observer = new MutationObserver(() => onChange(isHostDark()))
  observer.observe(document.body, { attributes: true, attributeFilter: [HOST_DARK_ATTRIBUTE] })
  return () => observer.disconnect()
}

/**
 * 开始镜像：立即同步一次当前状态，然后跟随后续的属性变化。
 * @param root - 面板自己这棵子树的根元素（`entry.tsx` 的 `el`，`mount()` 拿到的宿主容器）。
 * @returns 停止观察**并把 body 上那个类摘掉**。面板卸载时必须调用：观察者会一直挂在 DSH
 *   共享的 `document.body` 上，而 `.dark` 是留在宿主页面上的一份共享状态——面板都不在了
 *   还留着它，等于我们走了但把别人的页面按在暗色档上。
 */
export function watchHostTheme(root: HTMLElement): () => void {
  const apply = (): void => {
    const dark = isHostDark()
    root.classList.toggle('dark', dark)
    // portal 出去的浮层只有这一个祖先——理由见文件头注。
    document.body.classList.toggle('dark', dark)
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(document.body, { attributes: true, attributeFilter: [HOST_DARK_ATTRIBUTE] })
  return () => {
    observer.disconnect()
    document.body.classList.remove('dark')
  }
}
