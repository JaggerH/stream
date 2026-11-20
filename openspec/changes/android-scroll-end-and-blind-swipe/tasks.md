# android-scroll-end-and-blind-swipe — tasks

## 1. Failing tests first

- [x] 1.1 `scroll`（无 `until`）：容器接受动作、内容一步没动、回退手势也没让屏幕变化 → 回执
      `method: "gesture"`、`moved: false`、`end: true`、`reason: "gesture-no-effect"`，且确实下发过手势。
- [x] 1.2 `scroll`（无 `until`）：同类页面但没有可滚动容器 → `moved: false`、`reason: "no-container"`、
      不带 `end`。
- [x] 1.3 `scroll until`：外层容器接受、内层列表已不再带 forward（系统设置主列表形状）→ 只跑一步，
      `found: false`、`stopped: "end"`、`end: true`、`moved: false`、`reason: "container-at-end"`，
      手势计数为 0，`timing` 的字段集合不变。
- [x] 1.4 `scroll until`：容器接受但一步没动、手势也无变化 → 一步即以 `stopped: "end"` 收尾
      （原「两步不变」用例改为一步；「两步不变」作为兜底保留）。
- [x] 1.5 `scroll until`：页面没有可滚动容器 → 两步兜底后 `stopped: "end"`，回执 `moved: false` 与
      `reason: "no-container"`。
- [x] 1.6 `scroll` 仍在动时既有回执不变：`maxSteps` / `timeoutMs` / 整次上限、`timing` 字段集合、
      `method` / `steps` / `via` 照旧。
- [x] 1.7 `swipe` 盲判：购物类目里起点无节点无名、无 OCR → `commit-unrecognized`，动作未执行。
- [x] 1.8 `swipe` 豁免：购物类目里起点在纵向列表内、纵向滑动 → 放行；横向 ViewPager 内横向翻图 → 放行；
      纵向列表内横向滑动（方向不一致）、起点无名 → 仍判 `commit-unrecognized`。
- [x] 1.9 `swipe` 既有判定不变：settings 滑杆判 `setting`；带 commit 标签的滑杆要求审批；起点落在
      有名节点上放行。
- [x] 1.10 能力版本断言：`ui.tree` v8、`ui.act` v3。

## 2. Implementation

- [x] 2.1 `Dispatcher.scroll`：手势回退前后各读一次整段内容（计入 `changeCheckMs`）；没移动时按
      可判信号给出 `moved` / `end` / `reason`；无障碍路径的到头与超时回执同样带 `moved: false`。
- [x] 2.2 `Dispatcher.scrollUntil`：步骤回执带 `end: true` 时立即以 `stopped: "end"` 收尾；
      回执带 `moved` / `end` / `reason`；「两步不变」保留为兜底。
- [x] 2.3 `Dispatcher.swipe`：起点判定与 `click` 对齐（有名节点 / OCR 文字），并加「方向与可滚动容器
      轴向一致则放行」的豁免；盲判结果交给闸。
- [x] 2.4 `Gate.reasons` 的 `swipe` 分支：盲 + 购物 / 支付 / 金融类目 → `commit-unrecognized`。
- [x] 2.5 能力版本：`ui.tree` v8、`ui.act` v3 与注释。

## 3. Documentation and verification

- [x] 3.1 `docs/API.md`：`scroll` 回执的 `moved` / `end` / `reason` 与 `until` 一步即停；`swipe` 的
      盲判与翻页豁免；能力清单 v8 / v3。
- [x] 3.2 Kotlin 单测在 lean 上全绿（`OwnTouchFrameTest` 的 6 条 aarch64 环境性红单列）。
- [x] 3.3 Stream 全量测试与 `typecheck` 在 lean 上跑（整机锁 + `nice`），基线失败单列。
