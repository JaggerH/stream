import type { A11yQuery, ReadSpec, AppMatch, InputDelivery } from './desktop-driver.ts'
import type { RecipeMeta } from './recipe.ts'
import type { Grounding, GroundingKey } from './desktop-grounding.ts'

/**
 * A `kind:'desktop'` recipe drives a native app via the `a11y` vocabulary (role / name /
 * native invoke), on its OWN desktop runner — parallel to `BrowserRecipe` but NOT riding the
 * browser `PageDriver` (http/html precedent; see
 * `docs/superpowers/specs/2026-07-19-desktop-uia-engine-telegram-design.md`). It is
 * platform-neutral: Stream Desktop's per-OS backend (Windows UIA / macOS AX / Linux AT-SPI)
 * resolves the queries. This is the compiled result of one authoring pass (the flow proven
 * live via the PowerShell stand-in on 2026-07-19) — replay is zero-token deterministic.
 */
export interface DesktopRecipe {
  version: number
  kind: 'desktop'
  sourceId: string
  /** which app/window to control (focus target)。`process` 可以是一组候选（跨平台的名字），见 `ProcessMatch`。 */
  app: RecipeAppMatch
  /**
   * 坐标类输入（click / type / scroll / 打断的 press）投给谁。
   *
   * 省略 = 投给屏幕：agent 合成键鼠输入，每一步之前先把 `app` 抢到前台，抢不到（锁屏、别的窗口
   * 压着）就停手。`'message'` = 投给窗口本身（`PostMessage` 到它的 hwnd）：**不抢前台、锁屏照常跑**，
   * `focus` 步骤退化成只限定范围。这是没有控件树的应用能"人不在时后台干活"的唯一一条路——微信 4.x
   * 锁着屏全程验过（2026-09-07：点搜索框、打中文、回车打开会话、候选弹层照常出来）。
   *
   * **它是显式选的，不是自动退路**：走自己合成器的应用（Electron 系）多半不理会投进来的消息，而且
   * 失败得安静——什么都不发生、什么都不报。哪个应用认只能真机量一次；量过就写在这里，没量过别写。
   * 点没点中由每一步的 `expect` 判，这条路上尤其不能省 `expect`。
   */
  input?: InputDelivery
  /** two-signal login detection (parallel to browser LoginCheck) */
  loginCheck?: DesktopLoginCheck
  /** pre-read actions: focus, invoke a control, type a query, scroll — run in order */
  steps: DesktopStep[]
  /**
   * how to read the result subtree into items (the a11y Observer)。
   *
   * **动作型 recipe 可以整个省掉它**（配 `allowEmpty: true`）。这一格原本是必填的，代价是
   * 一条本来就无物可读的 recipe 得**伪造**一个恒真的 observer 去骗过下面那道"一条都没读到
   * 就判 drift"的闸——`packages/qq/qq-send.recipe.json` 的 `_why_observer_reads_back_what_it_sent`
   * 就是那个疤。伪造的 observer 比缺失更坏：它读什么、读到没读到，都不再有人看，却长得像
   * 一份真的验证。
   */
  observer?: ReadSpec
  /** OPTIONAL: 从读到的文本里再抽出结构化字段（见 `DesktopMap`） */
  map?: DesktopMap
  /** dedupe + stop rule over the observer's items；`observer` 省掉时它也一并省掉 */
  read?: DesktopRead
  /**
   * Treat an empty harvest as a valid `ok` result instead of `blocked('drift')`. 桌面这边的
   * `allowEmpty`，语义对齐 `CanonicalBrowserRecipe.allowEmpty`（`recipe.ts`）：一条采集型
   * recipe 读到 0 条通常说明界面没到位/结构漂了，判 drift 是对的默认；但一条**动作型** recipe
   * （比如"给某联系人发一条消息"）本来就无物可读，0 条是它唯一合法的成功形状——不开这个
   * 开关，这类 recipe 永远过不了 `desktop-runner.ts` 里"一条都没读到就判 drift"那道闸
   * （此前只能靠伪造一个恒真的 observer 去骗过它，见 `packages/qq/qq-send.recipe.json` 的
   * `_why_observer_reads_back_what_it_sent`）。
   *
   * **它不是把失败关掉**：它只对"这条 recipe 本来就不产 item"这一档成立。一条该读到东西的
   * recipe 读不到，仍然必须判 drift——这个开关只改变"0 条"这一个结果的判法，不改变其它任何
   * 失败路径（登录墙仍然短路成 `needsLogin`；`invoke` 步骤找不到目标仍然判 drift）。
   */
  allowEmpty?: boolean
  /** optional discovery metadata → synthesized SourceManifest */
  meta?: RecipeMeta
  /** 不属于任何一步、随时可能跳出来的临时界面。只在某步 expect 不成立时查；每步最多消化一次。 */
  interrupts?: DesktopInterrupt[]
  /**
   * 条件边（**本期只校验、不执行**）：在某个 key 下、从某一步之后插入几步。格式先钉住，免得
   * 本机 override 与包各写各的。**带了它的 recipe 整趟都不跑**——runner 在发出任何输入之前就以
   * `edges-unsupported` 判 drift（`desktop-runner.ts` 的 `runDesktopRecipeLocked` 开头），
   * 而不是照常跑完、安静地少插几步。
   */
  edges?: DesktopEdge[]
  /**
   * 具名区域（spec §3.4）：判据的文字通用，判据看的那一块屏按平台落地。`see.area` 引用这里的名字。
   * 一块区域 = 通用 `region`（可省）+ 分平台的 `groundings[]`（body 只有 `region`）。选法是查表，
   * 不逐条试——区域没有自己的 expect 可以兜底。
   */
  areas?: Record<string, DesktopArea>
}

/** 见 `DesktopRecipe.edges`：`from` 是某一步的 `label`，`on` 与 grounding 同一套 key。 */
export interface DesktopEdge {
  from: string
  on: GroundingKey
  insert: DesktopStep[]
}

export interface DesktopArea {
  /** 人话：这一块是什么、边界为什么这么画。 */
  intent?: string
  /** 通用落地方式（同顶层 step body）。省掉 = 只有 groundings 里相符的那条才算有。 */
  region?: SeeRegion
  groundings?: Grounding[]
}

/**
 * 每一种步骤都能挂的两样东西。
 *
 * `label`：这一步在**出错时**怎么跟人说。runner 把它拼进 `driftReason`——没有它，一条
 * 二十步的 recipe 失败了只会报 `invoke target not found: {"role":"Button","name":"…"}`，
 * 读的人得自己回去数第几步。**面向用户的流程（代装扩展这类）必须写**：那里的 `blocked`
 * 是直接给用户看的。
 *
 * `skipIf`：**这个控件在场就跳过这一步**。它和 `optional` 是两件事，别混——`optional` 问的是
 * "我自己的目标在不在"（复位步骤），`skipIf` 问的是"**别人**在不在"。
 *
 * 非有不可的场景是**幂等开关**：Chrome 的「开发者模式」那个 toggle 一直都在，名字里也不带
 * 状态（`role=Button`、name 恒为「开发者模式」），所以"它现在是开是关"根本读不出来；而已经
 * 开着还点一次，就是把它**关掉**。唯一能问的是一个行为判据——「加载未打包的扩展程序」这个
 * 按钮只在开发者模式打开时存在。`skipIf` 就是让 recipe 能表达这一句。
 */
