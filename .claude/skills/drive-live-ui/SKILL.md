| `cdp_shot` | 截图。**截的是那个窗口本身，不是屏幕**——被遮、在后台都照样截回窗口真容（Windows `PrintWindow` / mac `CGWindowListCreateImage` 按窗口 id 截）；**锁屏只有 Windows 照截，mac 锁屏下是纯色图、会报 `blank-capture`**。只有这条路失败才落回抓屏 |---
name: drive-live-ui
description: 想「看一眼此刻活着的界面、必要时动它一下」时读它——网页和**原生窗口**都算。一个统一入口、四个动词（`cdp_look` / `cdp_shot` / `cdp_act` / `cdp_pages`），都吃同一个 `target` 字符串选面：`target:'chrome'`(+`url`) 随手看任意 URL；`'chrome:<tabId>'` 读一个已开着的 tab；`'facility:<name>'` 看某 facility 正在采集的那一页；**`'desktop'` / `'app:<进程>[/<标题>]'` 看/动一个原生窗口**（浏览器够不到的 `chrome://*` 特权页、桌面客户端、系统设置）。别自己起 Edge/Chrome（扩展会拒非自有 tab）：网页那几档全都落在**用户自己那个 Chrome** 里，那是唯一有登录态的浏览器；原生窗口那两档走 Stream Desktop + a11y 树。**最贵的一条经验：读得到不等于点得动**——UIA 对后台标签照样有 a11y 树、锁屏时读照常成功、原生 invoke 也照常，只有坐标输入被拒；判据只有 `cdp_act` 带 `expect` 回来说 confirmed。
---

# 看/动此刻活着的界面（drive a live UI）

**本 skill 讲的是「看一眼，必要时动一下」**，不产出任何持久物（不建 Recipe、不入 feed item）。**判路 / 接入源 / 写 recipe 都不在这里**——那是 `onboard-source` / `write-recipe` 的事。这里只回答"这个页面现在是什么样"。

> 注意：「本 skill 只讲看」是**范围**，不是能力边界——`cdp_act` 能真点击、真打字、真滚轮，带高危确认门。
> 动手怎么用写在 `write-recipe`（采集侧）和工具自身的描述里。这里不讲，是因为看和动是两件事。

**先分诊：要在某个应用里「做一件事」（发消息、下单、填表）→ 先查 `packages/<app>/*.recipe.json`
有没有现成的 action recipe。** 有就别拿本 skill 手抠坐标：整条跑用 `run_action_recipe`；要**中途停**
（比如把正文打进输入框但不发）用 `recipe_debug_start` → `recipe_debug_next` 放行到目标步 → 在下一步
之前 `recipe_debug_abort`。只有**没有 recipe** 时才用本 skill 手动驱动，而且驱动通了就该沉淀成 recipe。
撞过的坑（2026-09-18）：本 skill 下面那段微信手工路径写得太像操作指南，读者照着截图量坐标去了，
而 `packages/wechat/wechat-send.recipe.json` 早就把整条路（含「打正文先不发」那一步）跑通了。

## 一个统一入口，四个动词，一个地址参数

只有一套工具，全部吃同一个 `target` 字符串来选"看/动哪一页"：

| 工具 | 作用 |
|---|---|
| `cdp_look({ target, js?, url?, interactive?, inventory?, frame? })` | 跑一段 JS，把值拿回来（`{value}`，必须 JSON 可序列化）；或 `inventory:true` 直接要一份带编号的可交互元素清单（跨 iframe，见下）；`frame` 让 `js` 跑在某个 iframe 里 |
| `cdp_shot({ target })` | 截图（`{shot}`，base64 JPEG）；chrome 标签截不到帧时自动改截那扇 Chrome 窗（见下） |
| `cdp_act({ target, kind, domain, ... })` | 真点击/打字/滚轮/跳转（可信输入，带高危确认门）；点开了新标签会在回执 `opened` 里说 |
| `cdp_pages({ target, close? })` | 列出（chrome 下可 close）该 target 下能寻址的 tab |

`target` 的取值按你要看的意图选：

| 你要看的 | `target` | 什么时候 |
|---|---|---|
| **任意一个 URL**（在你自己登录着的 Chrome 里随手打开） | `'chrome'` + `url`（`cdp_look`）或 `'chrome'` + `kind:'open'`（`cdp_act`，只开不读，见下）；其余动词只认已存在的 tab | 一次性侦察、量设计稿、"这站登录了吗 / 这个选择器在不在"。随手开、随手关，**和采集完全无关**、也不绑定任何 facility。 |
| **一个已经开着的 Chrome tab** | `'chrome:<tabId>'`（先用 `cdp_pages({target:'chrome'})` 认出 tabId） | 继续对一个刚才 `interactive:true` 开出来、或早就存在的 tab 动手/再看一眼。 |
| **某个 facility 正在采集的那一页** | `'facility:<name>'` | 调**正在跑的采集**：账本和 DOM 为什么对不齐、`__INITIAL_STATE__` 里首屏那批到底长什么样、locate 看到的卡片是哪些。 |
| **一个原生窗口**（不是网页） | `'desktop'`（当前最前面那个）或 `'app:<进程>[/<标题>]'` | 浏览器够不到的界面：`chrome://*` 这类特权页、桌面客户端（Telegram/夸克）、系统设置。走 Stream Desktop + a11y 树，不是 CDP。 |

> `facility:<name>` 一度写作 `cloak:<name>`（那时 facility 的采集 tab 开在 Stream 自带的 CloakBrowser 里）。那个浏览器已经退役，**这个别名也一并摘掉了**——现在写 `cloak:` 会以 `unknown target scheme 'cloak'` 报错。见到旧写法就改。

**网页那几档，同一个浏览器。** 采集不再有"骑哪个浏览器"这回事：Stream 自己不带浏览器，`chrome` 和 `facility:` 打的都是**用户自己那个 Chrome**，经扩展 relay。区别只在**指哪个 tab**：`chrome` 是你随手开的，`facility:<name>` 是采集正骑着的那个。后者经 `Transport.evaluate` / `Transport.screenshot` 走，排在该 facility 的任务尾链之后，不会和正在跑的 recipe 交错——细节在 `write-recipe`。

**为什么 `chrome` 仍是独立一档**：量个 YouTube 设计稿这种事根本没有 facility 可谈，它也不该去碰采集那个 tab。反过来，想调某个 facility 的采集就得用 `facility:<name>`——别用 `target:'chrome'` 另开一次那个站。登录态是同一份（同一个浏览器），但**页面状态不是**：采集那个 tab 的滚动位置、账本对应的那批卡片、中途的 DOM，新开一个 tab 全都看不到。而且对单会话站点，另开一个会话可能把采集那个踢下线。

### 先要清单，别一上来手写 querySelector：`inventory` + `ref`

**不知道页面上有什么就问一次清单**，别靠猜选择器试探——那是一轮一个 `cdp_look`，而且猜空了还分不出是"选择器写错了"还是"元素真不在"。

```js
cdp_look({ target: 'chrome:42', inventory: true })
// → { url, title, count, truncated, items: [{ n, tag, role?, name, value?, href?, rect:{x,y,w,h}, frame? }, ...], frames? }
cdp_act({ target: 'chrome:42', kind: 'click', domain: 'x.com', ref: 7, expect: '#panel' })
```

一次调用扫出页面上**所有可见的能点能填的元素**（a/button/input/select/textarea/`role=button|link|tab|menuitem|checkbox|radio|combobox|option`/`contenteditable`/`onclick`/summary），逐个编号。`ref:<n>` 是把编号喂回去，等价于 `selector: '[data-stream-el="<n>"]'`。

**清单跨 iframe，跨源的也算**（见下「iframe」一节）：iframe 里的条目带 `frame`（frame id），`rect` 已换算成顶层页面坐标；页面不止一个 frame 时多一格 `frames: [{id,url,oopif,count|error}]`。编号**全标签唯一**，所以 `ref` 不用管它在哪个 frame——会自己找过去点。

几条判据：

- **`inventory` 和 `js` 二选一**，同给报错——`inventory` 本身就是预制的清点，不是 `js` 的修饰符。`inventory` 也不配 `frame`（它本来就跨全部 frame）。
- **编号是会话级脚手架**：打在元素上的 `data-stream-el` 属性 + 每份文档 `<html>` 上的 `data-stream-seq` 计数，**页面一刷新全作废**。同一页重复要清单编号不变（已有属性沿用），只有新出现的元素拿新号。
- **绝不把编号写进 recipe。** recipe 要能重放，而 `[data-stream-el="7"]` 下一次什么都指不到。清单是**侦察工具**：用它认出元素，然后自己落一个稳定选择器。
- **`ref` 只在 chrome 档有效**，`facility:` 给 `ref` 直接报错——采集页不开放按编号动作。
- **上限 200 条**，超了回 `truncated:true`：先把页面收窄（滚到位、展开那一块）再要一次，别指望它给全。
- **原生窗口档（`desktop`/`app:`）不适用**，给了 `inventory` 报错：那一档的 `js` 本来就是 a11y query，返回的每一条都是一个可寻址元素——**它本身就是清单**。

