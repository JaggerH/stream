## ADDED Requirements

### Requirement: 自由 swipe 的盲判与翻页面豁免

自由 `swipe` 的起点 SHALL 按坐标点击的方式判定：起点下的最深可访问节点有名（文本 / 描述、可编辑、
可滚动、Tab 或 List 角色之一），或 OCR 在该点读到文字时，SHALL NOT 视为盲。两者都没有、且前台应用
属 `shopping` / `payments` / `finance` 类目时 SHALL 判 `commit-unrecognized` 并要求审批，动作不执行。
例外：起点落在可滚动节点内、且滑动的主方向与该节点的滚动轴向一致（纵向列表里纵向滑、横向轮播里横向
滑；节点未报轴向时按一致处理）时 SHALL 放行，因为这是翻页而不是提交。settings 类目里滑杆与屏幕上
带 commit / payment 标签的滑杆的既有判定 SHALL 保持不变，并先于盲判。能力 `ui.act` SHALL 声明 v3。

#### Scenario: 购物 App 里无名起点的横向滑动
- **WHEN** 前台是购物类目应用，滑动起点下没有有名节点、也没有 OCR 文字，且不在任何可滚动容器内
- **THEN** 动作失败为 `approval-required`，`reasons` 含 `commit-unrecognized`，设备未收到滑动

#### Scenario: 翻列表不受影响
- **WHEN** 购物类目应用的商品列表（纵向可滚动）上，调用方从列表内一点向上滑
- **THEN** 父容器不要求审批，滑动原样执行

#### Scenario: 翻图不受影响
- **WHEN** 商品图轮播（横向可滚动容器）上，调用方从图内一点向左滑
- **THEN** 父容器不要求审批，滑动原样执行

#### Scenario: 方向与容器不一致仍要审批
- **WHEN** 购物类目应用里，起点在纵向列表内，但滑动是横向的
- **THEN** 若起点没有有名节点与 OCR 文字，判 `commit-unrecognized`

#### Scenario: settings 滑杆照旧判 setting
- **WHEN** 前台是 Settings，起点落在字号滑杆上滑动
- **THEN** `reasons` 含 `setting`，与之前相同
