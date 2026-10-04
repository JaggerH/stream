// `chrome://extensions` 上那几个控件的**实测**名字与角色。
//
// 为什么要一张显式候选表：Chrome 的界面语言跟着用户走，中文机器上是「开发者模式」，英文机器上
// 是 `Developer mode`。凭印象写一个名字，匹配不上时的症状是「找不到元素」——和「这个 Chrome
// 版本改了界面」长得一模一样，排查的人无从下手。
//
// **表里的名字全部是量出来的，不是翻译出来的。** 中文实测 2026-08-30（Chrome zh-CN / Windows）；
// 英文实测 2026-09-02，量法见本文件末尾「怎么量另一门语言」。
//
// 那一轮把**两条**候选纠了回来：`PIN_BUTTON` / `UNPIN_BUTTON` 英文侧真名是 `Pin <名字>` /
// `Unpin <名字>`，**没有引号**——此前照中文形状填的 `Pin "<名字>"` 一次都不会命中。中英文差的
// 不只是词，还有标点结构（中文把扩展名包在弯引号 `“”` 里，英文裸着放）。所以"照着另一门语言的
// 形状推"这件事本身就是错的，得逐条量。
// 最直接的收获是那个按钮真名叫「加载**未打包**的扩展程序」——不是官方文档和一堆教程里写的
// 「加载已解压的扩展程序」。差一个词，`find` 就是 0 命中。加一门语言时照做：去真的界面上读一次。
//
// 三条同样是量出来的、会影响流程写法的事实：
//
// 1. **开发者模式那个开关的 role 是 `Button`，不是 `CheckBox`**（Chrome 的 cr-toggle 这么暴露），
//    而且它的 name 恒为「开发者模式」，**不带开关状态**。对比同一页上扩展卡片自己的开关，name
//    是「开启，扩展程序已启用」——那个带状态，这个不带。所以"这个开关现在是开是关"读不出来，
//    判据只能换成 §2 那条。
// 2. **「加载未打包的扩展程序」只在开发者模式打开时存在**（和「打包扩展程序」「更新」一起出现）。
//    所以它在不在，就是"开发者模式开没开"的行为判据——比读开关状态更直接，也不用给 agent 加能力。
// 3. **点它不需要窗口在前台**：走 UIA invoke（收件人是元素句柄）照样能弹出文件夹对话框，只是
//    第一次弹出很慢（实测几秒，Windows 在枚举 shell 目录）。别因为"点完立刻没看到对话框"就判失败。
import type { DesktopQuery, DesktopStep } from '../replay/desktop-recipe.ts'

export interface ControlSpec {
  /** a11y role（实测值） */
  role: string
  /** 名字候选，逐个试，第一个命中就用 */
  names: string[]
}

/** 实测 2026-08-30 / Chrome zh-CN：`role=Button`、`className=""`、name 不带状态。 */
export const DEV_MODE_TOGGLE: ControlSpec = {
  role: 'Button',
  names: ['开发者模式', 'Developer mode'],
}

/** 实测 2026-08-30 / Chrome zh-CN。**真名是「加载未打包的」**，不是「加载已解压的」。 */
export const LOAD_UNPACKED_BUTTON: ControlSpec = {
  role: 'Button',
  names: ['加载未打包的扩展程序', 'Load unpacked'],
}

/**
 * 扩展页那个窗口的标题。**必须带上「 - Google Chrome」这截尾巴，不许只写「扩展程序」。**
 *
 * 窗口标题一律是**包含**匹配（`AppMatch.title`），而文件夹对话框的标题
 * 「选择扩展程序目录。」里正好含着「扩展程序」——只写四个字的话，装完之后那一步"回到扩展页"
 * 会匹配上**正在关闭的那个对话框**，然后 scope 到一个已经不存在的窗口上失败。活体实测
 * （2026-08-31，win-test）：装扩展整条流程 0–8 步全对、扩展也真装上了，却报"没能回到扩展
 * 管理页窗口"——真因就是这两个标题互相包含，而错怪了对话框那一步。
 */