---

## `target:'chrome'`（+`url`）／`target:'chrome:<tabId>'`——用户自己的 Chrome

一个通用原语：在用户**自己登录着的 Chrome** 里跑 JS，把值拿回来。它和采集链路共用 ext-cdp transport，但是**兄弟、不是其中一环**——`cdp_look`/`cdp_shot` 只读，什么都不产出；`cdp_act` 能动手，见下方高危确认门。

`cdp_look({ target: 'chrome', url, js, interactive })` — 在用户真实 Chrome 里打开 `url`（带其 cookies/登录态）、eval `js`（表达式或 async IIFE —— `awaitPromise` + `returnByValue`），把值拿回来。返回值**必须 JSON-serializable**。

**`interactive` 决定这个 tab 是谁的、以及谁来关它**——这是两条不同的用法，别混：

| | `interactive` 省略/false（默认） | `interactive: true` |
|---|---|---|
| tab | 后台静默探针，没人看 | 前台打开、进**可见的会话标签组** |
| 关闭 | 值一读到就自动关（本 skill「看一眼」的常态） | **不关**，返回 `{value, target:'chrome:<tabId>', kept:true}` |
| 之后 | 没有之后 | `target` 字段直接就是一个可用的 `chrome:<tabId>` 地址：拿它继续 `cdp_look`/`cdp_shot`/`cdp_act`；用 `cdp_pages({target:'chrome'})` 认 tab、`cdp_pages({target:'chrome', close:<tabId>})` 一轮走完再关；用户也可以自己手动关 |

「看一眼」用默认档就对了——开、读、关，一次性。只有当**需要用户看着你操作**、或页面内容只在前台聚焦 tab 里才渲染（YouTube 这类虚拟化 feed）、或你打算继续对这页动手时，才用 `interactive: true`。

要读一个**已经开着**的 tab（不带 `url`）：`cdp_look({ target: 'chrome:<tabId>', js })`——tabId 从 `cdp_pages({ target: 'chrome' })` 拿。

### 点一下开了新标签：看回执的 `opened`，别盯着旧标签

页面用 `window.open` / `target=_blank` 开出新标签时，内容多半是在**新标签**里继续的——接着读旧标签只会得出
"点了没反应"。两处都会告诉你：

- **`cdp_act` 的回执**：click / submit 开出新标签就多一格 `opened: [{tabId, url, target:'chrome:<tabId>'}]`，
  拿 `target` 直接接着 `cdp_look` / `cdp_act`。没开新标签的点击（又没带 `expect` 或 `expect` 没等到）要多等
  约 0.5s 才返回——那是在等新标签露面。
- **`cdp_pages({target:'chrome'})`**：新标签带着 `openerTabId`（谁开的它）出现在列表里。

**只认 Stream 自己开的标签开出来的**（出身 `created`/`probe`）：判据是浏览器记的 opener，页面伪造不了；
这类新标签自动进会话组（同一扇窗进开启者那个组，另一扇普通窗在那扇窗里另建一组，popup 窗放不了组就记成
`popup:true`、照样可驱动），出身随开启者、可 `close`。**用户拖进来的标签（`adopted`）开出来的不收**——那是他
自己的页面，替他收进组等于替他做了"拖入 = 授权"；要驱动它，让用户把新标签拖进 Stream 组。

### iframe：清单与 `ref` 自动跨过去；手写的 `js` / `selector` 要给 `frame`

`js` 和 `selector` 默认只作用在**顶层文档**。iframe 里的东西（例：微信小程序后台的「游戏设置」面板是
`gamemp.weixin.qq.com` 的 iframe，套在 `mp.weixin.qq.com` 里）照下面走：

```
cdp_look({ target:'chrome:42', inventory:true })            # 条目带 frame；frames 列出全部 frame
cdp_act({ target:'chrome:42', kind:'click', domain:'mp.weixin.qq.com', ref:31 })   # ref 自己找到 frame
cdp_look({ target:'chrome:42', frame:'gamemp', js:'document.body.innerText.slice(0,500)' })
cdp_act({ target:'chrome:42', kind:'click', domain:'mp.weixin.qq.com', frame:'gamemp', selector:'#save', expect:'.toast' })
```

- `frame` 吃 frame id（清单里给的），或 frame URL 的一段（包含匹配，**必须恰好命中一个**，多了报错列候选）。
- `domain` 永远是**标签地址栏上那个**站（顶层），不是 iframe 的——域名复核看的是整张标签。
- 同站 iframe（`a.qq.com` 里嵌 `b.qq.com`，同一个渲染进程）里的 `js` 跑在**隔离世界**：DOM 能读能改，页面
  自己的 JS 全局变量（`window.__APP__`）看不见。跨站 iframe（另一个进程）和顶层一样跑在页面主世界。
- `goto` / `setFiles` 不收 `frame`（导航作用在整张标签；文件输入那条走的 CDP 查询不穿 iframe）。
- 机制（为什么两种 iframe 路不同、点击坐标怎么换算）在 `shared/browser-relay/frames.ts` 头注；跨站那种要扩展
  开 `Target.setAutoAttach`，扩展太旧时只够得到同站 iframe（`frames` 里跨站那个会带 `error`）。

### 截图截不到帧：自动改截那扇窗

Chrome 窗口被盖住 / 最小化 / 锁屏时合成器不出帧，页面截图（`Page.captureScreenshot`）拿不到图。这时
`cdp_shot({target:'chrome:<tabId>'})` 会**自动改走原生窗口档**截那扇 Chrome 窗（被盖住照样截得到），回执
`{shot, via:'window', target:'app:chrome.exe/<窗口标题>', note}`。

- 那是**整扇窗**（标签栏 + 地址栏，物理像素），不是页面视口——**别拿图上的坐标去点页面**。
- 只在这张标签是它那扇窗的**当前标签**时才回落（窗口截图只照得到当前标签；截到别的标签比截不到糟）；
  按标题认窗口必须恰好认出一扇。不满足、或 Stream Desktop 没连，就报错并写明该调什么（`cdp_shot({target:'app:chrome.exe/<标题>'})`）。

### `kind:'open'`——只开一张标签，不读它（chrome 档唯一不要 tabId 的动作）

```
cdp_act({ target:'chrome', kind:'open', domain:'<hostname>', targetUrl:'<url>' })
→ { status:'done', result:{ tabId, title, url, created } }
```

**find-or-open**：同一页已经开着（尾斜杠不计、scheme/host 大小写不敏感，query/hash 照算）就
激活它并抬窗（`created:false`），没有才新建。它是这一档唯一**不要 tabId** 的动作——tabId 正是
它的产出，要 tabId 就成了先有鸡后有蛋。它也**不过高危确认门**：开一张新标签和
`cdp_look({target:'chrome', url})` 同级，而后者从来不设门；`goto` 的跨站门管的是"把一个**已有**
tab 劫持到别的站"，那是另一件事。（`domain` 这条路用不上，随手传目标的 hostname 即可。）

**要一直跑着的页面（游戏、动画、要截图的渲染页）加 `ownWindow:true`**：开进一扇**自己的、不抢焦点的
窗口**（标签栏上是一个叫「Stream 独立窗」的组），照样可驱动，之后再喊同一个网址只回那张、不切不抬。
为什么：后台标签 `visibilityState=hidden`、rAF 0 帧——跟用户挤在一扇窗里，用户一切标签它就停，
而把它切回来会连窗口一起抬到用户眼前。**别用"切回来 + 抬窗"去救一个不出帧的页面**，给它单开一扇窗。
窗口被别的程序盖住也要出帧，还得 Chrome 关掉遮挡检测（chrome://flags 的 Calculate window
occlusion on Windows = Disabled，或启动参数 `--disable-features=CalculateNativeWinOcclusion`）。
判据用页内 1 秒 rAF 计数，别用 `visibilityState` 立刻读。

**它不挂 debugger、不注入脚本**——好处是 `chrome://*` 这类**特权页开得了**。
`cdp_look({target:'chrome', url})` 是「开 + attach + eval」焊死的一件事，对特权页会在 attach
那步炸掉，而 tab 已经建出来了，留下一个没人管的空窗口。

代价：**特权页开出来也驱动不了**。别拿 `chrome://*` 的回执 `tabId` 去 `cdp_look`/`cdp_act`
（`chrome:<tabId>` 要 attach，照样炸 `Cannot access a chrome:// URL`）——走下面的原生档。
普通 http(s) 页没这个限制，回执的 `tabId` 直接能驱动。

**它新建的标签进 Stream 会话组**（`created:false` 那种、用户自己早开着的不动——只是切过去）。
判据是"这张标签是不是 Stream 开的"，不是"它可不可被驱动"：凡是 Stream 开出来的页，用户都该在
标签栏的 Stream 组里看见它、能一把拖出去撤销、能一键关掉。

**回执里的 `title` 就是通往原生档的桥**（Chrome 窗口标题 = 「<页面标题> - Google Chrome」，而
`app:` 是包含匹配）。活体（2026-08-02）一发命中：

