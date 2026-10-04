// 代装扩展：后端驱动用户自己那个 Chrome，走 `chrome://extensions` 的「加载未打包」把扩展装上。
//
// **它是一条 `kind:'desktop'` recipe**（`INSTALL_EXTENSION_RECIPE`），跑在和 telegram/qq 同一个
// `runDesktopRecipe` 上——同一套失败判定、同一份 `data/failures` 现场、同一个会话租约。这里剩下的
// 代码只做 recipe 表达不了、也不该由它表达的三件事：
//
//   1. **唤起 Chrome**（`ensureApp`）。recipe 的第一件事是 `scopeWindow(recipe.app)`，也就是说
//      进程必须先在——所以"让它活着"在本仓库里一直是调用方的活（`kernel/plugins/harvest.ts`
//      也这么做），不是 recipe 的步骤。
//   2. **等中继连上**——这是唯一的成功判据（见下），而它根本不在 a11y 那一层。
//   3. **把 recipe 的 `drift` 翻成给用户看的三态回执。**
//
// 曾经这一整趟是手写的驱动代码，理由是"recipe 词汇没有条件分支"。那个理由已经不成立：缺的三样
// （`skipIf` 守卫、`window` 换窗、`nameAnyOf` 多候选名）都是**桌面自动化的通用形状**，不是这条
// 流程的特例，现在补进了词汇本身（见 `desktop-recipe.ts`）。
//
// **成功判据只有一条：扩展连上了中继。** 页面上出现卡片不算——两者会安静地分家，最常见的是
// native messaging 清单在这次 Chrome 启动之后才登记（Chrome 只在启动时读它）。
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import type { DesktopRecipe } from '../replay/desktop-recipe.ts'
import { runDesktopRecipe } from '../replay/desktop-runner.ts'
import type { RepairRunner } from '../replay/repair-runner.ts'
import {
  DEV_MODE_TOGGLE,
  LOAD_UNPACKED_BUTTON,
  FOLDER_DIALOG_PATH_EDIT,
  FOLDER_DIALOG_CONFIRM,
  EXTENSIONS_WINDOW_TITLES,
  FOLDER_DIALOG_TITLES,
  CHROME_WINDOW_TITLES,
  EXTENSIONS_TOOLBAR_BUTTON,
  PIN_BUTTON,
  UNPIN_BUTTON,
  BLANK_URL,
  openExtensionsPageSteps,
  EXTENSIONS_URL,
  DEV_MODE_TOGGLE_MAC,
  LOAD_UNPACKED_BUTTON_MAC,
  OMNIBOX_MAC,
  FOLDER_PANEL_CONFIRM_MAC,
  FOLDER_PANEL_MESSAGE_MAC,
  GOTO_FOLDER_PATH_MAC,
  CHROME_PROCESS_MAC,
} from './chrome-ext-page.ts'
import { detectWsl, translateToWindowsPath } from '../../capabilities/desktop/src/wsl.ts'

export type InstallOutcome =
  | { status: 'connected' }
  /** 步骤都跑完了，但中继没连上。**不是失败**——多半只差重启一次 Chrome。 */
  | { status: 'needs-chrome-restart' }
  /** 某一步没走通。`reason` 必须指名是哪一步的哪个控件，否则用户和排查的人都只能猜。 */
  | { status: 'blocked'; reason: string }

export interface InstallDeps {
  driver: DesktopDriver
  /** 已经物化好的扩展目录绝对路径（`materializeExtension` 的产物）。 */
  extensionDir: string
  /** 等中继连上，超时回 false。 */
  waitForConnected: () => Promise<boolean>
  /**
   * agent 跑在哪个平台，决定用哪一条 recipe（见 {@link installRecipeFor}）。
   * 省略 = 本进程自己推（{@link agentPlatform}）；测试用它把平台钉死。
   */
  agentPlatform?: string
  /** 后端是否跑在 WSL 里（Chrome 在 Windows 侧）；省略 = 本进程自己探。测试用它钉死环境。 */
  isWsl?: boolean
  /** 时钟，透传给 `runDesktopRecipe`（等窗口按墙钟超时）。省略 = `Date.now`；测试给一个跟着
   *  假 driver 的 `sleep` 走的时钟，否则"对话框始终不出现"那条要真等满超时。 */
  now?: () => number
  /** WSL 下把 `extensionDir` 翻成 Windows 路径；省略 = 真调 `wslpath -w`。测试用它免掉子进程。 */
  translateToWindowsPath?: (linuxPath: string) => string | undefined
  /** 介入闸的收件人（同采集那条路）。不传 = 卡住时只打日志，不请 AI 来看。 */
  repairRunner?: RepairRunner
}

