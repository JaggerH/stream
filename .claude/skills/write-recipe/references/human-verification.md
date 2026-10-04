# 人机验证挑战（Cloudflare Turnstile 等）：识别、定位、点过去

写 recipe 撞到「☐ 请验证您是真人」时看这一份。**结论先给：可信的 CDP 点击就能过**，
不需要升级到 OS 级输入——但有两个前提会静默地把你卡死，而且症状极具误导性。

活体来源：2026-07-26，`console.groq.com/keys` 建 API key 的流程。

---

## 1. 两个前提（不满足就永远过不去，而且看不出原因）

### 前提一：tab 必须**可见**，否则 widget 根本不渲染

**Turnstile 在 `document.visibilityState === 'hidden'` 的 tab 里不运行。** 后台 tab、被别的窗口
完全遮挡的窗口（Chrome 的 occlusion 检测会把它算 hidden）、最小化——都不渲染。

症状极坑：容器 div 在、`window.turnstile` 这个全局对象也在、`cf-turnstile-response` 这个隐藏
input 也在，**就是没有 widget，token 恒空**，于是表单的提交按钮**从不渲染**（提交按钮通常是
"拿到 token 才出现"的）。看 DOM 会以为"页面坏了"或"被识破了"，其实只是没人看它。

> 一整晚的误判就是从这里开始的：以为 CDP 点击被反自动化拒了，实际 widget 压根没渲染。
> **判据**：读一次 `document.visibilityState`，不是 `visible` 就先解决可见性，别调试点击。

两件事别混：

- **为什么要读它**：Turnstile 是**站点自己**读了 `visibilityState` 就决定不运行。这跟"逼帧"是两回事
  ——逼帧解决的是"浏览器压着不画"，而这里页面根本没开始画。所以判据永远是**读一次
  `visibilityState`**，不是"我逼过帧了应该没问题"。
- **怎么让它变 `visible`**：**别猜，现测**。lane 建好就发的 `Emulation.setFocusEmulationEnabled`
  （`browser-ext.ts` 的 launch）确实让隐藏 tab 对页面自称 `hasFocus()===true`（实测），但
  **它顺带改不改 `visibilityState` 没有实验证实**（原因见 `session-runtime.md` 的 `visibility`
  一节）。所以碰人机验证的 recipe，第一步是在目标 tab 上读一次 `visibilityState` 拿到事实，
  再决定要不要 `session.visibility: 'interactive'`——把"应该是 visible"当前提用是这一格
  最常见的翻车方式。

读出来不是 `visible` 时先确认 focus 仿真发出去了；发了还不是 `visible`，那就是它救不了这一格。

### 前提二：点击必须落在**复选框**上，不是 widget 中心

widget 实测 **300×72**，复选框在**最左侧**的方块区，中间是文字「请验证您是真人」，右侧是
Cloudflare logo。**点 rect 中心 = 点在文字上，不生效**（实测：点中心 12 秒无反应；改点左侧
一秒通过）。

---

## 2. 怎么判断这一页有 Turnstile —— 别用站点自己的 id

**`#cf-turnstile` 是站点自己起的容器名**（Groq 恰好这么叫），换个站就叫别的，**不能当判据**。
Cloudflare 自己注入的东西才跨站点稳定：

| 判据 | 说明 |
|---|---|
| `input[name="cf-turnstile-response"]` | **最可靠**——CF 自己的命名，一定存在（token 的载体） |
| `window.turnstile` | CF 的 JS API 对象（`render`/`execute`/`getResponse`/`reset`…） |
| `script[src*="challenges.cloudflare.com/turnstile"]` | 挑战脚本 |
| `[id^="cf-chl-widget-"]` | CF 生成的 widget id 前缀 |

## 3. 怎么定位复选框 —— 从那个隐藏 input 往上一层

实测的 DOM 形状（外层是站点的，内层是 CF 建的）：

```html
<div id="cf-turnstile">                                     <!-- 站点容器，名字随站变 -->
  <div>                                                     <!-- ← CF 建的，rect = 300×72 -->
    <input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-8w4hi_response">
  </div>
</div>
```

**那个隐藏 input 的 `parentElement` 就是 widget 的盒子**，带真实 `getBoundingClientRect()`
（实测与外层容器一致，300×72）。

**写进 recipe 时不用 JS 也不用自造语法**——`:has()` 是标准 CSS（Chrome 105+），直接选父：

```css
:has(> input[name="cf-turnstile-response"])
```

在 in-page JS 里要拿 rect 算坐标，则是：