```
cdp_act({ target:'chrome', kind:'open', domain:'chrome', targetUrl:'chrome://version' })
                                                    # → { tabId, title:'关于版本', created:true }
cdp_look({ target:'app:chrome.exe/关于版本', js:'{"role":"Text"}' })
                                                    # 特权页的内容，经 a11y 读到
cdp_act({ target:'app:chrome.exe/关于版本', kind:'click', domain:'chrome',
          selector:'{"role":"Button","name":"复制"}', expect:'...' })
```

页面 ~2s 内还没给出标题时 `title` 回空串（字段一定在）——那就 `cdp_pages({target:'desktop'})`
认窗口，别拿空串去拼 `app:` 地址。

### `kind:'setFiles'`——把本地文件放进页面的 `<input type=file>`（不经 URL、不起静态服务）

```
cdp_act({ target:'chrome:<tabId>', kind:'setFiles', domain:'<hostname>',
          selector:'body > input[type=file]',
          paths:['C:\\Users\\Jagger\\Pictures\\x.psd'] })
// → { status:'done', result:[ { name:'x.psd', type:'', size:23464703 } ] }
```

底层是 CDP `DOM.setFileInputFiles`：页面收到的 `change` 和用户在文件对话框里选中一模一样，
它自己去 `input.files` 读内容。**只对 `chrome:<tabId>`**（desktop 档没有这个概念）。

- **路径按浏览器所在机器解释。** 扩展跑在用户的 Chrome 里；Chrome 在 Windows 上就写 `C:\...`，
  **WSL 的 `/mnt/c/...` 要先转成 `C:\...`**（`wslpath -w`）。
- **CDP 不核路径存不存在**：不存在的路径它照样接受，页面收到一个 0 字节的 File、`change` 照发
  （2026-09-20 活体）。所以 `result` 里的 `size` 才是判据——driver 见全是 0 字节直接抛
  「浏览器没读到文件内容」，别把它当成功。
- `result` 是页面**在 change 那一刻**看到的 files（driver 先挂一个 capture 监听抄下来）：很多站读完
  就把 `input.value` 清空，事后再读只剩空数组。
- 三种失败各报各的：选择器没命中 / 命中的不是 `<input type=file>` / 多个文件放进非 `multiple`；
  CDP 拒绝时原文带回。元素在 shadow root / iframe 里时页内 `querySelector` 命中而 CDP 的
  `DOM.querySelector` 不命中——报的就是这句，换一个顶层选择器。
- 大小没上限（Chrome 直接读本地文件，不过 relay）：23MB 的 PSD 一次过。
- 过高危门时它和 `type` 同级（低危、未提交）：页面拿到的是本机文件内容，**它下一步会不会传到站外
  是页面的事**——知道会传的调用方声明 `intent:'publish'`/`'send'`，让门在这里就响。

**例：让 Photopea 打开一份本地 PSD**——它的 `文件 → 打开` 走一个常驻的隐藏
`<input type=file multiple>`，直接挂在 `body` 下（选择器 `body > input[type=file]`），
不用先点菜单；放进去它立刻开成一个新文档（读完就清空 input，所以要看 `result` 不要事后读
`el.files`）。`cdp_look` 读不到 Photopea 内部状态（`app` 不是全局），确认用 DOM 里的图层名 /
文档标签文字，或 `cdp_shot` 看图层面板。

### 禁令：别从 shell/bash 起 GUI 程序

**这条链路上不许 `bash chrome.exe ...` / 从 shell 拉起任何 GUI 程序。** 没有回执的动作不该存在：
shell 只知道"进程退了"，起没起来、起出了哪个窗口、是不是复用了已有实例全都不可知，失败也不可知
（真造成过两个孤儿空白窗口，没有任何一步能发现）。替代是同一个动词的两副面孔，都带回执：

| 要干的 | 怎么调 | 回执 |
|---|---|---|
| **打开页面** | `cdp_act({target:'chrome', kind:'open', domain, targetUrl})` | `{tabId,title,url,created}` |
| **唤起应用** | `cdp_act({target:'app:<进程>', kind:'open', domain:'desktop', exe, args:[]})` | `{running,started,pid,process,window?}` |

唤起那条 = `ensureApp`：**在跑就什么都不做**，不在跑才拉起来，而 `running`/`started` 是回读出来的
事实（不是"我发过启动命令"）。`window` 只在**恰好能归因到一个新窗口**时才有——零个或多个都不带，
指错一个比不给更坏；有它就直接拼 `app:<进程>/<标题>`，不用猜标题。

```
cdp_act({ target:'app:Telegram.exe', kind:'open', domain:'desktop',
          exe:'C:\\Users\\<你>\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe', args:[] })
```

**开 Chrome 以外的任何应用，`exe` 和 `args:[]` 两个都得给**，这不是可选的讲究：省略 `exe` 时
agent 会按常见安装位置去找 **Chrome**（`ensureApp` 的原始用途就是唤醒用户的浏览器），于是你
"开 Telegram"开出一个浏览器；而默认 `args` 是 Chrome 专属的 `--no-startup-window`，喂给别的
应用轻则被当成待打开的文件名、重则拒绝启动。

**它不抢屏**（Z 序 / 焦点 / 最小化状态一律不动），也**不过高危确认门**——理由同 chrome 的
`kind:'open'`：让一个进程活着不改变任何已有窗口。要把它拿到前面来是下一步的事。
`target` 必须指名到进程（`app:Telegram.exe`），**不能写 `desktop`**：要开的那个按定义还没有
窗口，拿"当前前台窗口"当目标只会去确保已经在最前面的那个应用还活着——一个永远成功的空动作。

**这四个动词只有一个提供方：Stream 后端。** chrome 这一档的实现住 **`shared/browser-relay/cdp-chrome.ts`**（`chromeLookVerb`/`chromeShotVerb`/`chromeActVerb`/`chromePagesVerb` + `expandRef`/`resolveLookJs`；iframe 那一套在同目录 `frames.ts`），描述文本与参数 schema 也共享在 `shared/browser-relay/tool-specs.ts`（按宿主支持的档位集生成，chrome-only 的宿主不会看到 `facility:`/`desktop` 的字样，`tool-specs.test.ts` 钉着这条）：

- **Stream 后端**（三档齐全）：`bootstrap.ts` (`extLauncher = makeExtensionLauncher(extRelay)`, returned) → `mcp/mcp-extras.ts`（`cdpLook`/`cdpShot`/`cdpAct`/`cdpPages`）→ `mcp/cdp-router.ts` 的 `makeCdpRouter`（chrome scheme 委派给上面那份共享实现，`facility:`/`desktop` 两档留在 `src/mcp/`）→ `mcp/tool-catalog.ts`（`cdp_look`/`cdp_shot`/`cdp_act`/`cdp_pages` 四个工具，描述文本传 `ALL_CDP_TIERS`）→ `mcp/server.ts`。Same tier/auth as every other stream MCP tool (`/api/mcp`, gated by `/api/*` — no bearer unless `api_token` is set).
**电脑操作叫 Stream Desktop，是内置能力，装了 Stream 就有**——不用也不能单独装
（`capabilities/desktop/`，`private: true`，随后端 bundle 出货）。宿主那边只配一行，指向 Stream：

```bash
claude mcp add stream -- stream mcp    # Codex 是 config.toml 的 mcp_servers 一行
```

`capabilities/desktop/` 里今天只剩桌面那一半（`src/host-agent/`：解 exe、养进程、
`--register`）与两样共享常量；中继、`cdp_*`、`/api/ext/verify` 全在后端主路。哪些东西归哪边，
见那个包 README 里的对账表。

### 握不住手时，分三件事看

这三件是**三种不同的病**，混在一起看只会来回猜。判据只有一个，别看 Chrome 里的扩展图标：

```bash
curl -s 127.0.0.1:8900/api/browser-capability    # → {"state":"ready","connected":true,…}
```

`never-seen` = 从没连上过（还没装，或装在了另一个 Chrome 上）；`disconnected` = 装过、现在没连
（点一下扩展图标叫醒它）。**端口 listen 成功不算数**——中继起来了而扩展一个候选都不问，是最常见
的那一种。`ready` 拿不到就按下面三件逐个查：

1. **token 铸在哪个文件里**（`<dataDir>/ext-relay-token`）；
2. **本机的归属指针现在指着谁**（`~/.stream/datadir` 的**内容**）；
3. **中继在哪个口听着**。

三件都对而扩展仍然不来，才轮到"Chrome 需要重启"（它只在启动时读 native messaging 清单）。

**登记与拉起它的只有 Stream 后端一家**（`src/host-agent/mount.ts` 把 Stream Desktop 当成一件内置
能力挂上）。后端启动日志里那行 `[stream-desktop] host-agent → <路径>` 就是登记成功；
`STREAM_NO_DESKTOP=1` 是显式关掉它的开关（用在同一台机器上已有别的宿主在养 agent 时——两个
agent 抢同一条 `/api/host` 只会互相踢）。

**对外的名字全是 `desktop`**：exe `stream-desktop`、native messaging host id `com.stream.desktop`、
平台包 `@streamapp/desktop-<平台>`、开关 `STREAM_NO_DESKTOP`。这几个是**线上常量**（写进配对过的
机器上的浏览器清单与注册表），改一个就得让每台机器重新 `--register`，不重配是静默失联。
**只有目录名还是旧词**（`app/host-agent/`、`src/host-agent/`、`capabilities/desktop/src/host-agent/`）
以及 debug bus 的 `host-agent` 频道——纯内部，没跟着改。