export interface DesktopStepCommon {
  /** 这一步的名字。**必填、整份 recipe 内唯一**：本机 override 与贡献物都拿它当键（装载期强制，`recipe-store.ts`）。 */
  label?: string
  /** 人话意图（"把键盘焦点放进消息输入框"）。引擎不解析；给未来替这一步重新找落地方式的人/模型读。 */
  intent?: string
  /**
   * **并列的落地方式**：每条是一份完整的动作 body（同一套 kind / see / query / at 词汇）外加
   * `on`（在哪个平台 / 版本上验过）与 `verified`。顶层 body 是「通用」那条，永远排最后。
   * 判据（`expect` / `require`）、`else` / `optional` / `blind` 只在顶层——落地方式换了，
   * 「做完该看见什么」不变。选择与逐条试的规则见 `desktop-grounding.ts`。
   */
  groundings?: Grounding[]
  skipIf?: DesktopQuery
  /**
   * **前置条件**：动作之前必须成立的状态，等到成立（最多 `timeoutMs`）再做这一步；等不到按这一步的
   * `else` 处理（`abort` = 此后不再发任何输入；其余 = drift）。
   *
   * 和 `expect` 正好相反：`expect` 动作前必须为假、动作后必须为真；`require` 是"此刻必须为真"。
   * 它补的是 `expect` 够不着的一格——**判据落在别的窗口里的那一步**。微信发消息：点候选弹层里的
   * 那一行之后弹层就关了，「会话标题是他」这个判据在主窗口里，而点击那一步的 `expect` 只能在弹层
   * 的范围里验（弹层没了，读屏直接报错）。于是把判据挂到**下一步**（打正文）的前面：标题不是他，
   * 正文一个字都不打。这就是"发错人"那道闸的正确落点。
   */
  require?: DesktopStepExpect
  /**
   * **这一步没有可观测的后果，理由是……**——动作步骤不写 `expect` 时必须写它（装载期强制，
   * 见 `recipe-store.ts`）。内容是给人读的一句话，引擎不解析。
   *
   * 为什么要逼这一句：「我点了一个东西，接下来就该看见某个东西」是这条链路的基础规则，而它
   * 此前是**可选**的——量过一次，21 个动作步里 18 个没写（2026-09-07）。没写的那些不是"不需要
   * 验"，是没人想过；代价是点空了要拖到两三步之后才以别的面目冒出来，排查时根本回不到现场。
   * 写不出 `expect` 是允许的（有些转移在这个后端上真的看不见，比如"输入框拿到了焦点"在视觉方案
   * 里没有任何画面变化），但**必须说出来**——把"忘了写"和"想过、确实没有"分开。
   */
  blind?: string
}

/**
 * recipe 里的定位查询 = wire 上那个 `A11yQuery` 再加一样**只在 recipe 层成立**的东西：
 * `nameAnyOf` —— 逐个名字试，第一个命中就用。
 *
 * **为什么非有不可**：桌面应用的控件名跟着用户的界面语言走（中文机器上是「开发者模式」，
 * 英文机器上是 `Developer mode`）。`A11yQuery.name` 只有一格，于是一条 recipe 只能押一门语言，
 * 换台机器就是**空结果**——而空结果和"这个版本改了界面"长得一模一样，排查的人无从下手。
 *
 * **它不上 wire**：runner 在本地展开成若干次普通 `find`，agent 那边什么都不用改。放进
 * `A11yQuery` 反而危险——那个类型是给 agent 的，多一个它不认识的字段就会被静默忽略，
 * 表现是"限定条件突然失效"。
 */
export type DesktopQuery = A11yQuery & { nameAnyOf?: string[] }

/**
 * `pixel` 词汇的查询：「人眼看到的是什么」。`text` 与 `icon` 恰给一个。
 * 怎么把它变成一个框见 `desktop-see.ts`（`resolveSee`）——recipe 只写意图，不写坐标、不写图。
 * `region` 按窗口九宫格限定搜索范围：边缘档取 1/3，`center` 取中央 1/3×1/3。
 */
export interface See {
  /** 屏幕上这段文字所在处（屏幕文字 / 控件名）。支持 `{param}` 插值。本地四档（控件树 / 固化句柄 /
   *  OCR / 模板）落空后要不要上模型，由**步骤是不是 `optional`** 决定，不由目标类型决定——见
   *  `DesktopStepKind` 里 `optional` 的头注。 */
  text?: string
  /** 没有文字可指时的一句话描述（"放大镜图标"）。只能经 `via:'model'` 诞生模板。 */
  icon?: string
  /**
   * **梯子最后一档的目标：一句自然语言描述**（「消息输入框」）。前四档全部落空时，把窗口截图
   * 连同这句话发给 grounding 模型，让它**直接回一个绝对坐标**。
   *
   * 它和 `text` / `icon` 的区别不是"换个说法"，是**换了一个问题**：那两个问的是「这些候选里
   * 哪个是」，而候选一律来自元素表——所以**元素表里压根没有的东西，那两个永远指不到**。
   * 空的消息输入框就是这一类：OCR 无字、检测器不给框、控件树那一侧要另走一条路。`point`
   * 问的是「它在哪」，模型可以指出一个元素表里不存在的位置。
   *
   * **有 `text` 能指的东西不要写 `point`**：那是白付一次模型钱，而前四档本来就找得到。
   *
   * **判据位（`expect` / `require` / `branch.when`）用它等于那条判据永远不成立**——判据不许
   * 调模型（`resolve` 的 `allowModel:false`），所以这一档在判据路上必然落空。装载期不拦
   * （一个 `see` 出现在动作位还是判据位由步骤类型决定，不由这里判），这条写在作者手册里。
   */
  point?: string
  region?: SeeRegion
  /**
   * 引用顶层 `areas` 里的一块具名区域，**与 `region` 互斥**。运行时按（平台，版本）查表换成那一块的
   * `region`（`desktop-runner.ts` 开跑前做，`resolveSee` 永远看不到这个字段）。什么时候该用它见 spec §3.4：
   * 同一块屏被多条判据引用、或两平台位置不同；一处只用一次、两平台一样的矩形照旧内联 `region`。
   */
  area?: string
  /**
   * **按章节找**：只认落在这些小标题**下方**的那一段（离它最近的那个小标题得是其中之一）。
   *
   * 给分节列表用的：微信搜索候选弹层里，同一个名字会出现好几次——「搜索网络结果」下面是一排
   * 网页搜索建议（第一条恰好就是你打的字，全等命中！），「联系人」/「功能」/「公众号」下面才是
   * 真的那个账号，「收藏」下面又有「来自：某某」。按 `region` 切不动它：各节的位置随结果动态变
   * （联系人排第一，机器人排在网络建议之后）。而"它在哪个小标题下面"是稳的——这正是人眼分辨
   * 它们的办法。`notBelow` 列出**不算**的小标题；两份合起来才是"哪些字是小标题"的全集，一个
   * 候选归离它最近的上方小标题。没有任何已知小标题在它上方 → 不算。
   */
  below?: string[]
  notBelow?: string[]
  /**
   * **别要那一行**：候选**所在的那一行**里只要出现这些字中的任何一段，整行出局。
   *
   * 给"看起来像目标、其实是另一个入口"的行用。QQ 搜索「我的手机」，左栏会同时出现真正的
   * 会话行和最下面那行「进入全网搜索我的手机」——两行都写着这四个字，靠位置分不开（名字长一点
   * 就错位），靠"哪个更靠上"也不稳（结果顺序会变）。而"那一行里带着『进入全网搜索』"是它和
   * 目标之间**稳定的、语义上的**区别，正是人一眼分开它们的依据。
   *
   * **判据落在行上，不落在段上**，这一点是必须的：OCR 每帧的分段不一样，兜底行有时是一整段
   * 「进入全网搜索我的手机」，有时被切成「进入全网搜索」+「我的手机」——只按段剔，剔掉的是前
   * 半段，后半段照样是个和目标全等的假候选（本机 2026-09-07 实录）。按行聚合之后，怎么切都
   * 不影响结论。
   *
   * 同一行 = 纵向重叠过半的那些段（`sameRow`）。
   */
  not?: string[]
}
/**
 * 九宫格的正向档（罩住某一块）+ 四个排除档（`not-<边>`：窗口除那一侧三分之一以外的全部）。
 *
 * 排除档存在的理由是**固定宽度的侧栏**：微信左栏是固定逻辑宽度，会话标题紧挨着它的右边，
 * 落在窗口横向的中间三分之一（本机 1946 宽时 x≈700），最大化时又会滑进左边三分之一——没有
 * 一个正向格能在所有窗口尺寸下罩住它；而「名字出现在左栏以外的任何地方」在默认尺寸和最大化下
 * 都成立（左栏占比只会随窗口变大而变小）。步骤的 `expect` 又必须把搜索框排除在外（名字此刻正
 * 躺在里面，罩住它就成了恒真的装饰），所以要的正是"排除左栏、其余都算"。
 */