export const EXTENSIONS_WINDOW_TITLES: string[] = ['扩展程序 - Google Chrome', 'Extensions - Google Chrome']

/**
 * **Chrome 会静默丢掉命令行上的 `chrome://` 地址**——所以扩展页开不出来，得先开一个普通窗口
 * 再走地址栏。实测 2026-08-31（win-test，Chrome zh-CN / Windows 11，冷启，各等 15s）：
 *
 * - `chrome.exe chrome://extensions/` → 六个 chrome 进程全在、**一个可见窗口都没有**；
 * - `chrome.exe https://example.com` → 立刻有窗口（`Example Domain - Google Chrome`）。
 *
 * 这个坑贵在**它失败的样子指向错误的方向**：流程停在"等扩展页窗口超时"，报出来的话是
 * 「Chrome 可能没起来，或界面语言不在候选表里」——两条都不是真因，而 Chrome 明明在跑。
 */
export const BLANK_URL = 'about:blank'
export const EXTENSIONS_URL = 'chrome://extensions'

/** 任意一个 Chrome 浏览器窗口的标题。**品牌名不随界面语言翻译**（zh-CN 下也是
 *  「about:blank - Google Chrome」），所以这一条候选就够，不用按语言铺表。 */
export const CHROME_WINDOW_TITLES: string[] = ['Google Chrome']

/**
 * 地址栏。实测 2026-08-31 / Chrome zh-CN：`role=Edit`、`className=OmniboxViewViews`、
 * name「地址和搜索栏」。**列表页上它是整个窗口里唯一的 `Edit`**（扩展页那个搜索框的 role 是
 * `Button`，见 `EXTENSION_SEARCH_BOX`）。
 *
 * 落空时**直接停手**（recipe 里那一步带 `requireTarget`），不猜、也不退回键盘盲打：地址会被
 * 打进当时碰巧有焦点的东西，而那一步照样"成功"，失败要到很多步之后才以另一副面孔冒出来。
 * 先开 `about:blank` 而不是新标签页也是同一个考虑——新标签页里那个「在 Google 中搜索」同样是
 * `role=Edit`，界面上少一个形似的东西，认错的机会就少一分。
 */
export const OMNIBOX: ControlSpec = {
  role: 'Edit',
  names: ['地址和搜索栏', 'Address and search bar'],
}

/**
 * 文件夹选择对话框的窗口标题。实测「选择扩展程序目录。」——**末尾那个全角句号是它自带的**，
 * 全等匹配会因为它落空，所以一律用包含匹配。
 *
 * **它是一个独立的顶层窗口，不是 Chrome 窗口的后代**（Chrome 主窗口的 owned window，
 * `class=#32770`；**进程实测还是 `chrome.exe` 自己**——别指望按进程名把它和浏览器窗口分开，
 * 那条假前提会让「装完回到扩展页」那一步反而匹配上它）。所以点完「加载未打包」之后**必须先 `scopeWindow`
 * 到这个标题**，否则 find 还搜在 Chrome 那个窗口下，两个控件一个都找不到。
 *
 * 它还是这条链路上那次 host-agent 修复的起因：agent 的 `windows()` 原来走 UIA control-view
 * walker，把这个对话框整个漏掉（EnumWindows 看得见）。现在枚举走 EnumWindows，见
 * `app/host-agent/src/windows.rs`。
 */
export const FOLDER_DIALOG_TITLES: string[] = ['选择扩展程序目录', 'Select the extension directory']

/**
 * 对话框底部那个「文件夹:」路径输入框。实测 2026-08-30 / Chrome zh-CN：
 * `role=Edit`、`name=文件夹:`（**冒号是半角、且属于 name 的一部分**）、`className=Edit`。
 *
 * **name 不能省**：同一个对话框里还有十几个 `role=Edit` 的控件（文件列表每一列的
 * 「名称」单元格都是 Edit），只按 role 找会命中一堆文件名格子。
 */
export const FOLDER_DIALOG_PATH_EDIT: ControlSpec = {
  role: 'Edit',
  names: ['文件夹:', 'Folder:'],
}