**`--register` 报告里那行 `datadir pointer → <data 目录>（归属；写在 <指针文件>）`，第一个值就是
归属**——它是刚写进指针的那个 data 目录，也就是"扩展将拿到谁的 token"。括号里那个
`~/.stream/datadir` 只是指针文件自己的路径，**任何机器上都长一个样**，读它等于什么都没读。
所以：读第一个值，别读括号。（要另行核实就 `Get-Content ~\.stream\datadir`，内容应当与第一个值
逐字符相同。）

同理，**"扩展连上了"之后还得能回答"它连的是谁"**：指针和 native messaging 登记都只有一份，
两者都是**后写者赢、且不吭声**。所以一台机器上起第二份后端（换了 `STREAM_DATA_DIR` 的冒烟那种）
会把指针和登记改成自己的，原来那份的手就不在自己这儿了——症状是原后端一切正常、只是扩展再也
不来。**冒烟别忘了带 `STREAM_NO_DESKTOP=1`**，除非你本来就是要验配对。

要单独证明"那个 exe 在这台机器上能跑"，用 `capabilities/desktop/scripts/provision/ping-agent.mjs`
（native messaging 的 `ping` 只回一个编译进去的版本号、**不碰文件系统**，所以它把「二进制能不能跑」
和「指针指着谁」分得开）。

### 要在一台机器上自动装扩展 → 只能是 Chrome for Testing

品牌版 Chrome 自 **137 起移除了 `--load-extension`**，装未打包扩展只剩 GUI 一条路（开发者模式 →
加载未打包）。所以：

- **给真实用户的路只有 GUI 那条**，绕不开——自动化能替他点，但那是 UIA 驱动
  （`app:chrome.exe/<标题>`，`chrome://extensions` 是特权页，CDP 碰不了），不是命令行开关。
- **在测试机上全自动跑通配对，用 Chrome for Testing**（保留了 `--load-extension`，配对链不依赖
  登录态）。它找 native messaging host 时读 **`HKCU\Software\Google\Chrome\NativeMessagingHosts`
  与 `HKCU\Software\Chromium\NativeMessagingHosts`，两者任一在场就够**；**不读**
  `Software\Microsoft\Edge` 那份，也**不读**它自己那个 `Software\Google\Chrome for Testing` 根。
  单键实测（2026-09-01，CfT 152.0.7977.64，每轮都是干净 profile + 先杀掉上一轮的
  chrome/host-agent）：只留 Chrome 键 → 连上；只留 Chromium 键 → 连上（复现两次）；只留 Edge 键
  → 45s 无连接；三个都删 → 45s 无连接；三个键都在、只把清单 JSON 挪走 → 也连不上（所以那三个
  键指向的清单文件才是真正被读的东西）。**每轮之间必须把上一轮的 chrome 杀干净**：中继口不变，
  上一轮那个扩展会连到新中继上，于是本该红的一档变绿——判据是"连上的时刻距本轮 chrome 启动
  有几秒"，秒级之内出现的连接就是上一轮的残影。别手工往「Chrome for Testing」根下面造键——
  那是个没人读的地方，写进去失败得很安静。
- **headless 不影响 native messaging**（它只是 spawn 一个子进程，不需要交互桌面）。整条配对链
  没有任何一步要看得见的窗口，别为此去挂计划任务。

备机怎么备齐、每一步的判据是什么：`capabilities/desktop/scripts/provision-win-test.md`。

## Preconditions (check these first when it errors)

1. **Backend up**：`curl -s 127.0.0.1:8900/api/health` → `{"ok":true}`。宿主上只有 `8900` 这一个口，**就是后端自己绑的**（后端原生跑在宿主上，前面没有代理；`4555` 只在自托管容器档里有意义，别拿它当判据）。没起就把它起起来：源码检出是 `pnpm dev`，npm 装的是 `stream`。
2. **Extension awake + connected.** After any backend restart the MV3 service worker goes idle and drops the WS; the user must **click the extension icon once** to wake it (its popup queries relay-status, which triggers reconnect). Error `ext-relay socket disconnected` = not connected → ask the user to wake it. `harvest_capability`（MCP，无参数）分得清是哪一种：`state:'disconnected'` = 装过、现在没连（叫醒它就行），`'never-seen'` = 从没连上过——那就不是叫醒的事，得先装；它同时给出 `chrome` 候选，说明该装在哪一侧（WSL 侧的 Chrome 装了也白装：采集全程游客态，什么都不报错，就是采不到）。

## How to write the `js` (the pattern that works)

```js
(async () => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  await s(2500);                                  // short settle — NOT a long poll (see timeout gotcha)
  const el = document.querySelector('#target') || document.querySelector('.fallback');
  if (!el) return { error: 'no el', tags: [...document.querySelectorAll('*')].map(e=>e.tagName).slice(0,8) };
  const c = getComputedStyle(el), r = el.getBoundingClientRect();
  return { fontSize: c.fontSize, lineHeight: c.lineHeight, color: c.color, y: Math.round(r.top), h: Math.round(r.height) };
})()
```

- **Multiple candidate selectors** per field, and a **debug dump on miss** (return nearby tag names) so one round-trip teaches you the real DOM instead of failing blind.
- Read radius/rounding from the **wrapper**, not the `<img>` — sites clip the container (e.g. YouTube thumb radius is 12px on the wrapper, 0 on the img).

## Gotchas (each hit live, all real)

- **`interactive: true` for virtualized feeds.** YouTube's grid (and similar) only lazy-render in a *focused foreground window*; a background tab measures empty cells. Pass `interactive:true` to get a real window.
- **SPA-hydration timeout.** A long in-page poll loop can span a framework context swap → the eval's promise dies → the relay's **30s `Runtime.evaluate` cap** fires (`ext-relay command timed out`). Keep total in-page time short: a fixed `await sleep(2500)`, or ≤ ~18 × 400ms, not a 40-iteration wait.
- **`data/ext-relay-token` EACCES on backend start.** If a prior docker/caged run left it `root:root 600`, a native `jagger` backend crashes reading it. `data/` is `777` → `mv data/ext-relay-token data/ext-relay-token.rootbak`; `loadOrCreateExtToken` regenerates it as `jagger`, and the extension re-fetches the new token via `/api/ext/token` on reconnect.
- **测「带声播放 / 全屏 / 剪贴板」这类要用户手势的能力,必须用 `cdp_act`(真点击),别用 `cdp_look` 里的 JS `element.click()`。** 浏览器只对 `isTrusted:true` 的真实输入授予 user-activation(瞬时,约 5s);JS 合成的 `.click()` 是 `isTrusted:false`,**触发得了 React 的 onClick(它不看 isTrusted)、却拿不到激活**。于是极具迷惑性:播放 UI 正常出现、`video.play()` 照调,但带声播放被 `NotAllowedError` 挡下,**video 假卡在 `readyState:0`**——看起来像"播放器巨慢/有 bug",其实是测法错了。`cdp_act` 走 CDP `Input.dispatchMouseEvent` 可信注入,浏览器当真手势 → 放行。判据:活体 video 卡 `readyState:0` 且 `error:null`、而 `curl` 直取那个媒体 URL 有 `206`/range → 先怀疑合成点击的 autoplay-block,不是代码;真点击或先 `v.muted=true`(静音自动播放不受此闸)即可区分。
- **可信点击点了"没反应"（Radix 这类自建触发器）→ 先照四条判据排除,再换键盘路径,别去查 body 锁。** 上一条说"要用户手势的能力必须真点击";这一条是反过来的一半:`cdp_act` 的真点击**也可能打不开**某些自建触发器（`aria-expanded` 纹丝不动）。**这不是稳定复现的**——同一个流程上一轮是通的,所以它是排查指引,不是"cdp_act 打不开 Radix"这种结论。判据（**四条同时成立**才算这一类）：① 触发器 `aria-expanded` 恒 `false`；② `[role="menu"]` / `[data-radix-popper-content-wrapper]` 都是 0 个；③ `getComputedStyle(document.body).pointerEvents === 'auto'`（**没有**残留的 body 锁）；④ `document.elementFromPoint(中心点)` 落在触发器内部（没被遮罩挡住）。四条齐了就**别再往"body 锁 / 多实例 dismissable-layer"那条老坑查**——那个坑的判据正相反（body 残留 `pointer-events:none`、点哪都不动），两者不是一回事。出路:焦点 + 派发 `keydown Enter`——Radix/React 的键盘处理器**不看 `isTrusted`**,合成事件照样开;而这里合成够用,恰恰是因为开个菜单不需要 user-activation（一旦你要测的是带声播放/全屏/剪贴板,回上一条,必须真点击）。验证过的写法：

  ```js
  // cdp_act({ target, kind:'evaluate', domain, expression: ... })
  (() => {
    const b = document.querySelector('button[aria-label="更多操作"]');
    b.focus();
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return b.getAttribute('aria-expanded');   // 下一次调用再读,同一 tick 读到的还是旧值
  })()
  ```

  菜单项同理（`[role="menuitem"]` 上 focus + Enter）。**`cdp_act` 没有通用的"按某个键"入口**：`kind` 只有 `goto/back/click/type/submit/scroll/exists/look/evaluate/setFiles`——`type` 是 select-all + `Input.insertText` 往输入框敲文本,`submit` 确实是可信 Enter（对焦点元素发 `Input.dispatchKeyEvent` keyDown/keyUp）**但它在高危确认门里**（先返回 `needs-confirmation`,要用户点头后 `confirmed:true` 重发）。所以自由按键就只有上面这条 in-page `dispatchEvent` 的路。