export type SeeRegion =
  | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'
  | 'not-left' | 'not-right' | 'not-top' | 'not-bottom'
  | SeeRegionRect
/**
 * 九宫格切不出来的那一块：按窗口宽高的**比例**给一个矩形（0–1）。给"排除顶上那一条搜索栏"这种用：
 * QQ 的搜索结果紧挨着搜索栏下面（y≈0.18），而搜索栏里正躺着刚打进去的同一个名字——`not-top` 连结果
 * 一起排掉了。比例矩形押的是"这一块在窗口里的相对位置"，随窗口缩放但不随内容漂，固定在窗口边上的
 * 栏（搜索栏、标题栏、底部输入栏）用它是稳的；随内容动的东西（列表行）别用它，用 `below`。
 *
 * **`unit:'dip'`：按逻辑像素给，从窗口左上角量。** 比例矩形押的是"这一块占窗口的比例"，而固定
 * 像素宽的栏（微信左栏 335 逻辑像素、顶部标题条 80 逻辑像素）**不随窗口缩放**：窗口从 1600 宽
 * 拉到 4K 最大化，左栏从 0.2 缩到 0.09，比例矩形 `x:0.2` 就把紧贴左栏的会话标题整个排掉了
 * （活体 2026-09-18：3838×2062 的窗，标题在 x≈695 物理像素，0.2 是 768）。这种栏用 `dip`：
 * 数值 × 当次读屏回执的 `scale` 就是物理像素，随 DPI 走、不随窗口尺寸走。`x` / `y` 为负 = 从
 * 右边 / 下边往回量（底部输入栏：`y:-240` = 下沿往上 240 逻辑像素起）；`w` / `h` 可省 = 一直到
 * 窗口右边 / 下边；比例模式下四个都必填。
 */
export interface SeeRegionRect { x: number; y: number; w?: number; h?: number; unit?: 'dip' }

/**
 * 锚点：屏上一段能稳定认出来的文字。
 *
 * （图标指纹那一档要等 `find_image` 接进识别层，到时候这里变成一个联合类型。）
 */
export interface TextAnchor { text: string }

/**
 * 把一条文字判据收窄到「锚点的某一边」。
 *
 * **这是防止认错对象的那道闸**，不是可有可无的修饰。活体实测（QQ）：判断"我在和某人的对话里"
 * 时，那个人的名字**同时出现在右侧对话标题和中间会话列表里**；只问"这个名字在不在屏上"，
 * 在**别人**的对话窗口里也会为真——那一步的下一格就是发消息。
 *
 * 形状照 UiPath 的 Anchor Base（商业 RPA 给无 a11y 界面定位的标准做法）：锚点 + 方向 + 距离。
 * 两条不能省：
 * - **另一轴必须重叠**（`left`/`right` 要求同一行）。Selenium 的 `above`/`leftOf` 就是不检查
 *   另一轴，于是"上方"命中整条水平线以上的任何元素。
 * - **距离的单位是锚点自身的尺寸，不是像素**。Selenium 的 `near()` 写死"外扩 50 像素"、
 *   SikuliX 的 `below(20)` 同样是绝对像素——DPI 一变语义就变。
 */
export interface TextWhere {
  anchor: TextAnchor
  /** 目标在锚点的哪一边。`left` = 目标在锚点左边。 */
  side: 'left' | 'right' | 'above' | 'below'
  /** 最大间隔，单位是锚点框的宽（左右）或高（上下）的倍数。省略 = 不限。 */
  maxDist?: number
}
export const SEE_REGIONS: readonly string[] = [
  'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center',
  'not-left', 'not-right', 'not-top', 'not-bottom',
]

/**
 * 每个动作步骤的预期状态。两条纪律（照浏览器侧 `StepExpect`）：动作前必须为假、动作后必须为真——
 * 恒真的判据是装饰不是监督；动作后轮询到成立或超时。**只走 a11y / screen / template，不调模型。**
 */
export interface DesktopStepExpect {
  see?: See
  query?: DesktopQuery
  /** 默认 3000 */
  timeoutMs?: number
  /**
   * **在新位置出现才算**（只配 `see.text`，只在 `expect` 上）。动作前先记下这段字在区域里的
   * 全部位置，动作后要看到一个**不在那张清单里**的位置才算兑现；"动作前必为假"那道恒真预检
   * 对它不做——它的前提就是这段字动作前可能已经在屏上。
   *
   * 给"区域画不准"的判据用：微信的输入框能被用户拖高拖矮，输入框和气泡之间没有一条固定的线，
   * 按死线画的「输入区」/「气泡区」换个高度就一个读不到正文、一个把输入框罩进来（活体 2026-09-29：
   * 输入框 262 逻辑像素高，正文中心落在 240 那条线外 1 像素，两步都停）。改问"冒没冒出新的一处"：
   * 打字 → 输入框里多一处；回车 → 气泡里多一处、输入框那处消失（没发出去就只剩原位那处，不算）；
   * 连发同一句 → 上一条的位置已在清单里，新的一条照样算新。
   */
  fresh?: boolean
}
/**
 * `branch.when` 的参数形状：调用方给的参数 `param` 等于 `equals` 就成立。
 *
 * 比较在**字符串**上做：参数到 runner 手里时已经全部 `String()` 过（`action-recipe.ts` / `recipe-debug.ts`
 * 的 `stringParams`，布尔 `false` 到这里是 `"false"`），所以 `equals` 写布尔 / 数字 / 字符串都行，装载期
 * 存成什么运行时都按 `String(equals)` 比。参数缺席（调用方没给、schema 也没 default）= 不成立——
 * 不猜默认值，默认值只有一处（`params_schema.<k>.default`）。
 *
 * `param` 必须是 `meta.params_schema` 里声明过的键（装载期拒）：拼错一个字母的分支永远不成立，而
 * 表现是"参数没生效、照常发了"——对一条以"不发"为卖点的开关，这是最坏的静默失败。
 */