/** 对话框右下角的确认按钮。实测 2026-08-30 / Chrome zh-CN：`role=Button`、name「选择文件夹」、
 *  `className=Button`（旁边的「取消」同形，所以名字是唯一的区分维度）。 */
export const FOLDER_DIALOG_CONFIRM: ControlSpec = {
  role: 'Button',
  names: ['选择文件夹', 'Select Folder'],
}

/**
 * 扩展在 Chrome 界面上显示的名字。**必须和 `extension/wxt.config.ts` 里那个 manifest name
 * 一模一样**——下面几个控件的名字是 Chrome 用它拼出来的（「固定“Stream Companion”」），
 * 改了名字这边不跟，症状是找不到控件而不是报错。
 */
export const EXTENSION_DISPLAY_NAME = 'Stream Companion'

/**
 * 工具栏上那个拼图按钮（点开它才有「固定」）。**按 className 认，不按名字认**——
 * `ExtensionsToolbarButton` 是编译进 Chrome 的类名，不随界面语言变，比中英文名字表稳。
 *
 * **它必须用真鼠标点，UIA invoke 点不动**（实测 2026-08-31：invoke 回执 `via:'invoke'`
 * 一切正常，气泡就是不出来；同一个坐标真点一下立刻弹出）。recipe 里那一步因此带
 * `fallbackClick: true`——那个字段的真实语义是"这一步走坐标点击"，不是"invoke 不成再说"。
 *
 * **这不是这一个按钮的脾气，是 Chrome 弹层的通病**：气泡和确认框里的 Views 按钮都不吃
 * invoke（卸载那个确认框同样栽过，见 `extension-uninstall.ts`）。而页面里的按钮
 * （「加载未打包」「移除」这些 WebUI 元素）吃。**分界线是"原生 Views 控件 vs 网页元素"**，
 * 拿不准就先用 invoke 试，失败的样子是"回执成功、界面没动"——所以要有一个界面之外的判据兜着。
 */
export const EXTENSIONS_TOOLBAR_BUTTON = { role: 'Button', className: 'ExtensionsToolbarButton' }

/**
 * 拼图菜单里那一行的「固定」。实测 2026-08-31 / Chrome zh-CN：`role=Button`、
 * `className=HoverButton`、name 是 `固定“Stream Companion”`——**引号是中文弯引号**，
 * 而且名字里带着扩展名。
 *
 * **气泡是独立窗口，但不用切进去**：它的 parent 是浏览器窗口，控件在浏览器窗口的 a11y 树里
 * 就读得到（实测）。切过去反而麻烦——气泡标题恰好是「扩展程序」，和浏览器窗口标题
 * 「扩展程序 - Google Chrome」都能被包含匹配命中，`scopeWindow` 会判 ambiguous。
 *
 * **英文那条实测 2026-09-02：`Pin $1`——没有引号。** 此前照中文形状写成了 `Pin "..."`（直引号），
 * 那个候选在英文机器上一次都不会命中。中英文差的不只是词，还有标点结构：中文把扩展名包在
 * 弯引号里，英文裸着放。量法见本文件末尾「怎么量另一门语言」。
 *
 * 落空时这一步跳过（`optional`），不拖垮整趟安装——固定与否是外观，装没装上才是判据。
 *
 * **为什么不走扩展详情页上那个「固定到工具栏」**（那条路更短、不用开气泡）：它的名字**不随
 * 状态变**。实测 2026-08-31：扩展当时是固定着的（工具栏里有 `ToolbarActionView`），点一下
 * 图标消失（取消固定了），而按钮名字还是「固定到工具栏」。读不出状态就没法幂等——和开发者
 * 模式那个开关一模一样的坑。气泡这条虽然要多点一下，但名字会翻转，`skipIf` 才有东西可指。
 */
export const PIN_BUTTON: ControlSpec = {
  role: 'Button',
  names: [`固定“${EXTENSION_DISPLAY_NAME}”`, `Pin ${EXTENSION_DISPLAY_NAME}`],
}