- **cmdk 的 `[cmdk-item]` 选不动——四条路全试过,别再耗。** 上一条讲的是"菜单打不开",这一条是"菜单开了、项也高亮了,就是选不中"。实测（2026-08-12,会话切换下拉）：① in-page 合成 `item.click()` → popover 不关、什么都没发生；② `cdp_act` 真点击 `[cmdk-item]` → `status:'not-found'`（cmdk 的 item 不是常规可点元素）；③ 在 `[cmdk-input]` 上合成 `ArrowDown` → **高亮真的动了**（`aria-selected` 翻成 true）,紧接着合成 `Enter` → 无事发生；④ `cdp_act` 的可信 `submit`（带 `confirmed:true`）打在 `[cmdk-input]` 上 → 同样无事发生。DOM 上也拿不到回调：`__reactProps$` 里只有 `data-slot/className/children/id/cmdk-item/role/aria-disabled/aria-selected`,**没有 `onSelect`**（它在 cmdk 内部的 context 里）。
  所以：**键盘导航吃合成事件,而"确认选中"那一步不吃**——这和上一条 Radix 触发器的结论不一样,别套用。真实用户用鼠标点是好使的（生产没问题）,这纯粹是自动化驱动的边界。撞上就**换一条不经 cmdk 的验证路径**（直接打 API、或换一个有常规按钮的入口）,并在报告里说清"这一步没能在自动化里眼见为实、需要人点一下",别把工具限制写成产品缺陷。

- **"关掉的弹层还留在 DOM 里"是隐藏 tab 的假象,不是关不掉。** 关掉 Dialog/Popover 之后 `[role="dialog"]` 还在、还占着位置,再关一次、按 Escape 都没用——**先看 `document.visibilityState`**。判据（两条同时成立就是这一类）：① `document.visibilityState === 'hidden'`；② 那个节点 `data-state="closed"` 但仍在 DOM 里、`display` 不是 `none`。根因：隐藏 tab 里 CSS 动画不跑 → 退场动画的 `animationend` 永远不来 → Radix 的 Presence 等不到那一帧,就不卸载。**逻辑上它已经关了**（`data-state` 就是证据）,只是没被移除。出路：`cdp_act` 一次 `goto` 当前 URL 重载页面（DOM 洗干净,状态照旧从后端拉），或者让用户把那个 tab 切到前台。**别往产品 bug 上想**——前台用户不会遇到；也别据此断言"这个弹层关不掉"。
  连带影响：`document.querySelectorAll('[role="dialog"]').length` 在隐藏 tab 里会越关越多,拿它数"现在开着几层"必然错——要判开没开就读 `data-state`,别数节点。

## Worked example

Measuring YouTube's card typography for a design task (title 16/500/lh22 #f1f1f1, subtitle 14/400/lh20 #aaa, badge `rgba(0,0,0,.6)` r4): `cdp_look({ target:'chrome', url:'https://www.youtube.com', interactive:true, js:'...' })`, wait ~2.5s, `querySelector('ytd-rich-item-renderer')`, read `getComputedStyle`/`getBoundingClientRect` on `#video-title` + the metadata leaf rows, return a plain object.

---

## `target:'facility:<name>'`——facility 的采集页

对某个 facility **当前活着的采集 tab** 看两件事、或试着动一下。经 `Transport.evaluate` / `Transport.screenshot` 走——你只给 facility 名，不用管它是哪个 tab。

- `cdp_look({ target: 'facility:<name>', js })` → `{ value }`。`js` 是一段**表达式**（如 `({s: window.__INITIAL_STATE__})` 或 `document.title`），返回值必须 JSON 可序列化。值在**页面内**就拍平成 JSON，所以 SPA 的响应式 store 不会变成 `{}`。
- `cdp_shot({ target: 'facility:<name>' })` → `{ shot }`（base64 JPEG，当前视口）。look 说 DOM 怎么写，shot 说页面**长什么样**——选择器匹配到隐藏元素、页面根本没渲染、DOM 里看不见的遮罩/验证墙，只有眼睛看得出来。
- `cdp_act({ target: 'facility:<name>', kind, domain, ... })` → 在那个 tab 上真点一下试试（可信点击）。带 `expect` 选择器就点完确认预期特征出没出现（`confirmed` / `acted-unconfirmed`），不盲赌。

该 facility 当前没有活 tab（采集没在跑）→ `{ value: null, live: false }` / `{ shot: null }`。**这不是错误**，是"现在没有那个 tab"。

等价的 HTTP 路由也在，用于非 MCP 调用方：`GET /api/facilities/:id/page`（→ `{facility,url,title}`，探活最省事的一发）、`GET .../page/screenshot`（`image/jpeg`）、`POST .../page/evaluations` body `{expression}`（→ `201 {value}`；求值抛错 `502`，没活 tab `404`，读口未启用 `503`）。

看的是**正在跑的采集那个 tab 的当下状态**——所以它是对齐"账本 vs 页面"、看首屏 `__INITIAL_STATE__`、查 locate 命中了哪些卡片的读口。不改采集、不产出持久物。

---

## `target:'desktop'` / `'app:<进程>[/<标题>]'`——一个原生窗口

浏览器够不到的东西走这里：`chrome://extensions` 这类特权页（`chrome.debugger` 不能 attach
`chrome://`）、桌面客户端、系统设置。底层是 **Stream Desktop** 的本机进程（源码
`app/host-agent/`，产物 `stream-desktop.exe`，Rust + Windows UIA + enigo），经 `/api/host` WS
受后端驱动。（**只有目录名**还叫 `host-agent`：纯内部路径，用户看不见；对外的名字全是
`desktop`——见 `capabilities/desktop/README.md`。）

**前置**：那个进程得在跑。从 WSL 直接起就行（它是 Windows exe，但 WSL 能执行）：

```bash
WSLENV=STREAM_HOST_URL:STREAM_HOST_TOKEN \
STREAM_HOST_URL="ws://127.0.0.1:8900/api/host" \
STREAM_HOST_TOKEN="$(< data/ext-relay-token)" \
./app/host-agent/target/x86_64-pc-windows-gnu/release/stream-desktop.exe
```

**`WSLENV` 不能省**：不经它传，Windows 侧读到的是空值，agent 会连不上又不说为什么。

**`target/` 里那份 exe 旁边没有读屏模型、也没有 ONNX Runtime**（两样都只在平台包的 `bin/`，
gitignored）：这样起的 agent 配对、控件树、截图都正常，读屏那一格一律 `ocr-missing` / `ort-missing`
——不回落。要读屏就把 `STREAM_OCR_MODELS` 也经 `WSLENV` 传过去（路径变量要带 `/p` 让 WSL 翻译成
Windows 路径：`WSLENV=…:STREAM_OCR_MODELS/p STREAM_OCR_MODELS=capabilities/desktop/platforms/desktop-win32-x64/bin`
——运行时库缺省就在模型同目录找，不用再单独指 `STREAM_ORT_LIB`），或者干脆按下一节把 exe 拷进那个
目录再起。

> **下面这一小节只对 Stream 的源码检出成立**（改那个 Rust 进程自己的代码）。装了 npm 包的用户
> 没有 `app/host-agent/`，也不需要它——二进制走 npm 平台包
> （`@streamapp/desktop-win32-x64`，发行安装是 `cli/package.json` 的 optionalDependency），跳过这一节即可。

**改了 `app/host-agent/` 的代码，光重新编译不生效——你得把产物拷到 agent 真正被拉起的那个
路径。** 日常跑着的 agent 由 Stream 后端进程内那个 supervisor 管（`src/host-agent/mount.ts`），它起的是
`capabilities/desktop/platforms/desktop-win32-x64/bin/stream-desktop.exe`（gitignored 的
本地副本，**只有 release workflow 会更新它**），不是 `app/host-agent/target/…` 那份。所以
改完要：

```bash
scripts/qrun.sh cargo build --release --target x86_64-pc-windows-gnu \
  --manifest-path app/host-agent/Cargo.toml            # manifest-path 显式给，别靠 cwd
cp app/host-agent/target/x86_64-pc-windows-gnu/release/stream-desktop.exe \
   capabilities/desktop/platforms/desktop-win32-x64/bin/
/mnt/c/Windows/System32/taskkill.exe /PID <agent pid> /F    # supervisor 几秒内拉起新的
```

**杀掉就行，不用手工起**——supervisor 会用盘上那份重新拉起来。手工再起一个的结果是两个
agent 同时连着 relay 抢活。