export interface DesktopParamCondition {
  param: string
  equals: string | number | boolean
}
export function isParamCondition(w: DesktopStepExpect | DesktopParamCondition): w is DesktopParamCondition {
  return typeof (w as DesktopParamCondition).param === 'string'
}

/** expect 不成立（含消化过一次打断之后仍不成立）时怎么办。`retry` 上限一次；`abort` 之后不再发任何输入。 */
export type Else = 'drift' | 'retry' | 'abort'
export const ELSE_VALUES: readonly Else[] = ['drift', 'retry', 'abort']

/** 一条打断：`see` 命中就执行 `dismiss`。只放"关掉就能继续"的东西，登录墙归 `loginCheck`。 */
export interface DesktopInterrupt {
  see: See
  dismiss:
    | { kind: 'invoke'; see?: See; query?: DesktopQuery }
    | { kind: 'press'; key: 'Escape' | 'Enter' }
  /**
   * 默认只在某步 expect 不成立时才查（失败时才付读屏的钱，见 `desktop-runner.ts` 的
   * `tryDismiss` 头注）。置真 = 也在 `focus` 步骤之后无条件查一次——只给「启动即弹、会挡住
   * 第一步」的那种（QQ 的启动广告/对话框），别的打断别开：一次整窗读屏 2–5 秒（无 region 时
   * 更贵），每趟都付，而多数打断根本不会在 focus 那一刻出现。
   */
  atFocus?: boolean
}

/**
 * 校验一个 `See`：`text` / `icon` 恰给一个，`region` 认得出来。抛出的话，`where` 是这一处的
 * 人话位置（`recipe "x": steps[3]`）。
 *
 * **它在类型模块里而不是在装载器里**，因为 recipe 装载不是唯一的入口：本机那张打断表
 * （`<cacheDir>/<sourceId>/interrupts.json`，`SeeCache.interrupts()` 读）是**磁盘上的一份
 * JSON**，没有经过装载器的任何一道闸。同一份规矩必须两边同吃——否则一条 `{dismiss:{kind:
 * 'invoke'}}`（既没 see 也没 query）会让 runner 去 `find({})`，拿到窗口里的**第一个元素**
 * 然后 invoke 它。那是"随手点一下不认识的界面"，正是这条链路最贵的那种错。
 */
export function validateSee(see: unknown, where: string, opts: { areas?: ReadonlySet<string> } = {}): See {
  const s = see as { text?: unknown; icon?: unknown; point?: unknown; region?: unknown; area?: unknown }
  const given = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  const hasText = given(s?.text)
  const hasIcon = given(s?.icon)
  const hasPoint = given(s?.point)
  // 三选一。**给两个是矛盾，不是宽容**：下游只会用其中一个，而用的是哪个说不清——
  // 表现是每一步都"成功"，只是指的不是你写的那个。
  if ([hasText, hasIcon, hasPoint].filter(Boolean).length !== 1) {
    throw new Error(`${where}.see 必须恰好给 text / icon / point 之一`)
  }
  if (s.area !== undefined) {
    if (typeof s.area !== 'string' || !s.area.trim()) throw new Error(`${where}.see.area 要是一个区域名`)
    if (s.region !== undefined) throw new Error(`${where}.see 同时给了 area 和 region——一处只能看一块`)
    // 本机 interrupts.json 那条入口不带 areas：它不属于任何 recipe，没有区域可引用。
    if (!opts.areas) throw new Error(`${where}.see.area 在这里不能用（这份 see 不属于任何 recipe，没有可引用的区域）`)
    if (!opts.areas.has(s.area)) throw new Error(`${where}.see.area 指向不存在的区域：「${s.area}」（顶层 areas 里只有 ${[...opts.areas].join(' / ') || '（空）'}）`)
  }
  if (s.region !== undefined) {
    const r = s.region as SeeRegionRect
    const frac = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
    const px = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
    const isObj = typeof r === 'object' && r !== null
    const isRect = isObj && r.unit === undefined && frac(r.x) && frac(r.y) && frac(r.w) && frac(r.h) && r.w! > 0 && r.h! > 0 && r.x + r.w! <= 1 + 1e-9 && r.y + r.h! <= 1 + 1e-9
    const isDip = isObj && r.unit === 'dip' && px(r.x) && px(r.y) && (r.w === undefined || (px(r.w) && r.w > 0)) && (r.h === undefined || (px(r.h) && r.h > 0))
    if (isObj && r.unit === 'dip' && !isDip) {
      throw new Error(`${where}.see.region 的 dip 矩形不合法：${JSON.stringify(s.region)}（x/y 是逻辑像素、负数从右/下边量；w/h 可省，给了要 > 0）`)
    }
    if (!isRect && !isDip && !SEE_REGIONS.includes(s.region as string)) {
      throw new Error(`${where}.see.region 不认识：${JSON.stringify(s.region)}（九宫格名、not-<边>、0–1 比例矩形 {x,y,w,h}，或逻辑像素矩形 {unit:'dip',x,y,w?,h?}）`)
    }
  }
  const list = (v: unknown, name: string) => {
    if (v === undefined) return
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || !x)) {
      throw new Error(`${where}.see.${name} 要是非空的字符串数组`)
    }
  }
  const b = (see as { below?: unknown; notBelow?: unknown; not?: unknown })
  list(b.below, 'below')
  list(b.notBelow, 'notBelow')
  list(b.not, 'not')
  if (b.notBelow !== undefined && b.below === undefined) throw new Error(`${where}.see.notBelow 要配 below 一起给——它只是"哪些小标题不算"，没有 below 就没有"算"的那一半`)
  if (b.below !== undefined && !hasText) throw new Error(`${where}.see.below 只对 text 目标有意义`)
  return see as See
}

/**
 * 校验一个"要么 query 要么 see"的目标（步骤 / dismiss 都用）。两个都给是矛盾，不是宽容。
 *
 * `opts.areas` 原样透给 `validateSee`：**动作位的 see 和判据位的 see 是同一种 see**（spec §3.4），
 * 两条路一分家，一条合法的动作位 `see.area` 会被拒成"这份 see 不属于任何 recipe"——对着一份
 * 真 recipe 说这句话是错的，而且把作者引向"是不是我 recipe 写坏了"。
 */
export function validateTarget(t: { query?: unknown; see?: unknown }, where: string, opts: { areas?: ReadonlySet<string> } = {}): void {
  if (t.query !== undefined && t.see !== undefined) throw new Error(`${where} 的 query 与 see 只能给一个`)
  if (t.see !== undefined) validateSee(t.see, where, opts)
}