/** 已经固定时，同一个位置的按钮变成「取消固定…」。**它就是"固定过了没有"的判据**——
 *  名字会翻转（实测 2026-08-31：点完 `固定“…”` 立刻变成 `取消固定“…”`），所以不必去读
 *  什么状态位。再点一次就是把它取消固定，因此那一步由 `skipIf` 指向这里。 */
export const UNPIN_BUTTON: ControlSpec = {
  role: 'Button',
  names: [`取消固定“${EXTENSION_DISPLAY_NAME}”`, `Unpin ${EXTENSION_DISPLAY_NAME}`],
}

/**
 * 列表页上那个搜索框。实测 2026-08-31：它的 `role` 是 **`Button`** 而不是 `Edit`（点开才变成
 * 输入框），所以只能"先点它、再用键盘打字"，`setValue` 那条路走不通。
 *
 * 卸载要用它把列表筛到只剩我们这一张卡：**用户装了好几个扩展时，页面上就有好几个一模一样的
 * 「移除」按钮**，而 a11y 查询表达不了"属于哪张卡片"。
 */
export const EXTENSION_SEARCH_BOX: ControlSpec = {
  role: 'Button',
  names: ['搜索扩展程序', 'Search extensions'],
}

/** 卡片上的「移除」。实测 2026-08-31 / Chrome zh-CN。 */
export const REMOVE_BUTTON: ControlSpec = { role: 'Button', names: ['移除', 'Remove'] }

/**
 * 确认框的窗口标题里**带着扩展自己的名字**（实测：「要删除“Stream Companion”吗？」）。
 *
 * 这是卸载这条路上唯一一处**兜得住"点错卡片"**的判据，也是它非要有不可的理由：搜索万一没
 * 生效（点了搜索框但焦点没进去），上一步的「移除」就可能点在别人的卡片上——而那一步照样
 * "成功"。按这个标题换窗之后，点错的结果是**当场失败**，不是安静地删掉别人的扩展。
 *
 * 匹配用的是我们自己的扩展名，不是那句中文问句，所以它不吃界面语言。
 */
export const REMOVE_CONFIRM_WINDOW = EXTENSION_DISPLAY_NAME

/**
 * 详情页**没有**「移除」（实测 2026-08-31：整页 a11y 树里一个都没有），所以卸载走列表页 +
 * 搜索，不走这一页。重载走这一页（`extension-reload.ts`）：它上面的「重新加载」只有一枚。
 */
export const extensionDetailUrl = (extId: string) => `chrome://extensions/?id=${extId}`

/**
 * 详情页上扩展卡片那枚「重新加载」（只对未打包安装的扩展出现）。实测 Chrome zh-CN / Windows：
 * `role=Button`、name「重新加载」、`className=icon-refresh no-overlap`。
 *
 * **`className` 不能省**：同一个窗口里还有一枚同名的——浏览器工具栏的刷新（`ReloadButton`），
 * 点它只是刷新扩展页本身，扩展纹丝不动，而这一步照样"成功"。英文名 `Reload` 未经实测。
 */
/**
 * 扩展**详情页**的窗口标题：中间夹着扩展名。实测 Chrome zh-CN / Windows：
 * 「扩展程序 - Stream Companion - Google Chrome」——**和列表页的 `EXTENSIONS_WINDOW_TITLES` 不互相包含**，
 * 拿列表页那份去等详情页，导航明明成功了却报「没等到窗口」。英文那条按同一形状推，未经实测。
 */
export const EXTENSION_DETAIL_WINDOW_TITLES: string[] = [
  `扩展程序 - ${EXTENSION_DISPLAY_NAME} - Google Chrome`,
  `Extensions - ${EXTENSION_DISPLAY_NAME} - Google Chrome`,
]

/**
 * 详情页「检查视图」下那条「Service Worker」链接：点开就是扩展后台的 DevTools。实测 Chrome zh-CN /
 * Windows：`role=Hyperlink`、name「Service Worker」（不翻译），WebUI 元素，吃 UIA invoke。
 */
export const SERVICE_WORKER_LINK = { role: 'Hyperlink', name: 'Service Worker' }

