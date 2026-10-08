// 卸载扩展：驱动用户自己那个 Chrome，把 Stream 扩展从他的浏览器里移除。
//
// 和代装（`extension-install.ts`）同形——一条 `kind:'desktop'` recipe 跑在 `runDesktopRecipe`
// 上，同一套失败判定、同一份现场、同一个会话租约（顶部指示条 + `Ctrl+Alt+Esc` 中止）。
//
// **成功判据是"中继断开"**，不是"页面上的卡片没了"。理由和装的时候对称：卡片和连接会安静地
// 分家。断开这件事后端自己看得见（`ExtRelay`），不用去问 Chrome。
//
// **这条流程里唯一一处"点错了就毁东西"的地方是那个「移除」**：用户装了好几个扩展时，列表页上
// 就有好几个一模一样的「移除」按钮，而 a11y 查询表达不了"属于哪张卡片"。两道闸挡它：
//
//   1. 先用页面自己的搜索框把列表筛到只剩我们这一张卡；
//   2. **确认框按它标题里的扩展名换窗**——搜索万一没生效，上一步就可能点在别人的卡片上，
//      而那一步照样"成功"；这一步会当场失败，而不是安静地删掉别人的扩展。
//
// 走列表页而不是扩展自己那一页，是因为**详情页上根本没有「移除」**（实测 2026-08-31：整页
// a11y 树里一个都没有）。
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import type { DesktopRecipe } from '../replay/desktop-recipe.ts'
import { runDesktopRecipe } from '../replay/desktop-runner.ts'
import {
  EXTENSION_DISPLAY_NAME,
  EXTENSION_SEARCH_BOX,
  openExtensionsPageSteps,
  REMOVE_BUTTON,
  CONFIRM_REMOVE_BUTTON,
  REMOVE_CONFIRM_WINDOW,
  BLANK_URL,
  EXTENSIONS_URL,
} from './chrome-ext-page.ts'

export type UninstallOutcome =
  /** 卸掉了：中继断开（唯一判据）。 */
  | { status: 'removed' }
  /** 步骤都跑完了，但中继还连着。**别报"卸载成功"**——多半是点到了别的东西。 */
  | { status: 'still-connected' }
  /** 某一步没走通，`reason` 指名是哪一步。 */
  | { status: 'blocked'; reason: string }

export interface UninstallDeps {
  driver: DesktopDriver
  /** 等中继断开，超时回 false。 */
  waitForDisconnected: () => Promise<boolean>
  /** 时钟，透传给 `runDesktopRecipe`（等窗口按墙钟超时）。省略 = `Date.now`；测试给一个跟着
   *  假 driver 的 `sleep` 走的时钟，否则"确认框始终不出现"那条要空转满超时。 */
  now?: () => number
}

/** 卸载这一趟的 recipe。没有参数——要删哪个扩展写死在名字里（`EXTENSION_DISPLAY_NAME`）。 */
export const UNINSTALL_EXTENSION_RECIPE: DesktopRecipe = {
  version: 1,
  kind: 'desktop',
  sourceId: 'chrome-uninstall-extension',
  app: { process: 'chrome.exe' },
  allowEmpty: true,
  steps: [
    ...openExtensionsPageSteps({
      url: EXTENSIONS_URL,
      // 等搜索框——它恒在，而且正是下一步要点的那个。
      waitFor: { role: EXTENSION_SEARCH_BOX.role, nameAnyOf: EXTENSION_SEARCH_BOX.names },
      firstWindowLabel: '没等到 Chrome 的窗口（Chrome 可能没起来）',
      pageLabel: '没等到扩展管理页窗口',
    }),
    {
      // 点搜索框（它的 role 是 Button，点开才变输入框——所以下一步只能走键盘）。
      kind: 'invoke',
      query: { role: EXTENSION_SEARCH_BOX.role, nameAnyOf: EXTENSION_SEARCH_BOX.names },
      label: '找不到扩展页上的搜索框（没有它就没法把列表筛到只剩我们这一张卡）',
    },
    {
      // 键盘打字：没有 `query`，投给焦点窗口——上一步的 `window` 已经抢了前台。
      kind: 'type',
      text: EXTENSION_DISPLAY_NAME,
      label: '搜索框里没能打进扩展名',
    },
    {
      kind: 'invoke',
      query: { role: REMOVE_BUTTON.role, nameAnyOf: REMOVE_BUTTON.names },
      label: '这一页上找不到「移除」按钮（可能是界面语言不在候选表里，或这个扩展本来就不在了）',
    },
    {
      // **这一步是安全闸，不是走过场**：确认框的标题里带着要删的那个扩展的名字，按它换窗
      // 等于要求"正在删的确实是我们"。点错了卡片 → 这里找不到窗口 → 当场失败（见
      // `REMOVE_CONFIRM_WINDOW`）。换窗之后范围就在对话框里，那两个同名「移除」也不再打架。
      kind: 'window',
      match: { process: 'chrome.exe', title: REMOVE_CONFIRM_WINDOW },
      // 下一步要坐标点，所以这里必须抢前台。
      focus: true,
      waitFor: {
        role: CONFIRM_REMOVE_BUTTON.role,
        className: CONFIRM_REMOVE_BUTTON.className,
        nameAnyOf: CONFIRM_REMOVE_BUTTON.names,
      },
      label: `没等到确认框，或者它问的不是「${EXTENSION_DISPLAY_NAME}」——这一步没删任何东西`,
    },
    {
      // **按回车，不点按钮。** 这一步试过三种，只有回车成的（实测 2026-08-31）：
      //   - UIA invoke：回执一切正常（`via:'invoke'`），框纹丝不动 —— Chrome 弹层里的 Views
      //     按钮不吃 invoke（工具栏拼图按钮同病，见 `EXTENSIONS_TOOLBAR_BUTTON`）；
      //   - 坐标点击（`fallbackClick`）：同样没反应；
      //   - 回车：框关掉、扩展消失。确认框的默认按钮就是「移除」。
      //
      // 回车还顺带甩掉三个包袱：不用算坐标、不怕被别的窗口遮住、不吃界面语言。
      // 上一步的 `waitFor` 已经证明这个框是**我们那个扩展**的删除确认，所以这一下不会误伤。
      kind: 'type',
      text: '\n',
      label: '确认框里那下回车没发出去（扩展没被删掉）',
    },
  ],
}

export async function uninstallExtension(deps: UninstallDeps): Promise<UninstallOutcome> {
  const { driver } = deps
  await driver.ensureApp({ args: [BLANK_URL], force: true })

  const run = await runDesktopRecipe(UNINSTALL_EXTENSION_RECIPE, {}, driver, deps.now ? { now: deps.now } : {})
  if (run.outcome !== 'ok') {
    return { status: 'blocked', reason: run.driftReason ?? `这一趟没走通（${run.outcome}）` }
  }
  return (await deps.waitForDisconnected()) ? { status: 'removed' } : { status: 'still-connected' }
}