/**
 * 校验一条打断（见 `validateSee` 的头注：recipe 装载与本机 `interrupts.json` 两个入口同吃这一份）。
 *
 * `opts.areas` 只有 recipe 装载那一侧会给：包内的 `interrupts[]` 属于这份 recipe，它的 `see.area`
 * 和 `dismiss.see.area` 一样能引用顶层 `areas`。本机 `interrupts.json`（`SeeCache.interrupts()`）
 * 不属于任何 recipe——那条入口原样调用（省略 opts），继续拒绝 `area`。
 */
export function validateInterrupt(entry: unknown, where: string, opts: { areas?: ReadonlySet<string> } = {}): DesktopInterrupt {
  const it = entry as { see?: unknown; dismiss?: unknown; atFocus?: unknown } | undefined
  validateSee(it?.see, where, opts)
  const d = it?.dismiss as { kind?: unknown; key?: unknown; query?: unknown; see?: unknown } | undefined
  if (d?.kind === 'press') {
    if (d.key !== 'Escape' && d.key !== 'Enter') throw new Error(`${where}.dismiss.key 只认 Escape / Enter`)
  } else if (d?.kind === 'invoke') {
    validateTarget(d, `${where}.dismiss`, opts)
    if (d.query === undefined && d.see === undefined) throw new Error(`${where}.dismiss invoke 要给 query 或 see`)
  } else {
    throw new Error(`${where}.dismiss 只认 invoke / press`)
  }
  if (it?.atFocus !== undefined && typeof it.atFocus !== 'boolean') {
    throw new Error(`${where}.atFocus 只认布尔值`)
  }
  return entry as DesktopInterrupt
}

/**
 * recipe 里写的进程名：一个，或**一组候选**（同一个应用在不同平台上叫不同的名字——Windows 上
 * 微信是 `Weixin.exe`，mac 上是 `微信` / `WeChat`）。一条 recipe 只写一份、两边都能跑，靠的就是
 * 这一格；平台分叉**只在名字上**，步骤本身是平台中立的 a11y / see 词汇。
 *
 * 候选之间不需要知道"现在是哪个平台"——同一台机器上只会有其中一个名字在跑，所以判据是
 * 「屏上有哪个」（`concretizeApp`），不是 `process.platform`：后端在 WSL 里、agent 在 Windows 上
 * 这种组合下，后端自己的平台本来就是错的答案。
 */
export type ProcessMatch = string | string[]

/** `DesktopRecipe.app` / `window` 步骤里写的目标：`AppMatch` 放宽到 `process` 可多候选。
 *  发给 agent 之前要经 `concretizeApp` 落成具体那一个——agent 的协议只认一个名字。 */
export type RecipeAppMatch = Omit<AppMatch, 'process'> & {
  process?: ProcessMatch
  /**
   * 这个应用**有没有控件树**。缺省 `true`（不写就是今天的行为）。
   *
   * `false` 是作者的**事实申报**（微信 4.x 整个窗口只有一个自绘 Pane，这不随窗口前后台变），
   * 动作前的元素表读取（`readElements`）就不再枚举控件树——每步省 80–90ms。它和 agent 拒绝的
   * "问一次是空的就永久记黑名单"不是一回事：那是运行时从一次临时状态推出永久结论，这是作者
   * 声明一个不变的事实。写错的表现是 a11y 段永远缺席、点击全走坐标，而每一步照样"成功"——
   * 所以只在 `see-probe` 的 `elements` 里 `kind:"a11y"` 恒为空、且应用是已知自绘时才写它。
   * 判据路（`readText`）不受它影响，它本来就不查控件树。
   */
  a11y?: boolean
}

/** `window` 步骤的目标。`titleAnyOf` 是 `title` 的多候选版，理由同 `DesktopQuery.nameAnyOf`
 *  ——窗口标题一样跟着界面语言走（「扩展程序 - Google Chrome」/「Extensions - Google Chrome」）。
 *  两个都给时以 `titleAnyOf` 为准。
 *  **去掉 `a11y`**：那是整个应用「有没有控件树」的事实申报，只在 `app` 上有意义——`window` 步骤
 *  切的是同一个应用里的另一个窗口，控件树有没有不会因为换了窗口就变，写在这里没有语义，tsc 应拒。 */
export type DesktopWindowMatch = Omit<RecipeAppMatch, 'a11y'> & { titleAnyOf?: string[] }

/** 这个窗口的进程名是不是 recipe 要的那个（或那组之一）。`want` 省略 = 不按进程过滤。 */
export function processMatches(want: ProcessMatch | undefined, have: string): boolean {
  if (want == null) return true
  return Array.isArray(want) ? want.includes(have) : want === have
}

/**
 * 把多候选的 `process` 落成 agent 认的那一个：候选里**此刻屏上有的**那个；一个都没有就取第一个
 * ——下游 `scopeWindow` / `waitForWindow` 会照常以「找不到窗口 + 此刻在的窗口清单」失败，
 * 报出来的名字是 recipe 里写的第一个，读的人一眼能对上。单个字符串原样透传。
 */
export function concretizeApp<T extends RecipeAppMatch>(
  match: T,
  windows: ReadonlyArray<{ process: string }>,
): Omit<T, 'process'> & { process?: string } {
  const { process, ...rest } = match
  if (!Array.isArray(process)) return { ...rest, ...(process !== undefined ? { process } : {}) }
  const present = process.find((p) => windows.some((w) => w.process === p))
  const picked = present ?? process[0]
  return { ...rest, ...(picked !== undefined ? { process: picked } : {}) }
}

/**
 * One desktop step. `text` and query `name`/`className` values may carry `{param}` holes
 * filled from the call-time params (e.g. the search query).
 */
export type DesktopStep = DesktopStepKind & DesktopStepCommon