/**
 * 扩展后台那个 DevTools 窗口的标题：**就是「DevTools」这一个词**（普通页面的 DevTools 标题是
 * 「DevTools - <地址>」）。窗口标题是包含匹配，另开着别的 DevTools 时会撞名——那时按
 * `ambiguous-window` 如实失败，不猜。
 */
export const SW_DEVTOOLS_WINDOW_TITLE = 'DevTools'

/** DevTools 顶栏的「Console」标签（`role=TabItem`，不随界面语言翻译）。等它出现 = 窗口建好了。 */
export const DEVTOOLS_CONSOLE_TAB = { role: 'TabItem', name: 'Console' }

/**
 * 控制台里每一条消息的 a11y 节点：`role=Group`、`className` 形如
 * `console-message-wrapper console-error-level`（级别在第二段）、**name 就是整条消息的文字**。
 * 实测 Chrome 153 / Windows：读 a11y 就拿得到全文，不需要截图、也不需要经剪贴板复制。
 */
export const CONSOLE_MESSAGE_CLASS = 'console-message-wrapper'

export const EXTENSION_RELOAD_BUTTON = { role: 'Button', className: 'icon-refresh no-overlap', names: ['重新加载', 'Reload'] }

/**
 * 「从一个普通 Chrome 窗口走到扩展管理页」这四步——代装、卸载、重载三条 recipe 共用。
 *
 * 前提：调用方先 `ensureApp({ args: [BLANK_URL], force: true })` 开出一个普通窗口——
 * **`chrome://` 不能从命令行进**（见 `BLANK_URL` 上面那段实测），只能走地址栏。
 * `waitFor` 是扩展页上"下一步要碰的那个控件"：标题先变、页面后建，不等真控件出现就往下走，
 * 下一步查什么都是空。
 */
export function openExtensionsPageSteps(opts: {
  url: string
  /** 到了之后那个窗口的标题候选；缺省是列表页（`EXTENSIONS_WINDOW_TITLES`）。 */
  pageTitles?: string[]
  waitFor: DesktopQuery
  firstWindowLabel: string
  pageLabel: string
}): DesktopStep[] {
  return [
    {
      // 把 `ensureApp` 开出来的那个普通窗口认出来并抬到前台：下一步要回车，而键盘投给焦点窗口。
      kind: 'window',
      match: { process: 'chrome.exe', titleAnyOf: CHROME_WINDOW_TITLES },
      focus: true,
      label: opts.firstWindowLabel,
    },
    {
      // 地址栏。`setValue` 写值不提交，所以下一步单独发回车。
      kind: 'type',
      query: { role: OMNIBOX.role, nameAnyOf: OMNIBOX.names },
      text: opts.url,
      // 找不到地址栏就停手。默认那条"退回键盘"的路在这里是有害的：地址会打进当时碰巧有焦点的
      // 东西（页面里的某个输入框），而这一步照样"成功"，失败要到下一步等窗口超时才冒出来。
      requireTarget: true,
      label: '找不到 Chrome 的地址栏',
    },
    { kind: 'type', text: '\n', label: '地址栏回车没发出去' },
    {
      kind: 'window',
      match: { process: 'chrome.exe', titleAnyOf: opts.pageTitles ?? EXTENSIONS_WINDOW_TITLES },
      focus: true,
      waitFor: opts.waitFor,
      label: opts.pageLabel,
    },
  ]
}

/**
 * 点了「移除」之后那个确认框的「移除」。实测 2026-08-31：确认框是一个独立窗口
 * （标题「要删除“Stream Companion”吗？」），但和固定气泡一样，控件在浏览器窗口的树里读得到。
 *
 * **`className` 不能省**：确认框弹出后，同一棵树里有**两个**叫「移除」的按钮——卡片上那个
 * （className 为空）和确认框里这个（`MdTextButton`）。少了它就会点回卡片，确认框留在原地。
 */
export const CONFIRM_REMOVE_BUTTON = { role: 'Button', className: 'MdTextButton', names: ['移除', 'Remove'] }