这条坑失败得完全静默：代码改了、`cargo test` 全绿、编译也成功，活体行为却纹丝不动，看起来
像"判据没生效"。判它的办法是**直接搜二进制**——注意 `strings` 默认只抓 ASCII，中文串一律
抓不到，得用 `grep -ac '<中文串>' <exe>`（真按这个踩过一次，用 `strings` 得出了"新代码没编进去"
的错误结论）。查跑着的是哪一份：
`wmic.exe process where "ProcessId=<pid>" get ExecutablePath`。

### 四个动词在这一档的样子

| 动词 | 干什么 |
|---|---|
| `cdp_pages({target:'desktop'})` | 列窗口 `{id, process, title, foreground}`。**先认出目标再动手**——返回的字段就是为了让你直接拼出 `app:` 地址 |
| `cdp_look` | 读 a11y 树。`js` 在这一档是**一段 JSON 的 a11y query**（`{"role":"Button"}`），不是 JavaScript——原生窗口里没有 DOM 也没有 JS。回 `{window, value:[全部命中], unbuilt?}`，第三个字段见下 |
| `cdp_shot` | 截图。**截的是那个窗口本身，不是屏幕**——被遮、在后台、锁屏都照样截回窗口真容（PrintWindow 命令窗口把内容画进离屏位图）。只有这条路失败才落回抓屏 |
| `cdp_act` | 真点击/打字/滚动。`selector` 和 `expect` 同样是 JSON a11y query |
| `cdp_act({kind:'open'})` | **唤起应用**（进程不在就拉起来）。这一档唯一不要求目标已有窗口的动作——写法与两个必填参数见上面「禁令」那节 |

**`role` 认不出会报错，不会静默放行。** 写 `{role:'Xxx'}` 而实现的表里没有这一项 → 报
`unknown role 'Xxx'` 并中止。这是有意的：过滤条件静默失效比没有过滤更危险——查询照常返回一批
"看起来对"的元素，第一名可能是完全不同的控件，而 `cdp_act` 会把它直接执行掉。表里现有的常客：
`Button` `Text` `Edit` `Group` `Window` `Pane` `Document` `List` `ListItem` `DataItem` `TreeItem`
`Tab` `TabItem` `Hyperlink` `CheckBox` `ComboBox` `MenuItem` `ToolBar` `Image` `Custom`。
报了 unknown role 就是表里没有——换一个 role 或去 `role_to_control`（`app/host-agent/src/windows.rs`）补。

**空结果分两种，回执里就写着是哪一种。** 命中 0 条时，若这次搜索限定的那个窗口**不在前台**，
回执会多出一个 `unbuilt` 字段（`cdp_act` 定位失败时则编进报错、桌面 recipe 编进 `driftReason`），
内容形如 `a11y-unbuilt: 0 命中，而搜索范围限定的窗口 … 不在前台 …`。

- **有 `unbuilt`，且它说「会话是锁屏状态」** → 下一步是**解锁**，不是 focus（锁屏下抬不起
  前台，`focusApp` 会被 `desktop-locked` 拒）。锁屏下这个空还多一种来源：本会话从没渲染过的
  内容压根不在 a11y 树里（见下面锁屏那张表的最后一行）。判据走 WTS 会话状态（纯读，不碰前台）；
  **查不出锁没锁时给的是下面那句默认的**——旗从不猜。
- **有 `unbuilt`** → 这个空**不可采信**。Chromium/Electron（QQ、VS Code、Discord…）的 a11y 树是
  **懒建**的：窗口不在前台时任何查询都回空数组、不报错。先把它弄到前台再读——桌面 recipe 的
  第一步写 `{"kind":"focus"}`；手动看的话走一次要前台的 `cdp_act`（`type`/`scroll`/坐标点击都会
  先 `focusApp`），或让用户自己切过去。**别去改选择器**——选择器多半没毛病。
  实测（`app:QQ.exe`，2026-08-27）：后台时 `role=Edit` / `role=Button` / `nameContains=搜索`
  全部空手而归，同一时刻同一个 agent 读 `explorer.exe` 的任务栏拿到 21 个控件。
- **没有 `unbuilt`** → 目标窗口就在前台（树该建好了），或这次压根没限定窗口。前一种下这个空
  是真的空：换 `role`、改用 `nameContains`（列表项的 name 是一整句动态文本，全等永远匹配不上）。

反过来说，**Qt/Win32 那类应用（Telegram、资源管理器）后台照样有完整的树**——这也是桌面采集
能"人不在时后台干活"的前提。懒建是 Chromium 系独有的脾气，不是所有应用的通病。

**读不抢屏；动手抢不抢，看走的哪条路。** `cdp_look`/`cdp_shot` 只把搜索范围限定到那个窗口
（`scopeWindow`），Z 序和焦点一律不动。`cdp_act` 分两条：

| 走哪条 | 什么时候 | 抢屏吗 |
|---|---|---|
| `via:"invoke"` | `click` 且定位到的元素有原生句柄（绝大多数控件都有） | **不抢**。收件人是元素本身，不算坐标、不受遮挡影响、锁屏也生效 |
| `via:"value"` | 把文字**写进某个输入框**（`setValue` op，UIA ValuePattern） | **不抢**。同 invoke，收件人是元素句柄 |
| `via:"coords"` | 元素没句柄退回坐标点击，以及键盘 `type`/`scroll` | 先把窗口拿到前台并**回读验证**，拿不到就报错、**一个输入都不发** |
| `via:"message"` | 桌面 recipe 写了 `input:"message"`：坐标点击 / `type` / `scroll` / 打断的 `press` 全部 `PostMessage` 给 scope 到的顶层窗口 | **不抢**。收件人是 hwnd，锁屏照常；但应用不认消息时什么都不发生，靠每步 `expect` 判 |

不对称是有意的：坐标输入是投给屏幕的，不在前台就等于对着别人的窗口乱按；而 invoke 有明确
收件人，抢屏纯属副作用——半夜的定时采集不该把用户的屏幕夺过去。

**`setValue` 写不进去，先怀疑你挑中的是容器而不是输入框。** a11y 树里的输入框常常是**套着的
两层**：外层容器和里层真正的文本域（Telegram 是 `Ui::InputField` 套 `Ui::InputField::Inner`）。
**按坐标/顺序挑必然挑中外层容器**，而容器不存文字，写进去回读永远是空。2026-08-04 因此把
「Telegram 不支持 SetValue」判反过一次——改指里层 `className` 之后一次就成，锁屏状态下写值 +
触发搜索 + 读结果全部照常。

**两条配套的纪律**：
- agent 侧每一级写完都回读确认、**读不回来就算失败**，所以你拿到的 `Err` 是可信的；但它只告诉你
  "没写进去"，**不告诉你是元素挑错了还是应用不支持**——先换元素再下结论。
- **别用"读到了多少条"当"输入生效了"的证据。** 那些条目可能是列表本来就有的（在一个影视资源
  频道里搜 `4K`，主列表里本来就一堆）。真判据是**读回来的条目里含不含查询词**。

**抢屏的真正来源是「取焦点」，不是"写入"本身**（2026-08-04 对 Telegram 逐项归因）：`find`/读
不抢；UIA `set_focus` 抢；`SetValue` 抢（它内部先取焦点）；`invoke` 抢（应用自己 activate），
**而且 invoke 一条列表项还会把应用内部的焦点带走**。唯一实测不抢屏的输入通道是**往窗口投
`WM_CHAR` 消息**（`PostMessage`，一个 UIA 写操作都不做）——但它要求**应用内部焦点已经在目标
输入框上**，而把焦点弄过去的每一种手段都会抢屏。所以「能不能后台跑」实际取决于：这条流程
里能不能一次 invoke 都不做。host-agent 里有现成探针：`stream-desktop.exe spike-typing <词>`
逐项量给你看，看 `postmessage-no-focus` 那一行成不成。

**「不抢屏」说的是引擎侧不抢，不是屏幕不会变。** 被控应用完全可以在响应你这一下的时候
**自己跳到前台**——实测（2026-08-04）：`invoke` Telegram 的「搜索消息」按钮，我们一次 `focusApp`
都没发，Telegram 照样把自己的窗口 activate 了；同一轮里 `find` 前后前台纹丝不动，钉死了责任人是
那一下 invoke 触发的应用行为。所以**"这条链路能后台跑"只能对着真机量前后台得出，不能从
"我们没调 focusApp" 推出来**（量法：`windows()` 里 `foreground:true` 的那个，**不是 `url()`**——
`url()` 报的是 UIA 键盘焦点元素，点开输入框后它当然在目标应用里，拿它当判据必然误判"抢了屏"）。

**回执里的 `via` 就是走了哪条路**（`confirmed` 另说，那是"效果验没验、兑没兑现"）。这个分支
从调用方看是隐形的，而**锁屏时行不行恰恰取决于它**——拿到结果先看 `via`，别猜。

