# android-scroll-end-and-blind-swipe

## Why

真机（Android 16 原生系统设置主列表）上的两处「设备没把后果说清」：

- **滚动动作被接受但列表没动，回执说不清结局。** 系统设置主列表（`CollapsingToolbarLayout` +
  `RecyclerView`）已到底时，外层（AppBar / NestedScrollView）仍接受 `ACTION_SCROLL_FORWARD`
  并返回 true，列表自己不再移动。执行端按「只算列表移动」判出没移动后，`until` 只在**两步**内容
  完全不变时才停，回执只有 `steps`（或 `timing.steps`）与 `found: false`，既不说「到这里就是头了」
  （`end`），也没有 `reason`。调用方无法区分「设备滚了但屏幕没变」「页面本来就滚不动」
  「搜索还没找到但已经到头」，只能猜「无障碍滚动不生效」。
- **自由 `swipe` 的盲区。** `swipe` 的起点没有有名节点时直接放行，而 `click` 早已把这种「无名点」
  在购物 / 支付 / 金融类目里判 `commit-unrecognized`。人机验证的滑块、网页里画出来的滑动支付
  都属于「起点无节点、无名可言」的形状，滑动却不过闸。

## What Changes

- **`scroll`（含 `until`）的回执说清结局（可选字段，向后兼容）。**
  - `moved`：本次操作里列表自身内容是否移动过；没有移动时显式报 `moved: false`。
  - `end: true`：这个方向上已经到头。判据可判时立刻报：节点不再带该方向的动作
    （`scrollsForward` / `scrollsBackward` 为 false）、或换过容器后回退手势仍没让屏幕变化。
  - `reason`：没有移动时的原因，`container-at-end` / `gesture-no-effect` / `no-container`。
    不能判到底（页面没有可滚动容器、手势也没让屏幕变化）时只报 `moved: false` + `reason`，
    不报 `end`。
  - `until` 在**第一个说自己到头（`end: true`）的步骤**处停下，不再空耗第二步；原来「连续两步
    内容不变」作为判不了时的兜底保留。
  - 既有的单步 800 ms / 整次 10 s 上限与 `timing` 字段保持不变。

- **自由 `swipe` 对齐 `click` 的盲判。**
  - 起点没有有名节点、也没有 OCR 文字，且前台属购物 / 支付 / 金融类目 → `commit-unrecognized`，
    动作不执行。
  - 例外：起点落在可滚动容器内、且滑动的主方向与该容器的滚动轴向一致（翻列表、翻图）→ 放行。
  - settings 类目里的滑杆照旧判 `setting`；带 commit / payment 标签的滑杆照旧要求审批。

- **能力版本。** `ui.tree` 升到 v8（滚动回执的结局字段与即时到头判定）；`ui.act` 升到 v3
  （自由 `swipe` 的盲判）。新字段全部可选，老调用方不看即可。

## Capabilities

### Modified Capabilities

- `android-recipe-replay`：`scroll` / `scroll until` 回执的 `moved` / `end` / `reason` 与即时
  到头判定。
- `device-sensitive-semantics`：自由 `swipe` 的盲判与「翻页面不是提交」的豁免。

## Impact

- `app/android/agent/src/main/java/com/streamapp/android/agent/Dispatcher.kt`（滚动判步与回执、
  `swipe` 的起点判定）、`policy/Gate.kt`（`swipe` 的 `commit-unrecognized`）。
- `docs/API.md`：`scroll` / `swipe` 两张表与能力清单。
- 测试：新增滚动结局用例与 `swipe` 盲判用例；`ScrollUntilTest` 的「两步不变」用例改为「一步即停」；
  能力版本断言（`RelayClientTest`、`NavGesturesTest`）。
