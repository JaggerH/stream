# android-scroll-end-and-blind-swipe — design

## D1 滚动「到头」以可判信号为准，判不了就说判不了

一次 `scroll`（含 `until`）没有让列表移动时，执行端只在**能给出证据**的情况下报 `end: true`：

| 信号 | 判据 | 回执 |
| --- | --- | --- |
| 容器只剩反方向的动作 | 候选节点的 `scrollsForward` / `scrollsBackward` 为 false（`ACTION_SCROLL_*` / `PAGE_*` / `FORWARD` 都已不在） | `end: true, reason: "container-at-end"` |
| 容器接受动作但一步没动，回退手势也没让屏幕变化 | 无障碍动作返回 true、内容指纹不变；随后在容器区域内下发一次回退 swipe，前后两次整段内容指纹相同 | `end: true, reason: "gesture-no-effect"` |
| 窗口里根本没有可滚动容器，手势也没让屏幕变化 | 候选为空；前后指纹相同 | `moved: false, reason: "no-container"`（**不报 `end`**） |

`until` 模式把「步骤说 `end`」当作立即停止的条件；原来「连续两步内容不变」保留为兜底（步骤判不了时）。
停止后的回执带 `found: false, stopped: "end"` 与 `end: true`，`moved` 只在一步都没移动时出现。
`maxSteps` / `timeoutMs` / 整次 10 s 边界的语义与 `timing` 字段都不变（既有约定）。

**为什么不是「只要没动就报 end」。** 没有容器时手势可能落在不可滚的页面上、或注入被系统丢弃，
「没动」说明不了「到头」；这时报 `moved: false` + `reason: "no-container"` 更诚实，调用方可以换
`find` / `click` 策略，而不是被告知一个假的底。

**为什么允许「手势没让屏幕变化」判 `end`。** 手势在容器区域内、按容器高度 70%→30% 下发，落点就是
容器自身；容器存在、无障碍动作接受、手势再次下发后整段内容仍不变，这个方向上没有更多内容可露出。
这正是真机上「已到底仍接受 `ACTION_SCROLL_FORWARD`」的形状。

**代价。** 一次回退手势前后各多一次整段内容读（计入 `timing.changeCheckMs`），单步与整次上限不变。

## D2 `until` 一步即停，不再空耗第二步

`scroll` 的每一步回执自己带 `end`；`until` 在步骤回报 `end: true` 时直接以 `stopped: "end"` 收尾。
既有的「连续两步内容不变」规则保留为步骤判不了（例如窗口没有容器）时的兜底。这样：

- 已到底的页面上，`until` 只跑一步，回执同时带 `found: false`、`stopped: "end"`、`end: true`、
  `moved: false` 与 `reason`；
- 步骤判不了（窗口没有容器）时仍按「连续两步内容不变」兜底，兜底收尾同样带 `end: true`（两条相同的读
  就是既有的到头判据）；
- 还能滚的页面上行为不变（步数、`timing`、`stopped: "steps" / "time"` 都不受影响）。

## D3 自由 `swipe` 的盲判与「翻页面」豁免

`swipe` 的起点按坐标点击的方式判：最深节点有名（名字、可编辑、可滚动、Tab、List 角色）或 OCR 在
起点读到文字 → 不算盲。否则：

- 起点落在**可滚动节点**内，且滑动主方向（`|dy| ≥ |dx|` 为纵向）与节点的滚动轴向一致 → 这是翻列表 /
  翻图，放行；节点没报轴向（只给了 forward / backward 动作）时按一致处理——树没说它往哪滚，
  而滚动容器内的无名起点更可能是翻页而不是提交。
- 其余情况在前台属 `shopping` / `payments` / `finance` 类目时判 `commit-unrecognized`（与 `click`
  的盲判同一张类目表、同一个 reason，审批豁免的 kind 也是 `commit`）。

settings 类目里的滑杆判定（`setting`）与屏幕上的 commit 滑杆判定不变，且先于盲判：滑杆本身是
「值变更」而不是「无名提交」。

**为什么不把「起点在内没有名字」一律判提交。** 列表翻页、图片轮播是滑动最常见的用途，一律过闸会把
正常浏览变成审批风暴；容器内的方向一致是最小且可判的豁免。**为什么不豁免容器外的滑动。** 网页里画出
的滑动支付条不在无障碍容器里——这正是要拦住的那种。

## 测试策略

- 用 `FakeDevice` 的 `inert`（接受动作但内容不动）、`scrollMoves`、`scrollAnswers` 构造「接受了但
  列表没动」；用假时钟断言有界耗时不变。
- 构造系统设置主列表的形状（外层 NestedScrollView + 内层 RecyclerView 不再带 forward），断言
  `until` 一步即停、回执带 `end` / `moved` / `reason`，且手势计数为 0。
- `swipe` 用例走真实策略表（`PolicyContext.fromSourceTree`）：购物类目（`com.taobao.taobao`）、
  支付类目（`com.eg.android.AlipayGphone`）、settings 滑杆页；节点树给出纵向列表 / 横向 ViewPager /
  无名条三种起点。