/** 文件夹对话框第一次弹出**实测要几秒**（Windows 在枚举 shell 目录），别按窗口的常态给上限。 */
const DIALOG_TIMEOUT_MS = 20_000

/**
 * 装扩展这一趟的 recipe。`{dir}` 是唯一的参数——扩展目录的绝对路径。
 *
 * **不是 `packages/` 里的一份 JSON**：recipe 包是"按站点编写、随包分发的数据"，而这条流程是
 * 产品的固定能力，没有对应的 Source，也不该随某个包的版本走。它仍然是 recipe——同一份词汇、
 * 同一个 runner、同一套失败现场，只是以代码常量的形态跟着后端发布。
 */
export const INSTALL_EXTENSION_RECIPE: DesktopRecipe = {
  version: 1,
  kind: 'desktop',
  sourceId: 'chrome-install-extension',
  app: { process: 'chrome.exe' },
  // 动作型：无物可读。别为了过闸而伪造一个 observer（见 `DesktopRecipe.observer`）。
  allowEmpty: true,
  steps: [
    ...openExtensionsPageSteps({
      url: EXTENSIONS_URL,
      // 等「开发者模式」而不是「加载未打包」：前者恒在，后者只在开发者模式打开时才有。
      waitFor: { role: DEV_MODE_TOGGLE.role, nameAnyOf: DEV_MODE_TOGGLE.names },
      firstWindowLabel: '没等到 Chrome 的窗口（Chrome 可能没装，或启动被拦住了）',
      pageLabel: `地址栏里填了 ${EXTENSIONS_URL} 并回车，但没等到扩展管理页窗口（可能是这台机器的界面语言不在候选表里）`,
    }),
    {
      // 开发者模式。**判据不是读开关状态**（`A11yElement` 里没有这个字段），而是「加载未打包」
      // 这个按钮在不在——它只在开发者模式打开时存在。已经开着还点一次就是把它关掉，所以这一步
      // 由 `skipIf` 守着。
      kind: 'invoke',
      query: { role: DEV_MODE_TOGGLE.role, nameAnyOf: DEV_MODE_TOGGLE.names },
      skipIf: { role: LOAD_UNPACKED_BUTTON.role, nameAnyOf: LOAD_UNPACKED_BUTTON.names },
      label: `找不到「${DEV_MODE_TOGGLE.names[0]}」开关（可能是 Chrome 界面改了，或这台机器的界面语言不在候选表里）`,
    },
    {
      kind: 'invoke',
      query: { role: LOAD_UNPACKED_BUTTON.role, nameAnyOf: LOAD_UNPACKED_BUTTON.names },
      label: `找不到「${LOAD_UNPACKED_BUTTON.names[0]}」按钮——没有它就没法继续（不去猜别的按钮）`,
    },
    {
      // 文件夹对话框是**另一个进程的另一个顶层窗口**（Chrome 主窗口的 owned window）。
      // 不换窗就永远在 Chrome 那棵树里找路径框，一直空手。
      kind: 'window',
      match: { titleAnyOf: FOLDER_DIALOG_TITLES },
      timeoutMs: DIALOG_TIMEOUT_MS,
      // 对话框同理：窗口在了不等于里面的控件建好了。
      waitFor: { role: FOLDER_DIALOG_PATH_EDIT.role, nameAnyOf: FOLDER_DIALOG_PATH_EDIT.names },
      label: `点了「${LOAD_UNPACKED_BUTTON.names[0]}」之后没等到文件夹选择对话框`,
    },
    {
      kind: 'type',
      query: { role: FOLDER_DIALOG_PATH_EDIT.role, nameAnyOf: FOLDER_DIALOG_PATH_EDIT.names },
      text: '{dir}',
      // 同上：路径盲打进对话框里碰巧有焦点的那个控件（文件列表的某个格子）什么也不会发生，
      // 但这一步会"成功"，然后确认按钮把一个错的目录装进去。
      requireTarget: true,
      label: '文件夹对话框开着，但它的路径输入框不在候选表里',
    },
    {
      kind: 'invoke',
      query: { role: FOLDER_DIALOG_CONFIRM.role, nameAnyOf: FOLDER_DIALOG_CONFIRM.names },
      label: '文件夹对话框的确认按钮不在候选表里（路径已经填好了，你可以自己点一下确认）',
    },
    // ── 把图标钉在工具栏上 ────────────────────────────────────────────────────────
    // 装完默认是收在拼图菜单里的，用户看不见它，也就不知道自己到底装成没有。
    //
    // **这三步整体是"锦上添花"**：装没装上的判据是中继连没连上，不是图标在不在。所以它们
    // 都可跳过——名字没匹配上（界面语言不在候选表里）时宁可少一个图标，也不要把一趟已经
    // 成功的安装报成失败。
    {
      // 焦点这会儿在刚关掉的文件夹对话框上，先回到浏览器窗口——下一步要真鼠标点。
      kind: 'window',
      match: { process: 'chrome.exe', titleAnyOf: EXTENSIONS_WINDOW_TITLES },
      focus: true,
      // 这里**故意不 waitFor**：工具栏是原生 chrome 的一部分，窗口在了它就在。
      // `optional` 和后面那三步一致——这一段整体是锦上添花，任何一步都不该把一趟已经成功的
      // 安装判死（漏标它正是活体上那次误报的第二半，见 `EXTENSIONS_WINDOW_TITLES` 的头注）。
      optional: true,
      label: '装完之后没能回到扩展管理页窗口（图标没能钉到工具栏上，扩展本身是装好的）',
    },
    {
      // 打开拼图菜单。`fallbackClick` 在这里是**必须**的：这个按钮 UIA invoke 点不动，
      // 只有坐标点击才弹得出气泡（见 `EXTENSIONS_TOOLBAR_BUTTON`）。
      kind: 'invoke',
      query: EXTENSIONS_TOOLBAR_BUTTON,
      fallbackClick: true,
      optional: true,
      label: '找不到工具栏上的扩展（拼图）按钮',
    },
    {
      // 点「固定」。已经固定过就跳过——**再点一次就是取消固定**，那比不做更糟。
      kind: 'invoke',
      query: { role: PIN_BUTTON.role, nameAnyOf: PIN_BUTTON.names },
      skipIf: { role: UNPIN_BUTTON.role, nameAnyOf: UNPIN_BUTTON.names },
      optional: true,
      label: '拼图菜单里没找到「固定」那一项',
    },
    {
      // 把气泡收回去。不收的话它会一直挂在用户屏幕上，像是流程没跑完。
      kind: 'invoke',
      query: EXTENSIONS_TOOLBAR_BUTTON,
      fallbackClick: true,
      optional: true,
      label: '没能把拼图菜单收回去',
    },
  ],
}