**invoke 是四级降级链**：Invoke → SelectionItem → Toggle → LegacyIAccessible 默认动作，任一级
成功就返回，全败才报错并列出各级各自的原因。别以为"点不动就是控件不支持"——Chrome 的标签页就
不实现 InvokePattern（它是 SelectionItem），只会第一级的实现点它必然失败，而那个失败经 Win32
格式化后是「操作成功完成。」（`ERROR_SUCCESS` 的文本），**比失败更误导**。见到这类文本别信，
去看 `via` 和 `confirmed`。

**没有控件树的自绘应用 → `cdp_act` 的 `kind:'click'` 给 `x`/`y`（绝对屏幕物理像素），不给 `selector`。** 微信 4.x
桌面版（`Weixin.exe`）就是这一类：前台之后查 Edit / Button / Text / ListItem / 含「搜索」全部为空，
整个窗口只有一个自绘 Pane（`className: MMUIRenderSubWindowHW`）和一个 1×1 的 `Qt51514QWindowIcon`，
`selector` 那条路天然为空。坐标点击**一定先抢前台**（抢不到一个输入都不发），别拿它做后台任务。
坐标怎么来，**只有两套坐标系，中间没有第三套**：Stream Desktop 是进程级 Per-Monitor-V2 DPI 感知的，
所以 wire 上一切 rect 都是**物理像素**。
- `cdp_shot({target:'app:…'})` 拿到的是**整窗**位图，图上的像素和物理像素 1:1。
- `cdp_act` 的 `x`/`y` 也是**物理像素**的绝对屏幕坐标（enigo 在感知进程里同样按物理走）。所以
  **截图上量到的点 + 窗口的物理原点 = 可以直接点的坐标**，4K 200% 的机器上不做任何换算。
  见到 `÷ scale` 就是有人又造了一套坐标系。
- **a11y 的 rect 和截图尺寸对不上，别去换算——那是 Stream Desktop 没以 DPI 感知启动。** 同一个自绘
  Pane 一会儿读到 `1920×1032`、一会儿 `3840×2064`，是进程没声明 Per-Monitor-V2 的签名症状。
  去查它怎么起的，凑一个 `÷ scale` 只会把一处配置错误摊成一堆到处对不上的坐标。

判成没成：`expect` 在这类应用里什么也看不见，只能再截一张——截的是整窗，界面上任何一处都能当证据
（发消息的判据是会话列表里那一行的预览文字变成了刚发的内容）。

**写 recipe 就别再手抠坐标了**：`kind:'desktop'` 的 recipe 用 `see` 指屏幕上的文字或图标、用 `expect`
一步一验，识别层自己去找框（`src/replay/desktop-see.ts`，契约见 `docs/PACKAGE.md` §2）。这里这套
是给**临时看一眼、动一下**用的。

**想知道识别层在这台机器上到底认出了什么字，不用跑 recipe**（runner 第一步就抢前台，锁屏时一步都
走不到）：agent 的 exe 直接带一个只读的排错子命令，锁屏下照常能跑——

```bash
capabilities/desktop/platforms/desktop-win32-x64/bin/stream-desktop.exe see-probe Weixin.exe 微信 \
  | jq '{rect,scale,ms,n:(.texts|length)}, [.texts[]|"\(.text)@\(.rect.x),\(.rect.y)"]'
```

mac 上同一条子命令（进程名是 mac 的应用名：`stream-desktop see-probe 微信 微信`），回执里多一格
`screenshot{imageW,imageH,window,scale}`，判据是 `imageW/H == rect.w/h`。**mac 锁屏下跑不了**——和
Windows 正相反：锁着时 AX 把标题塌成应用名、位置全 0，CGWindowList 截出整张纯色，probe 如实报
`blank-capture` / `ambiguous-window`；截图还要「屏幕录制」授权（授给起进程的那个应用），清单在
`capabilities/desktop/README.md` 的 mac 四条。

出来的每一条就是 `see:{text}` 能指的段（框在截图坐标系；Windows 物理像素、mac 点）。判 recipe 里某个 `see`/`expect`
为什么不中，先看这份清单：段不在 → OCR 没认出（换字、或那块是图标得走 `icon`）；段在但 `region`
不对 → 九宫格罩错了格。回执里还有 `elements`（元素表：能点的东西 + 合成出来的名字）、几个耗时
（`textMs` 整窗文字表、`elementsMs` 元素表、`elementsIconsMs` 再加上检测器），以及
`engine{name,version,threads,lib}`——识别层跑的是哪一份 ONNX Runtime、几个线程、dlopen 的哪个文件
（加载日志同一行 `[ocr] engine = ort …`）。probe 一起来就以 `ocr-missing:` / `ort-missing:` 退出，
是 exe 同目录缺了模型三件或运行时库：**两平台同一判据、不回落到任何别的 OCR**，补文件
（清单在 `capabilities/desktop/README.md`「平台包与版本」），或用 `STREAM_OCR_MODELS` /
`STREAM_ORT_LIB` 指过去。线程数 `STREAM_OCR_ORT_THREADS`，缺省 `min(物理核, 8)`。

**`see-probe` 看的是"此刻这一屏有什么"，看不到"recipe 当时看到了什么"。** 排查点错要用下面那个。

#### 点错了？别对着事后截图猜 —— 开 see 的现场记录

**最贵的一课**（2026-09-07）：靠事后截图 + 步骤日志推"它当时看到了什么"，推出过一个完全错误的
因果（"兜底行先渲染、真结果晚一步"），而人盯着屏幕看到的是两行同时出现。**猜出来的因果读起来
和量出来的一模一样**——这是这条链路上最贵的东西。

后端环境变量 `STREAM_DESKTOP_SEE_TRACE=1`（开发机在 systemd drop-in 里），每次 `see` 决定落一条
JSON + 一张叠图到 `<dataDir>/desktop-see/<sourceId>/trace/`，文件名是 `<序号>-<第几步>-<模式>-<标签>`：

```bash
ls data/desktop-see/qq-send-see/trace/
jq '{why, exact, contains, picked, candidates:[.candidates[]|"\(.i) \(.text) @\(.rect.x),\(.rect.y)"]}' \
  data/desktop-see/qq-send-see/trace/06-6_action_点会话行.json
```

一条记录回答四件事：**区域算成像素之后是哪一块、这一段考虑过哪些候选、全等/包含各是谁、
最后选了哪个（没选中时为什么）**。叠图上候选描黄边编号、选中的描红加粗——**"选错了候选"和
"选对了候选但坐标算错"当场就分得开**，而这两件事在截图上长得一模一样。

每条多一次 `captureWindow`（几十毫秒），**排查完记得关掉**。

**它记的是"我决定点哪儿"，不记"这一下到底落下去没有"**——动作那半目前还是黑的。所以看到
"决定是对的、结果没发生"时，别急着怀疑识别层。

**分段是会变的。** 同一块文字，这一帧是一整段、下一帧被切成两段——像素路上一切"靠文字唯一性"
的判据都受它影响（典型形状见 `write-recipe/references/failure-atlas.md` B.5）。清单里的段也
偶尔会把挨得近的两个标签连成一条，按包含匹配仍然命中，只是框会宽一截。
微信搜索一弹出候选，`Weixin.exe` 就有两个窗口（`微信` 主窗 + `Weixin` 候选弹层），`app:Weixin.exe`
会报 ambiguous-window，之后一律写 `app:Weixin.exe/微信`。整条发消息的路（都验过）：点搜索框 →
`type` 名字 → `type "\n"` 打开第一个候选 → 焦点已在输入框，`type` 正文 → `type "\n"` 发出。
**这条路已沉淀为 `packages/wechat/wechat-send.recipe.json`，别再手抠**——上面只是解释窗口为什么会
ambiguous，不是让你照着做。

### 五个坑（都是活体撞出来的）

**1. 读得到 ≠ 点得动。** 最贵的一个。UIA 会给**所有**标签维持 a11y 树，包括后台标签——
于是 `cdp_look` 在一个根本不在前面的标签里找到了按钮，看起来"页面可操作"，而点击按屏幕坐标
落地，打在了当前活动标签上。**`find` 成功不是可点的证据。** 判据只有一个：`cdp_act` 带 `expect`
回来说 `confirmed`。

**2. 桌面锁着时能干什么，一张表说清**（别混成"锁屏就不能动"）：

| 锁屏下 | 行不行 | 为什么 |
|---|---|---|
| 读 a11y 树（**已经物化的**部分） | ✅ | a11y 树完全不受锁屏影响 |
| 原生 `invoke`（**已经物化的**元素） | ✅ | 收件人是元素句柄，不需要前台（实测：锁着屏把 bilibili 画中画开了又关；2026-08-02 锁屏 + Chrome 在后台切标签页成功） |
| `setValue` 写进输入框 | ✅ | 同上，收件人是元素句柄。控件不认 Value pattern 时会失败——那是控件的事，不是锁屏的事（**自绘应用常见**，见下） |
| 坐标输入（退回的坐标点击、键盘 `type`、`scroll`） | ❌ | 锁屏时没有任何应用窗口能取得前台，而坐标点击必须有已确认的收件人。报错指明是锁屏（判据是前台归 `LockApp.exe`），不是 `blocked by UIPI` |
| 同样的坐标输入，recipe 写了 `input:"message"` | ✅（认消息的应用） | 投给窗口 hwnd，不要前台。微信 4.x 验过；Electron 系多半不认，见下 |
| **从没渲染过的页面内容** | ❌ | renderer 对没渲染过的页面不出帧，**锁屏期间也不会补画**——那些元素在 a11y 树里根本不存在，四条点击路径全都无米之炊 |

