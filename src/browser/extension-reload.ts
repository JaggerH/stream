// 重载扩展：驱动用户自己那个 Chrome，在扩展详情页上点「重新加载」，让它装载 `<dataDir>/extension/`
// 里刚物化的那份代码、并重新连上中继。
//
// 和代装 / 卸载同形——一条 `kind:'desktop'` recipe 跑在 `runDesktopRecipe` 上。**全程只走 Stream
// Desktop，不碰中继**：这一趟最要紧的用场恰恰是扩展断连（后端重启后中继没回来），那时任何走扩展的
// 路（chrome 档的 open / 扩展自己的 `chrome.runtime.reload()`）都够不着要救的那个东西。
//
// **成功判据是"中继重新连上"**（`since` 换了新值），不是"按钮点下去了"：点在工具栏刷新上、或扩展
// 重启后连不回来，按钮那一步照样"成功"。
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import type { DesktopRecipe } from '../replay/desktop-recipe.ts'
import { runDesktopRecipe } from '../replay/desktop-runner.ts'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'
import {
  BLANK_URL,
  EXTENSION_DETAIL_WINDOW_TITLES,
  EXTENSION_RELOAD_BUTTON,
  extensionDetailUrl,
  openExtensionsPageSteps,
} from './chrome-ext-page.ts'

export type ReloadOutcome =
  /** 中继以新的 `since` 连回来了（唯一判据）。 */
  | { status: 'reloaded'; since: string }
  /** 按钮点了，但中继在时限内没以新连接回来。**别报"重载成功"**。 */
  | { status: 'no-reconnect' }
  /** 某一步没走通，`reason` 指名是哪一步。 */
  | { status: 'blocked'; reason: string }

export interface ReloadDeps {
  driver: DesktopDriver
  /** 此刻中继的 `since`（没连着为 null）。点之前取一次，作为"换没换新连接"的基线。 */
  relaySince: () => string | null
  /** 等中继以不同于 `before` 的 `since` 连上，回新值；超时回 null。 */
  waitForReconnect: (before: string | null) => Promise<string | null>
}

const RELOAD_QUERY = {
  role: EXTENSION_RELOAD_BUTTON.role,
  className: EXTENSION_RELOAD_BUTTON.className,
  nameAnyOf: EXTENSION_RELOAD_BUTTON.names,
}

/** 重载这一趟的 recipe。走**详情页**而不是列表页：列表页上每张未打包扩展的卡片各有一枚「重新加载」，
 *  a11y 查询表达不了"属于哪张卡片"；详情页上只有我们这一枚。 */
export const RELOAD_EXTENSION_RECIPE: DesktopRecipe = {
  version: 1,
  kind: 'desktop',
  sourceId: 'chrome-reload-extension',
  app: { process: 'chrome.exe' },
  allowEmpty: true,
  steps: [
    ...openExtensionsPageSteps({
      url: extensionDetailUrl(STREAM_EXTENSION_ID),
      pageTitles: EXTENSION_DETAIL_WINDOW_TITLES,
      waitFor: RELOAD_QUERY,
      firstWindowLabel: '没等到 Chrome 的窗口（Chrome 可能没起来）',
      pageLabel: '没等到扩展详情页上的「重新加载」（扩展可能不是以未打包方式装的，或界面语言不在候选表里）',
    }),
    {
      // 页面里的 WebUI 按钮，吃 UIA invoke（原生 Views 弹层才不吃，见 `EXTENSIONS_TOOLBAR_BUTTON`）。
      kind: 'invoke',
      query: RELOAD_QUERY,
      label: '找不到扩展卡片上的「重新加载」',
    },
  ],
}

export async function reloadExtension(deps: ReloadDeps): Promise<ReloadOutcome> {
  const { driver } = deps
  const before = deps.relaySince()
  // 先开一个普通窗口：`chrome://` 不能从命令行进，只能走地址栏（见 `BLANK_URL`）。
  // `force`：Chrome 在跑时缺省的 ensure 什么都不做，而这一趟要的正是"开出一个窗口"。
  await driver.ensureApp({ args: [BLANK_URL], force: true })

  const run = await runDesktopRecipe(RELOAD_EXTENSION_RECIPE, {}, driver)
  if (run.outcome !== 'ok') {
    return { status: 'blocked', reason: run.driftReason ?? `这一趟没走通（${run.outcome}）` }
  }
  const since = await deps.waitForReconnect(before)
  return since ? { status: 'reloaded', since } : { status: 'no-reconnect' }
}