/**
 * macOS 那一趟。**不是上面那条加几个候选名，是另一条**——mac 的 a11y 是 AX，控件表
 * （`chrome-ext-page.ts` 的 macOS 半张）和对话框的形状都不一样。逐条实测于 2026-09-07
 * （Intel Mac / 14.6.1 / Chrome 152 / zh-CN），活体记录见
 * `docs/superpowers/reports/2026-09-07-mac-desktop-install-verify.md`。
 *
 * **和 Windows 那条差在三处，每一处都是实测逼出来的：**
 *
 * 1. **没有「换到对话框窗口」那一步。** mac 的文件选择面板是 Chrome 窗口里的一个 `AXSheet`，
 *    根本不在 `AXWindows` 里——换不过去。反过来说也不用换：它就在当前范围内，`find` 直接够得着。
 *    Windows 那一步之所以非有不可，是因为那边它是个独立顶层窗口。
 * 2. **路径不是"找个输入框填进去"，是先敲一个 `/`。** macOS 的面板上压根没有路径输入框；
 *    敲 `/` 会冒出「前往文件夹」那个小 sheet（`PathTextField`），那是唯一的门。
 * 3. **没有「固定到工具栏」那一段。** 不是做不到，是**没在真机上量过**那几个控件的名字与形状。
 *    照 Windows 的形状猜着写，最好的结果是三步全部落空（它们是 optional，不影响成败），
 *    最坏的结果是猜中了一个同名控件、点了不该点的东西。**没量过的就不写**——这一段是外观，
 *    而装没装上的判据是中继连没连上，少个图标不影响判据。要补就去真机上 dump 一次再加。
 */