所以定时桌面采集**不会**因为用户锁屏而停——这是有意保住的，不是漏网。

**坐标输入投给窗口（`PostMessage`）是第三条路，桌面 recipe 里写 `input:"message"` 才走。** 机制
是按键精灵那套：`WM_LBUTTONDOWN`/`WM_CHAR` 投给 hwnd，收件人是窗口不是屏幕，遮挡/最小化/锁屏都
不影响——和 `PrintWindow` 截图、UIA `invoke`、`setValue` 同族，上表里能打 ✅ 的正是这些。**它是
逐应用的兼容性轴，所以只做成 recipe 显式选的一档，不做自动退路**：Chromium/Electron（QQ、VS Code、
Discord、Chrome）的输入走自己的合成器，多半不理会投进来的消息，而且失败得安静（什么都不发生）。
量过的：**微信 4.x 认**（2026-09-07 本机锁屏：点搜索框、打中文、回车打开会话、候选弹层照常出来，
纯 `PostMessage` 到标题「微信」的**顶层主窗口**即可，不需要 `WM_MOUSEACTIVATE`/`WM_SETFOCUS`；投给
它里面的自绘子窗口 `MMUIRenderSubWindowHW` 一个字都进不去）。没量过的应用别写 `input:"message"`，
写了的 recipe 每一步都要挂 `expect`——那是这条路上唯一能发现"投了没进"的判据。单发的 `cdp_act`
没有这一档（它没有 recipe 可声明），要后台动一个没有控件树的应用就写 recipe。

**最后一行不是闸门，是渲染缺席，没有错误码对应它**：`find` 只会报查无此元素。判据用截图——
`cdp_shot` 截的是窗口本身，锁屏下截回来若是「浏览器 UI 全在、页面内容区空白」，那就把
"renderer 没出帧、所以 a11y 树里没有页面内容"钉死成看见的事实（活体 2026-08-02：锁屏下切到
从未显示过的 `chrome://extensions`，正是这个样子）。**反过来别拿抓屏当证据**——屏幕上盖着的
锁屏壁纸什么也证明不了，它和"窗口长什么样"是两个问题，混起来真误导过一轮诊断。

**别拿"锁没锁"当判据去写逻辑**：`OpenInputDesktop` 查桌面名在锁屏下恒报 `Default`（8 次采样，
从没说过锁了），`LogonUI.exe` 在不在时有时无。唯一稳的是**谁占着前台**。

**3. `name` 是全等匹配——列表项几乎永远匹配不上，得用 `nameContains`。** 这条最坑，因为
**失败的样子是空结果**，跟"这个元素不存在"一模一样，于是很容易得出"这个界面读不到"的错误结论。
真相是列表项的 name 往往是一整句拼出来的动态文本：

```
频道, 夸克云盘影视资源频道, 已静音, 1908 个新消息, 图片, 名称：天才，女友（2026）4K…, 已收到, 1:39
```

未读数、最后一条消息、时间每秒都在变，`{"name":"夸克云盘影视资源频道"}` 一次都不会命中。写成
`{"role":"ListItem","nameContains":"夸克云盘影视资源频道"}`（包含匹配，大小写不敏感）才对。
两个一起给会**报错**、不会退化成其中一个——静默失效的过滤条件比没有过滤更危险。
recipe 里 `nameContains` 同样吃 `{param}` 占位（「按名打开某个频道」整条路就建立在这上面）。

**4. 名字撞车比想象中常见。** `{role:'Button', name:'重新加载'}` 在 `chrome://extensions` 上
**同时命中两个**：浏览器工具栏的刷新（`className:'ReloadButton'`，y=7）和扩展卡片上那个
（`className:'icon-refresh no-overlap'`，y=530）。所以 `cdp_look` 返回全部命中——拿 `className`
或 `rect` 区分。一个只给第一个候选的枚举，会让"点了没反应"被归因成点击失败，真因却是点错了元素。

**5. 这一档的 `type` 是往光标处追加，不是替换——重打一次之前必须先清空。** `type` 走
`via:"coords"`（enigo 直接发按键，`type_text` 在 `app/host-agent/src/windows.rs`：只发文本，
末尾 `\n` 转成回车，**没有任何全选/清空**）。所以对同一个输入框连打两次，第二次接在第一次后面。
活体（2026-09-04，`chrome://flags` 的搜索框）：`vertical` → `Enabled` → `Vertical Tabs` 三次
打完，框里是 `verticalEnabledVertical Tabs`。**`cdp_act` 里没有"清空"这个动作**——`type` 只发
文本，敲不出 `Ctrl+A`，而覆盖整值的 `setValue`（`via:"value"`）只有桌面 recipe 的带 `query`
那条路够得到。所以在这一档：**一个输入框只打一次**，措辞想改就先让人/让界面自己清（控件自带的
清除按钮可以 `click`），别直接再 `type` 一遍。

**判据只有截图。** a11y 树**读不出输入框的当前值**（`cdp_look` 的元素只有 name/rect/className，
没有 value），所以这一档没有"我到底往里打了什么"的读回路径，唯一能看的是 `cdp_shot`。
症状极其误导：搜索框里是拼出来的垃圾词 → 结果列表为空 → 读起来完全像"这个 flag 不存在"。
**搜出来是空的，先截图看输入框，别先下"没有这个东西"的结论。**

**chrome 档不是这个语义**——`target:'chrome:<tabId>'` 的 `type` 是**全选 + `Input.insertText`**
（`Ctrl+A` → `insertText`，`src/replay/browser-ext-drive.test.ts` 钉着这个顺序），也就是**替换**。
两档同名不同义，跨档搬经验就会踩这一条。

### 失败六档，各是各的意思

| 报错 | 意思 | 下一步 |
|---|---|---|
| `agent-disconnected` | Stream Desktop 没连——**整档不可用**，不是这次动作失败 | 起它 |
| `desktop-locked` | 取不到前台，而前台归锁屏界面 | 解锁；**读和原生 invoke 都不受影响**，只有坐标输入受阻 |
| `no-window-match` | 没有窗口匹配 | `cdp_pages` 看看到底有什么 |
| `ambiguous-window` | 多个窗口都像，**不擅自选** | 报错里带候选标题，挑一个补进 `app:<进程>/<标题>` |
| `no-foreground-target` | 还没确立目标就要发输入 | 先 `cdp_act` 的定位那步 |
| `foreground-lost` | 抢前台失败，**输入一个都没发出** | 别的窗口压着（UAC/置顶窗口）；提示用户手动切过去。可以直接重试 |
| `foreground-lost-midway` | **打字打到一半**前台被抢走——后半截可能打进了别人的窗口 | **别直接重发**（会发两遍）。先去看目标应用的实际状态，再决定补发还是重来。常见抢屏者是刚被 `ensureApp` 拉起、几秒后才夺焦的 Chrome |

标题是**包含**匹配、且只在需要消歧时才给：真实窗口标题带动态前后缀
（`扩展程序 - Google Chrome`），全等匹配几乎必然落空。标题还是本地化字符串——
写死在示例里会跨语言环境失效，能用 `role` + 结构特征定位的就别用标题。

### 一个完整例子：点 `chrome://extensions` 上的「重新加载」

`chrome://` 页面 CDP 够不到（attach 就炸），只能走桌面这一档：

> 开发期一般用不上这一步——`pnpm dev` 起的 WXT 监视器会让扩展改完自己
> `chrome.runtime.reload()`（前提是装载的是 `.output/chrome-mv3-dev`，见
> `extension/README.md`）。装的是非 dev 构建、或监视器没跑时，才手动点。

```
cdp_pages({target:'desktop'})                       # 认出窗口
cdp_look({target:'app:chrome.exe/扩展程序', js:'{"role":"Button","name":"重新加载"}'})
                                                     # 两个命中，按 className 挑
cdp_act({target:'app:chrome.exe/扩展程序', kind:'click', domain:'chrome',
         selector:'{"role":"Button","name":"重新加载","className":"icon-refresh no-overlap"}',
         expect:'{"role":"Button","name":"移除"}'})   # → {confirmed:true}
```

判据不是"命令没报错"，是 `GET /api/ext/relay-status` 的 `since` 变新（扩展真的重启了）。


## 高危确认门（`cdp_act` 通用，不分 target）

`cdp_act` 对 `chrome:<tabId>` / `facility:<name>` 都走同一套门：`domain` 会和浏览器自己记录的当前域重新核对；`submit`、跨站 `goto`，或声明了 `intent: send/publish/purchase/delete/credential` 的动作会先 STOP 返回 `{status:'needs-confirmation'}`，必须拿到用户同意后带 `confirmed:true` 重发才会真的执行。`expect` 选择器可选，点完/操作完用它确认预期特征出没出现。`kind:'open'` 也不过这道门（开新标签不动任何已有页面，理由见上），它是唯一的例外。