```js
const probe = document.querySelector('input[name="cf-turnstile-response"]')
if (!probe) return null                       // 这页没有 Turnstile
const r = probe.parentElement.getBoundingClientRect()
// 复选框在左侧方块区：横向进一个"行高"，纵向居中。用 height 自适应，别写死 30px。
const point = { x: r.left + r.height / 2, y: r.top + r.height / 2 }
```

### widget 内部**查询不到**（closed shadow root）

别试图 `querySelector('#cf-turnstile iframe')` 或去遍历 shadow DOM：**Turnstile 的 widget 活在
closed shadow root 里**，`element.shadowRoot` 返回 `null`，`document.querySelectorAll('iframe')`
也找不到它。**唯一能拿到的就是宿主的 rect** —— 所以"宿主 rect + 偏移"是唯一可行的定位法，
不是偷懒。

（这也意味着**没法从 DOM 判断它是不是已经勾上了**。）

**判"过没过"看表单的提交按钮出没出现，别轮询那个 input 的 `value`** —— 实测过了之后
`input[name=cf-turnstile-response]` **整个从 DOM 移除**（`querySelector` 返回 `null`），
照着轮 `.value` 会对着 null 轮到超时。写进 recipe 就是提交那步的
`expect: { selector: "<提交按钮>" }`。

## 3.5 什么时候点 —— 早点**不是白点，是把它打坏**

这是最贵的一条：**在 widget 就绪之前点下去，会把它打进失败态，之后重做 8 次全废。**
所以必须"等到"，不能"先试试再说"。

而"就绪没有"**从 DOM 里看不出来**：实测对话框打开后 DOM 连续 **9.3 秒一个字节不动**、
`window.frames.length` 也不动，而这 2 秒里复选框正从「空」→「转圈」→「可点」。
**页面不肯说，但它在画。**

写进 recipe 就是那一步的 `settle`（见 `authoring.md` §3.5）：盯宿主那块区域，
**"变过了 + 停住了"** 才动手 —— 逐帧比裁剪后的 JPEG 字节，不解码、不存参考图、不联网。

```jsonc
{ "kind": "click",
  "selector": ":has(> input[name=\"cf-turnstile-response\"])",
  "position": { "x": 36, "y": 36 },
  "settle": { "selector": ":has(> input[name=\"cf-turnstile-response\"])", "stableFrames": 3, "intervalMs": 250 },
  "expect": { "selector": "<提交按钮>", "timeout": 45000 } }
```

手工探查时同理：开完对话框先等两三秒再点。**这一晚所有的"CDP 过不了验证"，根因都在这里。**

## 4. 用什么点

**可信的 CDP 点击就够**（`Input.dispatchMouseEvent`，即 `cdp_act` 的 click / PageDriver 的
点击路径），实测一秒通过。**不需要 OS 级输入**。

两点注意：

- **不能用页内 JS 的 `element.click()`** —— 那是 `isTrusted:false` 的合成事件，拿不到
  user-activation（同 `drive-live-ui` 里那条 autoplay 的坑，一个道理）。
- 驱动的点击会**先插值移动光标再按下**（`shared/browser-relay/ext-page.ts` 的 `moveTo`，8 步；
  由 `humanCursor` 选项控制，采集侧恒开，DSH 插件宿主关着）。轨迹是不是
  Turnstile 的必要条件**没有单独证伪过**——但它是这条链路上唯一的拟人化，砍掉就等于对所有站点
  同时降级，**别把它当可选项删掉**。要动先证伪。

### 怎么点到一个"不能直接选中"的坐标

`cdp_act` 只吃选择器、不吃坐标。要把可信点击打到 rect 内的某个偏移点，用一个
**`pointer-events:none` 的标记元素**当靶子：CDP 按标记的中心派发鼠标事件，而标记本身不吃
指针事件，事件就落到下面的 widget 上。

```js
const m = document.createElement('div')
m.id = 'probe-marker'
m.style.cssText = `position:fixed;left:${x-2}px;top:${y-2}px;width:4px;height:4px;pointer-events:none;z-index:2147483647;`
document.body.appendChild(m)
// → cdp_act click on '#probe-marker'，点完把它删掉
```

## 5. 什么情况这套不管用

- **invisible / managed 模式的 Turnstile**：不渲染复选框，靠环境判定，**没有可点的东西**。
- **图像挑战型**（hCaptcha / reCAPTCHA 的选图）：点击解决不了，本文这套完全不适用。
- 本文只覆盖「**需要一次真实点击手势的可见复选框**」这一种。

## 6. token 有寿命，别在中间停太久

拿到 token 到提交之间**隔太久会失效**（实测隔了约半小时再提交，静默失败、表单复位、
什么都没建成）。**过验证之后要一气呵成走完提交**，别在中间插入需要人干预的步骤。