export const INSTALL_EXTENSION_RECIPE_MAC: DesktopRecipe = {
  version: 1,
  kind: 'desktop',
  sourceId: 'chrome-install-extension-mac',
  app: { process: CHROME_PROCESS_MAC },
  allowEmpty: true,
  steps: [
    {
      kind: 'window',
      match: { process: CHROME_PROCESS_MAC, titleAnyOf: CHROME_WINDOW_TITLES },
      focus: true,
      label: '没等到 Chrome 的窗口（Chrome 可能没装，或启动被拦住了）',
    },
    {
      // 地址栏。mac 后端的 setValue 会**连焦点一起设**，所以下一步的回车落在这儿。
      kind: 'type',
      query: { role: OMNIBOX_MAC.role, nameAnyOf: OMNIBOX_MAC.names },
      text: EXTENSIONS_URL,
      requireTarget: true,
      label: '找不到 Chrome 的地址栏',
    },
    { kind: 'type', text: '\n', label: '地址栏回车没发出去' },
    {
      kind: 'window',
      match: { process: CHROME_PROCESS_MAC, titleAnyOf: EXTENSIONS_WINDOW_TITLES },
      focus: true,
      // 同 Windows：标题先变、页面后建。等一个这个界面上恒在的控件，不是等「加载未打包」。
      waitFor: { role: DEV_MODE_TOGGLE_MAC.role, nameAnyOf: DEV_MODE_TOGGLE_MAC.names },
      label: `地址栏里填了 ${EXTENSIONS_URL} 并回车，但没等到扩展管理页窗口（可能是这台机器的界面语言不在候选表里）`,
    },
    {
      // 判据和 Windows 一模一样：不读开关状态，问「加载未打包」在不在。
      // mac 上这个 AXCheckBox 的 value 其实**读得出来**（Windows 那边读不出来），但两边
      // 故意用同一条判据——多一处平台差异就多一处会漂的地方，而这条判据两边都成立。
      kind: 'invoke',
      query: { role: DEV_MODE_TOGGLE_MAC.role, nameAnyOf: DEV_MODE_TOGGLE_MAC.names },
      skipIf: { role: LOAD_UNPACKED_BUTTON_MAC.role, nameAnyOf: LOAD_UNPACKED_BUTTON_MAC.names },
      // **点完要等那一排按钮真的进树。** WebUI 的重渲染比 invoke 的回执慢一拍，紧接着的
      // `find` 会空手——而报出来的是「找不到『加载未打包』，不去猜别的按钮」，读起来像
      // 界面变了或语言不对，其实只是快了几百毫秒。活体撞到过（2026-09-07）：这一步之后
      // 立刻查，0 命中；同一时刻人去 dump，按钮明明在。
      //
      // 写成 `expect` 而不是给下一步加 `require`，是因为它**同时**是这一步的成功判据：
      // 开关拨过去了，那排按钮就该出现。没出现 = 这一次点击没起到作用（比如把它关掉了），
      // 那正是要当场喊出来的事，而不是拖到下一步以「找不到按钮」的面孔冒出来。
      expect: { query: { role: LOAD_UNPACKED_BUTTON_MAC.role, nameAnyOf: LOAD_UNPACKED_BUTTON_MAC.names } },
      label: `找不到「${DEV_MODE_TOGGLE_MAC.names[0]}」开关（可能是 Chrome 界面改了，或这台机器的界面语言不在候选表里）`,
    },
    {
      kind: 'invoke',
      query: { role: LOAD_UNPACKED_BUTTON_MAC.role, nameAnyOf: LOAD_UNPACKED_BUTTON_MAC.names },
      label: `找不到「${LOAD_UNPACKED_BUTTON_MAC.names[0]}」按钮——没有它就没法继续（不去猜别的按钮）`,
    },
    {
      // 敲 `/` 打开「前往文件夹」。**先等面板真的建好再敲**——面板第一次弹出要几秒，
      // 早敲的话这个 `/` 会打进它后面的网页里，而这一步照样"成功"。
      // 这里用 `require` 而不是上一步的 `expect`：面板不是窗口，没有「换过去顺带等」那一步
      // 可用，`require` 是唯一能把这个等待挂上去的地方。
      kind: 'type',
      text: '/',
      require: { query: FOLDER_PANEL_MESSAGE_MAC, timeoutMs: DIALOG_TIMEOUT_MS },
      label: `点了「${LOAD_UNPACKED_BUTTON_MAC.names[0]}」之后没等到文件夹选择面板`,
    },
    {
      kind: 'type',
      query: GOTO_FOLDER_PATH_MAC,
      text: '{dir}',
      // 「前往文件夹」那个小 sheet 也要一点时间建起来。
      require: { query: GOTO_FOLDER_PATH_MAC },
      // 同 Windows：盲打会把路径打进碰巧有焦点的东西里，而这一步"成功"，
      // 然后确认按钮把一个错的目录装进去。
      requireTarget: true,
      label: '「前往文件夹」的路径输入框没出来（敲了 / 但那个小窗没弹）',
    },
    { kind: 'type', text: '\n', label: '「前往文件夹」的回车没发出去' },
    {
      // 按 AXIdentifier=OKButton 认，不吃界面语言。
      kind: 'invoke',
      query: FOLDER_PANEL_CONFIRM_MAC,
      label: '文件夹面板的「选择」按钮不在（路径已经填好了，你可以自己点一下确认）',
    },
  ],
}