/**
 * ## 怎么量另一门语言
 *
 * **别起一个那种语言的浏览器去读界面。** 试过，代价高且不必要：界面语言是**每个浏览器进程一种**，
 * 用户那个 Chrome 是什么语言就是什么语言，要读别的语言只能另起一个实例（多一个进程、多一份
 * profile、还得记得收干净），或者去改用户自己的语言设置并重启他的浏览器。
 *
 * **正确的量法是查 Chrome 自己发的资源包**，它比读界面更准也更省：
 *
 * - Chrome 把各语言的界面字符串装在 `<安装目录>/<版本>/Locales/<lang>.pak` 里，
 *   **同一条文案在各语言文件里是同一个资源 ID**。所以拿已经量准的中文名去 `zh-CN.pak` 反查 ID，
 *   再用同一个 ID 读 `en-US.pak`，得到的就是 Chrome 真正会渲染的那一串。
 * - `.pak` 是简单的二进制表（v4/v5 两种头），一个几十行的读取器就够；解析细节照抄 Chromium 的
 *   `tools/grit/pak_util.py`。
 * - **占位符会原样露出来**（`固定“$1”` ↔ `Pin $1`），所以连"扩展名外面到底有没有引号"这种
 *   标点级差异都是直接读出来的，不用猜。上面那条纠错正是这么发现的。
 *
 * **两条不是 Chrome 的**：`FOLDER_LABEL` / `SELECT_FOLDER_BUTTON` 来自 **Windows 的文件夹选择
 * 对话框**（`comdlg32.dll` 的字符串表，实测 id=438 / 439），因此它们跟 **Windows 显示语言**走，
 * **`--lang` 和 Chrome 的语言设置都管不着**。中文 Windows + 英文 Chrome 的机器上，这两条仍然是
 * 中文——把它们和上面那些混为一谈会得出"英文候选没生效"的错误结论。量法同上，只是容器换成
 * MUI（`System32/<lang>/comdlg32.dll.mui` 的 RT_STRING 表，按字符串 ID 对齐）。
 *
 * **一次独立校验**：`ADDRESS_BAR` 的英文名先用上面的方法读出 `Address and search bar`，又在一个
 * 真的英文 Chrome 上用 UIA 读了一次，**逐字相同**——这是"查资源包"等价于"读界面"的证据，不是
 * 想当然。加语言时若不放心，照这个方式挑一条交叉验一下就够，不必整表都去开浏览器。
 */

// ── macOS ────────────────────────────────────────────────────────────────────
//
// 上面那半张表是 **Windows/UIA 实测值**。macOS 的 a11y 是另一套（AX），role 名字、名字放在
// 哪个属性里、对话框长什么样，三样全不同——所以是**另一张表**，不是同一张表加几个候选。
//
// 全部实测 2026-09-07（Intel Mac / macOS 14.6.1 / Chrome 152.0.7977.64 / zh-CN），
// 量法：把 AX 树 dump 出来逐个读，见 `docs/superpowers/reports/2026-09-07-mac-desktop-install-verify.md`。
//
// **三条和 Windows 不一样、直接决定 recipe 怎么写的事实：**
//
// 1. **role 用原生 AX 名**（`AXButton`/`AXCheckBox`/`AXTextField`）。host agent 的 mac 后端
//    对 `AX` 开头的 role 原样透传（见 `app/host-agent/src/macos.rs` 的 `role_to_ax`）。
//    照 Windows 那套中性词写也能跑，但表是照真机 dump 抄的，抄什么写什么最不容易错。
// 2. **名字有三个来源**：原生控件（地址栏、工具栏）在 `AXDescription`，WebUI 元素
//    （开发者模式、加载未打包、详情、移除）在 `AXTitle`。后端 `find` 三个都看，所以这里
//    照旧只写名字；但**读 dump 的时候要知道自己在读哪一格**，否则会以为控件不存在。
// 3. **文件选择面板不是独立窗口**，是 Chrome 窗口里的一个 `AXSheet`。所以 mac 的 recipe
//    **没有**「换到对话框窗口」那一步——换不过去，它不在 `AXWindows` 里。
//
// **`className` 这一格在 mac 上是 `AXIdentifier`**，是应用自己写死的稳定标识
// （`OKButton` / `PathTextField`），**不随界面语言变**。凡是有 identifier 的控件都优先按它认，
// 比按名字铺中英文候选稳得多——这也是为什么下面几条面板控件不需要英文候选。

