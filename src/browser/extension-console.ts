// 读扩展后台（service worker）的控制台：驱动用户自己那个 Chrome 打开扩展详情页 → 点「Service Worker」
// → 在弹出的 DevTools 里按 a11y 读出每一条控制台消息。
//
// **为什么要有它**：扩展连不上后端时，它自己往 debug bus 写日志的那条路（`POST /api/ext/debug-log`）
// 也一并断了——而这时恰恰最需要看它在说什么。控制台是唯一还在的现场；以前只能请用户去点开、再把
// 报错贴回来。这里全程走 Stream Desktop、不经中继，和代装 / 卸载 / 重载同形。
//
// 读法是 a11y 不是截图：每条消息是一个 `role=Group` 的节点，name 就是全文（`CONSOLE_MESSAGE_CLASS`）。
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import type { DesktopRecipe } from '../replay/desktop-recipe.ts'
import { runDesktopRecipe } from '../replay/desktop-runner.ts'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'
import {
  BLANK_URL,
  CONSOLE_MESSAGE_CLASS,
  DEVTOOLS_CONSOLE_TAB,
  EXTENSION_DETAIL_WINDOW_TITLES,
  SERVICE_WORKER_LINK,
  SW_DEVTOOLS_WINDOW_TITLE,
  extensionDetailUrl,
  openExtensionsPageSteps,
} from './chrome-ext-page.ts'

export interface ConsoleMessage {
  /** `error` / `warning` / `info` / `verbose`…——取自 className 的 `console-<级别>-level`；读不出为 `unknown`。 */
  level: string
  text: string
}

export type ConsoleOutcome =
  /** 读到了（可能是空数组：控制台确实没有消息）。 */
  | { status: 'ok'; messages: ConsoleMessage[] }
  /** 某一步没走通，`reason` 指名是哪一步。 */
  | { status: 'blocked'; reason: string }

export const READ_EXTENSION_CONSOLE_RECIPE: DesktopRecipe = {
  version: 1,
  kind: 'desktop',
  sourceId: 'chrome-read-extension-console',
  app: { process: 'chrome.exe' },
  allowEmpty: true,
  steps: [
    ...openExtensionsPageSteps({
      url: extensionDetailUrl(STREAM_EXTENSION_ID),
      pageTitles: EXTENSION_DETAIL_WINDOW_TITLES,
      waitFor: SERVICE_WORKER_LINK,
      firstWindowLabel: '没等到 Chrome 的窗口（Chrome 可能没起来）',
      pageLabel: '没等到扩展详情页上的「Service Worker」链接（后台可能没在跑——扩展被停用，或启动时就崩了）',
    }),
    {
      kind: 'invoke',
      query: SERVICE_WORKER_LINK,
      label: '找不到「Service Worker」链接',
    },
    {
      kind: 'window',
      match: { process: 'chrome.exe', titleAnyOf: [SW_DEVTOOLS_WINDOW_TITLE] },
      waitFor: DEVTOOLS_CONSOLE_TAB,
      label: '点了「Service Worker」但没等到它的 DevTools 窗口',
    },
  ],
}

/** className `console-message-wrapper console-error-level` → `error`。 */
export function levelOf(className: string): string {
  return className.match(/console-(\w+)-level/)?.[1] ?? 'unknown'
}

export async function readExtensionConsole(driver: DesktopDriver): Promise<ConsoleOutcome> {
  // 先开一个普通窗口：`chrome://` 不能从命令行进，只能走地址栏（见 `BLANK_URL`）。
  await driver.ensureApp({ args: [BLANK_URL], force: true })
  const run = await runDesktopRecipe(READ_EXTENSION_CONSOLE_RECIPE, {}, driver)
  if (run.outcome !== 'ok') {
    return { status: 'blocked', reason: run.driftReason ?? `这一趟没走通（${run.outcome}）` }
  }
  const read = async () => {
    await driver.scopeWindow({ process: 'chrome.exe', title: SW_DEVTOOLS_WINDOW_TITLE })
    const { elements } = await driver.find({ role: 'Group' })
    return elements
      .filter((e) => e.className.split(/\s+/).includes(CONSOLE_MESSAGE_CLASS))
      .map((e) => ({ level: levelOf(e.className), text: e.name.trim() }))
  }
  // 与 recipe 同一把会话租约（有就用）：读的这两下也是在动用户的桌面会话。
  const messages = driver.withSession ? await driver.withSession(read) : await read()
  return { status: 'ok', messages }
}