type DesktopStepKind =
  /**
   * `wake`：动手之前**先发一下真实输入**（把鼠标移到目标窗口中心），把渲染端叫醒。
   *
   * **只有 `input:'message'` 那条路需要它，而它需要得很硬。** `PostMessage` 不是"用户输入"：
   * 它不重置系统的空闲计时器、不唤显示器、也不让 Chromium 把窗口从 occluded 里放出来。机器
   * 一闲下来（锁屏是其中一种，但**不锁也会**），Chromium 一类应用会把渲染端挂起，此后
   * 投进去的点击与按键**整份被静默丢弃**——而 `PostMessage` 照样返回成功，没有任何一处会喊。
   *
   * 本机 2026-09-08 实测（`stream-desktop focus-spike`，QQ）：
   * - 睡着时投点击 + 打字：`plain` **0/6**、`rowclick` **0/4**，同时刻控件树 `Edit/Text` 全是 0；
   * - 先发一下真实鼠标移动再点（`wake`）：**3/4**（第 1 轮正好落在叫醒的那一下之前）；
   * - 用户刚解锁那会儿（机器还醒着）：`plain` **8/8**。
   *
   * 也就是说这条链路此前那种"三轮输一次、每次输在不同的一步"，根本不是焦点随机，是
   * **"最近有没有人碰过这台机器"**。判据也有了：控件树读回 0 个 = 渲染端睡着 = 这一轮投什么都白投。
   *
   * **代价要说清楚**：它会挪动用户的物理鼠标指针（`SendInput`，不是投给窗口的消息）。这是
   * 一次真实输入，比抢前台轻但不是零打扰，所以**做成显式开关而不是默认行为**——别让每条
   * 桌面 recipe 都无声地开始动用户的鼠标。锁屏时真实输入会被系统拒绝，那一档叫不醒，
   * 于是后面的步骤照常以"expect 未兑现"失败，而 `driftReason` 会带上"这一轮屏幕锁着"。
   */
  | { kind: 'focus'; wake?: boolean }
  /** locate a control by an a11y query and trigger its native invoke (the handle fast-path);
   *  `fallbackClick` allows a coordinate click on the located rect when invoke is unavailable. */
  /**
   * `optional`：找不到目标就**跳过这一步**，而不是判 drift。
   *
   * 这是给**复位步骤**用的：桌面应用是有状态的，上一轮跑完会把界面留在某个样子（Telegram
   * 跑完停在搜索模式），下一轮的第一步就会点到不该点的东西——真撞过：复位缺席时，第一步
   * 「按名点进频道」匹配到的是上一轮**残留的搜索结果**（它的名字里同样有频道名），于是整条
   * recipe 从第二步起全在错的界面上跑，而每一步都"成功"了。
   *
   * 复位天然是可选的：首次运行时那个「取消搜索」按钮根本不存在，找不到正是**正常**情况。
   * 除复位之外别用它——把一个真该失败的步骤标成 optional，等于把 drift 变成静默错误。
   */
  | { kind: 'invoke'; query?: DesktopQuery; see?: See; fallbackClick?: boolean; optional?: boolean; expect?: DesktopStepExpect; else?: Else }
  /**
   * 把文字打进输入框。**给不给 `query` 决定这一步抢不抢屏。**
   *
   * - 给了 `query`：定位那个输入框 → `setValue`（ValuePattern 一类）把文字**写进元素**。
   *   不经键盘、不需要前台，因此整轮采集可以不碰用户的屏幕——这是定时采集该走的路。
   * - 没给：Engine 键盘打给"此刻的焦点窗口"，所以执行前必须 `focusApp` 抢屏。
   *
   * 给了 `query` 也可能落到键盘那条路上：不是所有控件都认 Value pattern（自绘应用的 provider
   * 可能不给，或给了却不触发自己的 text-changed）。此时 runner **退回键盘并把这一轮记成
   * `typedVia:'keyboard'`**——退路要有，但不能是静默的，否则"半夜抢屏"只是换了个地方长出来。
   */
  /**
   * `requireTarget`：**定位不到 `query` 就判 drift，不许退回键盘。**
   *
   * 默认那条退路（找不到输入框也照打，键盘投给焦点窗口）对采集是对的——焦点通常是上一步点出来
   * 的，把它升级成失败等于给一个可选加速手段加一个新失败点。但对**面向用户、要往特定框里填
   * 特定内容**的流程，它是有害的：文字会打进当时碰巧有焦点的那个东西（页面、别的输入框），
   * 而这一步"成功"了，失败要到很多步之后才以另一副面孔冒出来——报出来的原因就指错了地方。
   */
  | { kind: 'type'; text: string; query?: DesktopQuery; see?: See; requireTarget?: boolean; expect?: DesktopStepExpect; else?: Else }
  /**
   * 屏幕坐标点击（**物理像素**，绝对坐标）。一定走坐标路、一定先抢前台（同 `scroll`）。
   *
   * **新 recipe 别写它**：坐标押的是"窗口在这台机器上摆在这个位置、这个尺寸"，换台机器就点到
   * 别处，而每一步照样"成功"（`wechat-send` 那次发错人就是这么来的）。没有控件树的自绘应用用
   * `see` 指屏幕上的文字/图标，让识别层去找框（`desktop-see.ts`）。这一格留给还没改写的老 recipe，
   * `x`/`y` 允许 `{param}` 模板好把数字挪进 `params_schema`。
   *
   * **`at`：按当前窗口的比例点**（`{x:0.6, y:0.87}` = 窗口宽 60%、高 87% 处），运行时取一次窗口
   * rect 换成屏幕坐标，跟着窗口的位置与尺寸走、DPI 无关。它是给**识别层没有靶子的那一块**用的
   * ——微信的空消息输入框：无文字、无图标、控件树里没有它、`see.point` 又要视觉模型（没配模型的
   * 机器上必死）。比例仍然押着"这块区域在窗口里的相对位置"（布局改版就点偏），所以只配布局
   * 稳定的大块（输入区、内容区），并且照样靠下一步的 `expect` 兜住点没点中。`at` 与 `x`/`y`
   * 二选一。
   */
  | {
      kind: 'click'
      x?: number | string
      y?: number | string
      at?: { x: number; y: number }
      expect?: DesktopStepExpect
      else?: Else
    }
  /** one Engine-level scroll (paging happens in `read`, not here) */
  | { kind: 'scroll'; dir: 'up' | 'down'; amount: number; expect?: DesktopStepExpect; else?: Else }
  /**
   * 单个按键。**放行哪些键由一条判据决定，不是一份先例清单**（装载期强制，见
   * `recipe-store.ts` 的 `PRESSABLE_KEYS`）：
   *
   * > **只放行「改变状态、但不 actuate 任何东西」的键。**
   *
   * 按键和坐标一样**没有收件人**——谁持有焦点谁收下。这道闸防的不是某个特定的键，是
   * "recipe 能敲任意键"（`Ctrl+W` / `Alt+F4` / `Delete` 全在同一条路上）。今天放行两个：
   * `Escape`（复位）与 `Tab`（挪焦点）。`Enter`、空格这类**会触发当前控件**的一律不放行；
   * 回车另有 `type "\n"` 那条路，同一件事不给两种写法。
   *
   * `times`：同一个键连按 N 次（1..20）。**只为一件事存在**——`Tab×6` 写成六个步骤就是六个
   * `blind` 各自讲同一句话，而"6 是怎么来的、怎么重新求"没有一个地方写得下。`times > 1` 时
   * 这一步**必须**给 `blind`：逐次按键在识别层没有任何可观察变化，硬写 `expect` 只会写出一个
   * 恒真的装饰。
   *
   * **别把它当无条件的第一步。** 桌面应用是有状态的，但状态是**读得出来的**——"搜索框是不是空的"
   * 就是「placeholder『搜索』在不在」，"会话是不是他"就是「右侧标题是不是他」。正确的形状是
   * 先用 `branch` 判状态、只在需要时才复位（`qq-send-see` 就是这么写的），而不是每轮先一棍子
   * 打回初始态。无条件复位既多花一次输入，也掩盖了"我们其实不知道现在在哪"这件事。
   */
  | { kind: 'press'; key: 'Escape' | 'Enter' | 'Tab'; times?: number; expect?: DesktopStepExpect; else?: Else }
  /**
   * **清空此刻有焦点的输入框**（全选 + 删除；哪个修饰键归平台后端，recipe 不知道也不该知道）。
   *
   * 存在的理由：上一轮在「打正文」之后 abort（判据没兑现、用户按了中止），正文还躺在输入框里，
   * 微信这类应用会把它存成**草稿**；下一轮把新正文接在后面，回车一按两段一起发出去
   * （活体 2026-09-12：「三栏布局 0912t」留在框里，下一轮就会发成「…0912t…0912u」）。
   * 所以拿到输入框焦点之后、打正文之前，先清一次。
   *
   * **它不是"按组合键"的通道。** 组合键不放行的理由同 `press` 只认三个键：`Ctrl+A` 一开，
   * `Ctrl+W` / `Alt+F4` 就在同一条路上。这一步的语义窄到只有"清掉焦点框里的字"。
   * 收件人是此刻有焦点的东西，所以它一律抢屏、过前台闸门；`input:'message'` 那条路投不了
   * 组合键，agent 会直接拒——别在消息模式的 recipe 里用它。
   *
   * 焦点不在输入框上时它清的是别的东西（比如全选了一篇文章再删——只读的删不掉，可编辑的就
   * 没了），所以**前一步必须是拿焦点的那一步**，别把它挪到别处当无条件复位。
   */
  | { kind: 'clear'; expect?: DesktopStepExpect; else?: Else }
  /**
   * 停一下，等界面自己把结果画出来。
   *
   * **它是钝器，只在没有可等的特征时用**：搜索结果回来之前，界面上没有任何"就是它出现了"的
   * 新控件可以指（旧结果还在原地，只是内容会换）。这种时候固定等一段，比拿一个恒真的判据
   * 假装确认过要诚实。有明确特征可等的动作应该用 `invoke` 的 `expect`（轮询到出现为止），
   * 那条路快得多也稳得多——别拿 wait 去凑合它。
   */
  | { kind: 'wait'; ms: number }
  /**
   * **分支**：`when` 此刻成立就跳过接下来的 `skip` 步，不成立就什么都不做往下走。只评一次、在当前范围里评。
   *
   * 给"目标状态可能已经在了"的流程用：微信发消息，若当前会话就已经是他，搜索那一段不但多余，
   * 还会失败——会话已打开时候选弹层里未必再列他（用户实测）。于是开头看一眼会话标题，是他就直接
   * 跳到打正文；打正文那一步的 `require` 照样核对标题，分支不绕过任何闸。
   *
   * 为什么不用逐步的 `skipIf`：那几步里有一步的范围在弹层里（`window` 切过去之后），同一个判据在
   * 弹层里评出来的意思完全不同（弹层里那一行的名字也在"左栏以外"），而 `branch` 在切范围之前评一次、
   * 一跳到底，判据只属于一个窗口。
   *
   * `when` 的第二种形状是**按参数分支**（`DesktopParamCondition`）：不读屏、不问树，只看调用方给的
   * 参数。给"同一条流程、最后一发做不做由调用方定"用：`wechat-send` 的 `send:false` = 正文打进输入框、
   * 回车那一步跳过，run 以 `ok` 收场——它是正式能力，不是"跑到第 13 步按中止"那种调试器变通。
   * **只有这种分支允许跳到 recipe 末尾**（`skip` 正好吃掉剩下的全部步骤）：读屏的分支跳到末尾是
   * "什么都没做却 ok"，几乎必是写错；参数分支跳到末尾正是它的用途。
   */
  | {
      kind: 'branch'
      when: DesktopStepExpect | DesktopParamCondition
      skip: number
      /**
       * **这条分支成立 = 这一趟的结果没被验过**，理由写在这里（`image-no-caption`）。成立时 runner 把它
       * 记进回执的 `unverified[]`（`run_action_recipe` 的 `done` 也带）。
       *
       * 给"判据按参数分流、其中一路根本没有判据"的流程用：`wechat-send-file` 发图片——微信把图片挂进
       * 输入框时只画缩略图、没有文件名，文字判据恒不成立，只能跳过它、以「对话框已关」当弱判据。那一趟
       * 的 `ok` 和一趟真验过的 `ok` **在回执上必须分得开**，否则"没验"就长成了"验过了"（principles：
       * 「没验到」绝不算作通过）。只在参数分支上有意义；读屏的分支成立说明状态已经读到了，不是没验。
       */
      unverified?: string
    }
  /**
   * **喂一个已经弹出来的系统文件对话框**：等它出现 → 把 `path` 写进文件名框 → 确认 → 等它消失，
   * 范围与前台目标随后**自动换回**这一步之前的窗口。前一步（点「发送文件」图标、点「加载未打包」）
   * 负责把对话框弹出来；这一步只管对话框本身。
   *
   * 它收编的是此前每条要开文件对话框的 recipe 都得手抄的四步（`window` 等对话框 → `type` 填路径 →
   * `invoke` 点确认 → `window` 换回主窗），而且修掉了那四步里最脆的一格：**确认键不一定在控件树里**。
   * 活体（2026-09-18，微信 4.1.13 的「选择文件」IFileOpenDialog）：同一台机器两次抓树，一次有
   * `Button`「打开(O)」、一次没有（只剩两个 32px 的「打开」小箭头和「取消」）。可靠的确认方式是让
   * 文件名框拿焦点后按 Enter（活体验过：invoke 文件名框 + type "\n" 关掉对话框并挂载）。所以这里
   * 主路是 setValue + Enter，树里有确认键只当**备选**（Enter 之后对话框没关才点它）。
   *
   * `dialog`：对话框窗口怎么认。省略 = 按 agent 报的平台取默认：win32 是 `{process:<app 进程>,
   * titleAnyOf:['打开','选择文件','Open']}`（comdlg 默认标题「打开」，应用可以改，微信改成了「选择文件」）；
   * darwin 是 NSOpenPanel（mac agent 给无标题的 AXSheet / AXDialog 合成标题 `<无标题 AXSheet>`）。
   * 标题是包含匹配（同 `window`），`{param}` 照填。
   *
   * `timeoutMs`：等对话框**出现**的上界（默认 12s：第一次弹出实测要几秒，Windows 在枚举 shell 目录）。
   * `closeTimeoutMs`：确认之后等它**消失**的上界（默认 8s）。
   *
   * 四种失败在 `driftReason` 里各有前缀，别混：`pickFile/dialog-missing`（对话框没出现——多半是
   * 前一步没点中）、`pickFile/edit-missing`（对话框在、文件名框找不到——界面语言 / 版本）、
   * `pickFile/set-value-failed`（写不进去）、`pickFile/dialog-still-open`（确认了它没关——路径
   * 打不开、或弹了个错误框）。走通的一趟回执 `pickFile[label]` 记 `via`（`value+enter` /
   * `button` / darwin 的 `goto+enter`）与各段耗时。
   *
   * 它是动作步骤：要么给 `expect`（对话框关掉、范围换回之后在原窗口里验——"文件卡片出现在输入区"），
   * 要么给 `blind`。`expect` 的恒真预检也在原窗口里做，所以"上一轮的同名卡片还挂在输入框里"会被
   * 当场指出来，而不是当成这一趟挂成了。
   *
   * **macOS 那条路没有真机、按 AppKit 惯例写，全部待活体验证（2026-09-18 起）**：面板上敲 `/` 打开
   * 「前往文件夹」（`AXTextField id=PathTextField`）→ 写路径 → 回车 → 按 `AXButton id=OKButton`
   * 确认（找不到就再回车一次）。
   */
  | {
      kind: 'pickFile'
      /** 要选的文件的绝对路径（目标机器上认得的形状——`format:'path'` 参数经 `materializeParams` 翻译后的 `{path}`）。 */
      path: string
      dialog?: DesktopWindowMatch
      timeoutMs?: number
      closeTimeoutMs?: number
      expect?: DesktopStepExpect
      else?: Else
    }
  /**
   * 把后续步骤的搜索范围**换到另一个顶层窗口**，等它出现为止（`timeoutMs` 到了还没有 → drift）。
   *
   * **不换窗就够不着的东西是常态，不是特例**：原生的文件打开/保存对话框是 Chrome 主窗口的
   * owned window、`class=#32770`——它**不是** `recipe.app` 那棵树的后代（进程同不同都可能：
   * Chrome 的文件夹对话框实测就在 `chrome.exe` 自己里，所以别指望按进程名把它区分开）。
   * recipe 过去整趟只 scope 一次（`app`），于是任何一条要开文件对话框的桌面 recipe 都在
   * "找不到路径输入框"上原地打转，而失败的样子和"选择器写错了"一模一样。
   *
   * 等待是内建的：对话框第一次弹出**实测要几秒**（Windows 在枚举 shell 目录），点完立刻找
   * 必然空手。别用 `wait` 去凑这个时间——那是钝器，而这里有明确可等的特征（窗口出现）。
   *
   * `focus`：顺带把它抬到前台。要往里打字（键盘投给焦点窗口）或要坐标点击时才需要；
   * 纯 `invoke`/`setValue` 不需要前台，别顺手开——每一次抢屏都是从用户手里抢。
   */
  | {
      kind: 'window'
      match: DesktopWindowMatch
      timeoutMs?: number
      focus?: boolean
      /**
       * 换过去之后**再等这个控件出现**，等到了才算这一步做完。
       *
       * **窗口标题先变、界面后建**——这是 Chromium WebUI 的常态，也是一个非常贵的坑：
       * `chrome://extensions` 的标题在导航一开始就变成「扩展程序」，而页面里的按钮要晚
       * 若干百毫秒才进 a11y 树。只等标题的话，下一步查什么都是空，报出来的是「找不到
       * 开发者模式开关，可能是界面语言不对」——**一个把人带向错误方向的诊断**（语言没问题，
       * 是我们太快了）。实测 2026-08-31：同一条 recipe，Chrome 冷启时页面慢、能过；
       * 热的时候导航快、必挂。
       *
       * 别拿 `wait` 凑：那是钝器，而这里有明确可等的特征。挑一个**这个界面上恒在**的控件
       * （扩展页选「开发者模式」而不是「加载未打包」——后者只在开发者模式打开时才有）。
       */
      waitFor?: DesktopQuery
      /**
       * `optional`：窗口没等到（或等到了又在 scope 之前关掉了）就**跳过这一步**，范围留在原地，
       * 不判 drift。语义与 `invoke` 的 `optional` 一致。
       *
       * 它存在的理由是**"锦上添花的一段"必须整段可跳过**：一条 recipe 的成功判据往往落在前半段
       * （装扩展 = 中继连上了），后面那几步只是把图标钉到工具栏上。把那几段里的 `invoke` 标成
       * optional、却漏掉它们赖以立足的 `window`，等于留了一个能把整趟已经成功的流程判死的洞——
       * 而报出来的话还指着一件早就做完的事。**同一段里的步骤要么一起 optional，要么都不是。**
       */
      optional?: boolean
      /**
       * **这个窗口是属主主窗的「随主窗活着的弹层」**（owned popup），比如微信搜索的候选浮层。
       * 打开它：OCR 范围切到这个弹层（要在它里面找候选），但**抢前台的目标保持在主窗（`recipe.app`）
       * 不动**。
       *
       * 为什么要分开：这类弹层**主窗一失焦就自己关**。抢屏模式下点它里面的东西，引擎默认会先把
       * 被 scope 的那个窗口抬前台——而抬的就是弹层本身，一抬主窗失焦、弹层当场消失，点了个空
       * （微信搜索候选，本机 2026-09-12 连撞三轮）。弹层是 owned window、天生画在属主之上（topmost），
       * 所以只要主窗还在前台，坐标点击落在弹层的屏幕像素上照样中——foreground 该抬的是主窗，不是它。
       *
       * 只对**随主窗活着、不该被单独抬前台**的弹层置真。独立的模态对话框（文件选择框那种、自己
       * 就该拿焦点）不要置真——那种就是要 `focus` 抬它自己。置真后这一段结束、`window` 换回主窗时，
       * 前台目标自动跟着回到那个新 scope。
       */
      ownedPopup?: boolean
    }