/** 实测：`AXCheckBox` sub=`AXToggleButton`、名字在 `AXTitle`、`value` 真实反映开关状态。
 *  **但判据仍然不读 value**，和 Windows 一致地用「加载未打包」在不在来判——两边一条判据，
 *  少一处会漂的差异。 */
export const DEV_MODE_TOGGLE_MAC: ControlSpec = {
  role: 'AXCheckBox',
  names: ['开发者模式', 'Developer mode'],
}

/** 实测：`AXButton`、名字在 `AXTitle`。只在开发者模式打开时存在（同 Windows）。 */
export const LOAD_UNPACKED_BUTTON_MAC: ControlSpec = {
  role: 'AXButton',
  names: ['加载未打包的扩展程序', 'Load unpacked'],
}

/** 实测：`AXTextField`、名字在 `AXDescription`、`value` 是当前 URL。名字和 Windows 那条
 *  逐字相同（Chrome 的同一条文案），所以候选表也一样。 */
export const OMNIBOX_MAC: ControlSpec = {
  role: 'AXTextField',
  names: ['地址和搜索栏', 'Address and search bar'],
}

/**
 * 文件选择面板（`AXSheet`，`AXIdentifier=open-panel`）里的确认按钮。
 *
 * **按 `AXIdentifier=OKButton` 认，不按名字认**（名字是「选择」/`Select`，跟界面语言走）。
 * 这是 mac 这半张表最值钱的一条：`OKButton` 是 AppKit 写死的标识，中英文机器上都一样。
 */
export const FOLDER_PANEL_CONFIRM_MAC = { role: 'AXButton', className: 'OKButton' }

/**
 * 面板上那句「选择扩展程序目录。」（`AXStaticText`，`AXIdentifier=_messageTextField`）。
 *
 * 用途只有一个：**等面板真的建好**。面板第一次弹出要几秒（同 Windows），而 mac 上没有
 * 「换到对话框窗口」那一步可以顺带等——换不过去（它是 sheet 不是窗口）。所以这一条是
 * recipe 里唯一能挂 `require` 的锚点。按 identifier 认，同样不吃界面语言。
 */
export const FOLDER_PANEL_MESSAGE_MAC = { role: 'AXStaticText', className: '_messageTextField' }

/**
 * 「前往文件夹」那个输入框（`AXIdentifier=PathTextField`）。
 *
 * **macOS 的文件面板上没有路径输入框**——Windows 那条「找『文件夹:』那个 Edit」的路在这里
 * 根本不存在。唯一的入口是 macOS 的老规矩：**在面板上敲一个 `/`**，冒出一个
 * `AXSheet id=GoToWindow`，这个框就在里面。所以 recipe 里那一步 `type: '/'` 不是玄学，
 * 是这条路唯一的门。
 *
 * 后面紧跟的回车能不能提交，取决于这个框有没有焦点——mac 后端的 `set_value` 因此是
 * 「聚焦 + 写值 + 回读」三件事（见 `macos.rs` 的 `set_value` 头注）。只写值不聚焦时，
 * 值确实进去了、回车却不提交，而每一步都"成功"：实测卡了两轮才定位到。
 */
export const GOTO_FOLDER_PATH_MAC = { role: 'AXTextField', className: 'PathTextField' }

/**
 * macOS 上 Chrome 的进程名。**不带 `.exe`，而且中间有个空格**。
 * `AppMatch.process` 是全等（大小写不敏感）匹配，写错的表现是「没有窗口匹配」。
 */
export const CHROME_PROCESS_MAC = 'Google Chrome'

/** 把一个候选表展开成若干个 A11yQuery（逐个试，第一个命中就用）。 */
export function queriesFor(spec: ControlSpec): Array<{ role: string; name: string }> {
  return spec.names.map((name) => ({ role: spec.role, name }))
}