/**
 * 这台机器该跑哪一条。
 *
 * **判据是 agent 跑在哪个平台，不是后端跑在哪个平台**——WSL 下后端在 Linux 里，而 agent 是
 * **Windows 版**、控制的是 Windows 桌面（同 `binary.ts` 的 `usesWindowsAgent`）。照
 * `process.platform` 挑会在 WSL 上选出一条给 Linux 的 recipe，而 Linux 压根没有后端。
 *
 * **只有 `darwin` 有自己的一张表；其余一律走 UIA 那条**，因为今天就只有这两份后端
 * （`app/host-agent/src/{windows,macos}.rs`）。以后加了 Linux/AT-SPI 再在这里加一档——
 * 那时这个函数就是回补清单本身。
 */
export function installRecipeFor(platform: string): DesktopRecipe {
  return platform === 'darwin' ? INSTALL_EXTENSION_RECIPE_MAC : INSTALL_EXTENSION_RECIPE
}

/** agent 实际跑在哪个平台。WSL → `win32`（那边的 agent 是 Windows 版）。 */
export function agentPlatform(platform: string = process.platform, wsl: boolean = detectWsl()): string {
  return wsl ? 'win32' : platform
}

export async function installExtension(deps: InstallDeps): Promise<InstallOutcome> {
  const { driver, extensionDir } = deps
  const recipe = installRecipeFor(deps.agentPlatform ?? agentPlatform())
  // 唤起 Chrome。**只能给普通地址**——`chrome://` 从命令行进会被静默丢掉（见文件头）。
  // 这一步在 recipe 之外，因此**不在**它的会话租约里；`runDesktopRecipe` 自己会开租约，
  // 接管指示条和 `Ctrl+Alt+Esc` 中止随之生效。
  await driver.ensureApp({ args: [BLANK_URL], force: true })

  // 路径要给到 Chrome 所在的那一侧。后端跑在 WSL 里时 `extensionDir` 是 /home/... 形状，Windows
  // 的文件夹对话框认不出它——要翻成 \\wsl.localhost\<distro>\... 那种；翻不出来就停在这里报清，
  // 别把一条注定填不进去的路径交给对话框（那样的失败长得像"控件没找到"，会把排查引去错的地方）。
  const wsl = deps.isWsl ?? detectWsl()
  const dir = wsl ? (deps.translateToWindowsPath ?? translateToWindowsPath)(extensionDir) : extensionDir
  if (!dir) return { status: 'blocked', reason: `WSL 路径翻不成 Windows 路径（wslpath -w ${extensionDir} 失败），文件夹对话框填不了` }

  const run = await runDesktopRecipe(recipe, { dir }, driver, {
    ...(deps.repairRunner ? { repairRunner: deps.repairRunner } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  })
  if (run.outcome !== 'ok') {
    return { status: 'blocked', reason: run.driftReason ?? `这一趟没走通（${run.outcome}）` }
  }
  // 唯一的成功判据：连上了没有。
  return (await deps.waitForConnected()) ? { status: 'connected' } : { status: 'needs-chrome-restart' }
}