/** Session classification from two positive signals (parallel to browser LoginCheck). */
export interface DesktopLoginCheck {
  /** a control present ONLY when authenticated */
  loggedIn: A11yQuery
  /** a control present ONLY when a login / verify screen is up */
  wall: A11yQuery
}

/**
 * 从 observer 读到的字段里**再抽一层**：`目标字段 → { from: 源字段, match: 正则 }`，
 * 取第一个捕获组（没有捕获组就取整个匹配）。匹配不上就**不设**这个字段——绝不写空串，
 * 那会把"没抽到"伪装成"抽到了一个空值"。
 *
 * **为什么这一层非有不可**：a11y 树能给的只有控件的 `name`，而一条 Telegram 消息的 name 是
 * 整段正文挤成的一坨。Stream 的 item 却要 `title`/`link` 这些顶层字段——**前端各处显示的是
 * 顶层 `item.title`**，normalizer 里再怎么清洗都白清洗（这条教训写在 `packages/alist/normalizer.ts`）。
 * 没有这一层，任何 `kind:'desktop'` 源进到收件箱都只能是一排 `(untitled)`。
 *
 * 它是 `kind:'desktop'` 的共性缺口，不是某个源的特例：**桌面自动化天然只能读到一整句文本**。
 * 抽取规则写在 recipe 里（一处定义、随包分发），而不是散在 normalizer 或 adapter 里。
 *
 * 抽出来的字段与 observer 的字段合并；`read.dedupeBy` 也能指向抽出来的字段——比按整段正文
 * 去重稳得多（正文里带浏览数、"已编辑"这类每次都在变的尾巴）。
 */
export type DesktopMap = Record<string, { from: string; match: string }>

/** Dedupe + stop rule over the observer's items. */
export interface DesktopRead {
  /** which item field holds the stable per-item id used for dedupe */
  dedupeBy: string
  /** stop once this many DEDUPED items are collected */
  targetCount: number
  /** OPTIONAL paging: scroll + re-read until targetCount, no fresh items, or maxTicks.
   *  Absent → a single read of the currently-loaded subtree (the verified first cut). */
  scroll?: { dir: 'up' | 'down'; amount: number; maxTicks: number }
}

export function isDesktopRecipe(recipe: { kind: string }): recipe is DesktopRecipe {
  return recipe.kind === 'desktop'
}
