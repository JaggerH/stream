/**
 * 「怎么在一个页面上做一次动作」——**翻译层的契约**，与它的一个通用等待原语。
 *
 * 这一层只认选择器、像素和 URL；它不知道什么是卡片、什么是信息流、什么是 recipe。**认识那些
 * 概念的方法一律不属于这里**——它们在 `src/replay/actions.ts` 的 `PageDriver` 里（那个接口
 * `extends` 本接口，把 `openItem` / `readItems` / `findCard` 那几格加回去）。
 *
 * 这条线是这么划的：**能不能被一个没有 Stream 后端的宿主用上**。DSH 插件
 * （`@streamapp/desktop`）要驱动用户自己的 Chrome，它没有 recipe、没有 dom-harvest、没有卡片
 * 身份；把整个 `PageDriver` 搬进来，就要把整棵采集引擎（`recipe.ts` / `dom-harvest.ts` /
 * `card-id.ts`）一起拖进插件的 bundle，而 `closure.test.ts` 钉着「本库运行时不许 import
 * `src/`」正是为了挡住这个。所以拆的不是文件，是**分层**：编排层的词汇从翻译层里择出去。
 *
 * 历史与代价写在明处：在这次拆分之前，插件为了拿到这一层，把它**重新实现了一遍**
 * （`capabilities/desktop/src/chrome-deps.ts`），两份拷贝随后悄悄分了家——一处漏了后台标签的
 * 焦点模拟（此后每次输入必然撞穿中继 30s 超时），一处 `goto` 会拿正要离开的那一页交差。两处
 * 都不会让任何测试变红。别再复制这一层；要一个宿主专属的差异，就往
 * {@link ExtDriveOptions} 那样加一个**参数**。
 */

/** 当前滚动几何——判「还没到底」「到底了」「滚不动」用的三个数。 */
export interface ScrollGeometry {
  scrollY: number
  viewportH: number
  scrollHeight: number
}

/**
 * 一个页面能被驱动的那一面（翻译层）。
 *
 * 可选的几格是**能力申报**，不是随手加的宽松：一个只会发 XHR 的 driver 提供不了 `shotOf`，
 * 调用方必须能分辨「这个 driver 做不到」和「做了但没找到」。
 */
export interface PageDriver {
  goto(url: string, waitUntil?: string): Promise<void>
  /** 当前 location.href；可选——一次性 driver 永远停在 entryUrl。 */
  currentUrl?(): Promise<string>
  scrollOnce(px: number): Promise<void>
  /**
   * 可信点击第一个命中元素。`position` 是相对元素矩形左上角的 CSS 像素偏移（对齐 Playwright
   * `locator.click({ position })` 的契约），不给就是中心。
   *
   * 返回值是「找没找到」——一次点在空气上的点击是调用方必须知道的事实，不是静默的空操作。
   */
  click(selector: string, position?: { x: number; y: number }): Promise<boolean>
  /**
   * 只截 `selector` 那块矩形（base64），元素不在就 null。
   *
   * 目的不是给人看，是把连续两帧当字节比——这才让「这块画完了没有」对 DOM 描述不了的内容也
   * 可答（闭合 shadow root 里的组件任何选择器都看不见，但它照样在画）。裁到元素自己那块是
   * 比较有意义的前提，否则页面别处的动静会让它永远停不下来。
   */
  shotOf?(selector: string): Promise<string | null>
  /**
   * 当前**视口**那一屏的截图（base64 JPEG），截不到就 null。
   *
   * 给人和模型看的整屏，不是 `shotOf` 那种拿来逐字节比对的元素裁图——两者的取舍正好相反：
   * `shotOf` 要的是"只有这块、别的动静别掺进来"，这一格要的是"此刻屏上是什么样"。
   *
   * 为什么不能拿 `shotOf('body')` 凑：滚过几十屏之后 `body` 的矩形有二十个视口那么高，
   * 按它裁的截图要么失败要么回 null，而失败得毫无声响——现场就那样悄悄少了一张图。
   *
   * 它也救不了**不显示在屏幕上的标签**：帧由 OS 那层"这个窗口显不显示"说了算，后台档的
   * 采集标签两条路都拿不到帧、都回 null（扩展侧 1.5s 到点判失败）。活体 2026-09-11 的
   * xhs-search 现场没截图就是这个原因，不是裁图的锅。
   */
  shotViewport?(): Promise<string | null>
  back(): Promise<void>
  /** 聚焦并替换其文本。返回「找没找到」——与 `click` 同一条契约：往空气里打字是事实，不是空操作。 */
  type(selector: string, text: string): Promise<boolean>
  /** 聚焦并按下回车。返回「找没找到」——同上。 */
  submit(selector: string): Promise<boolean>
  sleep(ms: number): Promise<void>
  /** 特征 / 登录态探针。 */
  exists(selector: string): Promise<boolean>
  /** 页内求值并返回其（JSON）值，返回 promise 会被 await；可选。 */
  evalJson?(expression: string): Promise<unknown>
  /**
   * 把**浏览器所在机器上的**本地文件放进 `<input type=file>`（CDP `DOM.setFileInputFiles`），
   * 页面收到的是和用户在文件对话框里选中一样的 `change`。路径按浏览器那台机器解释（扩展跑在
   * 用户的 Chrome 里 → Windows 上就是 `C:\...`）。找不到元素 / 元素不是文件输入框 / CDP 拒绝
   * 都**抛**，不回 false：这三种下一步各不相同，压成一个 false 就分不开了。可选（只有能说 CDP
   * 的 driver 有）。
   */
  setFiles?(selector: string, paths: string[]): Promise<{ name: string; type: string; size: number }[]>
  /** 为一条显式的轨迹步做可信指针移动；runner 永远不会自己随机加这一步。 */
  moveMouse(x: number, y: number): Promise<void>
  /**
   * 当前滚动几何——让滚动循环分得清「还没到已加载内容的底部」（继续滚去够加载触发点）、
   * 「到底了且没有新内容」（真的结束）和「页面在我们的滚动下没动」（卡住）。可选;
   * 读不出几何的 driver 退回按抓取数是否变平来停。
   */
  scrollProbe?(): Promise<ScrollGeometry>
}

/** `waitForSelector` 的默认上限。 */
export const EXPECT_DEFAULT_MS = 10_000
/** `waitForSelector` 的轮询间隔。 */
export const EXPECT_POLL_MS = 150

/**
 * 等一个选择器出现（或消失）。**唯一的等待原语**——recipe 的 `step.expect`、交互 lane 的
 * `action.expect`、插件的 act 确认门,走的都是它。
 *
 * 故意不吞异常：驱动过程中中继断了 / tab 没了，是要冒上去的故障,不是「没等到」。把它 catch 成
 * false，会让一次断连表现成一个内容层面的结论（"特征没出现"），而那两件事该分开报。
 */
export async function waitForSelector(
  driver: PageDriver,
  selector: string,
  opts: { state?: 'present' | 'gone'; timeout?: number; pollMs?: number } = {},
): Promise<boolean> {
  const want = opts.state !== 'gone'
  const deadline = Date.now() + (opts.timeout ?? EXPECT_DEFAULT_MS)
  for (;;) {
    if ((await driver.exists(selector)) === want) return true
    if (Date.now() >= deadline) return false
    await driver.sleep(opts.pollMs ?? EXPECT_POLL_MS)
  }
}
