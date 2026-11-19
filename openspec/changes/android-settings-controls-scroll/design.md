# android-settings-controls-scroll — design

## D1. Settings 类目里的步进按钮与滑杆

真机证据：Android 16 设置 → 显示大小与文字 → 「字号」一行是「－ 滑杆 ＋」。步进按钮有名字
（`Decrease font size` / `Increase font size`），滑杆没有名字，字体大小是滑杆的值。

判定分三层，只在 `settings` 类目里生效（其他类目里的数量 ± 不是系统设置）：

1. **词表。** 标签去标点数字后以 `increase` / `decrease` 开头的拉丁标签，或 CJK 核心以
   `增大` / `减小` / `加` / `减` 开头的标签，判步进。`加` / `减` 单字前缀在设置页很少出现在别的动作上；
   误报的代价是一次多余的审批，漏报的代价是静默改设置。
2. **结构。** 名字是 `＋` / `－` / `+` / `-`（或 `−`）的可点击控件，与树里的一个滑杆同一行（垂直重叠
   至少较小高度的一半）、水平间隙不超过 `ICON_GAP_PX`（160 px），判步进。图标按钮的 contentDescription
   有时为空、有时是符号，靠结构兜住。
3. **滑杆本身。** `role` / `className` 含 `Seek` 或 `Slider` 的非滚动控件：点击（点轨道）、`invoke`
   （其上的 `ACTION_SCROLL_FORWARD/BACKWARD` 改值）、`setValue` 在 settings 类目里都判 `setting`；
   `scroll` 只在树里存在**可滚动**的滑杆时判（普通列表滚动不受影响）。

`kindOf("setting")` 已是既有的 `setting` 动作类，ask 豁免与类目 ask 表照旧生效。

## D2. 滑杆读值

`RangeInfo` 的原样字段已由 v2 报出：`range: {type, now, min, max}`。本次补两个可选字段：

- **`stepCount`**（`range` 内）。整数区间的档数 `max − min + 1`：Android 16 字号页回「0 of 0–3」，
  说明这个滑杆是 4 档区间；只对 `type == "int"` 且 `min` / `max` 有限时给出。`float` / `percent` /
  `indeterminate` 没有档数语义，不带。字段由 `RangeInfo` 的边界推出，不做单位换算（`now` 仍是
  `RangeInfo.current` 原值）。
- **`valueText`**（元素与行 `values`）。节点自己说的值：`stateDescription` 非空时用它，否则用
  `text`；都没有就不带。Android 16 的 Material 滑杆把「Default / Large / Largest」放在
  `stateDescription` 里，正是调用方读「现在是哪档」时该看的东西。

**为什么 `current` 不新起一个名字。** 协议从 `ui.tree` v2 起把 `RangeInfo.current` 报成 `now`，已部署的
调用方按 `now` 读；把它改名会破坏向后兼容。`now` 就是 current，文档里写明。

**Android 16 字号页的 `RangeInfo` 是否反映 `font_scale`。** 真机回的是 `0 of 0–3`（`type: int`），不是
`font_scale`（1.3）：这个滑杆报的是**档位**，且读到的可能是同页的「显示大小」滑杆（两者都是 0–3）。
设备端能做的：把 `valueText` 与行 `values` 一起给出（`Font size` 标题 → 同行滑杆的 `state`），让调用方
按标题挑滑杆、按 `stepCount` 知道档数；`RangeInfo` 本身若不随 `font_scale` 变化，设备端无法从无障碍树
里读出 `font_scale`（那是 SettingsProvider 的值，不在树里）——这一点写进 `docs/API.md` 与交付报告。

## D3. 折叠工具栏上的判步

既有的判步看两件事：区域内容指纹变了、容器首可见项位置变了。在
`CollapsingToolbarLayout + AppBarLayout + RecyclerView` 上，第一步滚动的效果是 **AppBar 折叠**：
整个列表随之上移，列表内容相对自己并没有滚动。首可见项的**绝对**位置变了 → 判成移动 → 记住容器 →
后续步骤继续发在同一个动作上。调用方看到 `steps ≥ 1` 而列表没动。

修法：**判步看相对位置。**

- `firstItemPrint(container, …)` 从整窗范围改成**容器自己的子树**，并且位置相对其**最近的滚动祖先**
  （通常就是容器本身）计算。AppBar 折叠时，列表整体上移、列表项相对列表的位置不变 → 不算移动；
  列表真的滚动时，第一项相对列表的位置变 → 算移动。
- `awaitMove` 区分三种结果：
  - **列表移动**（相对首项变）→ 计入一步；
  - **只有布局移动**（相对首项不变、绝对位置变了，且内容停稳）→ 不计步、不换容器，对同一容器再发
    一步（折叠是进度，不是列表移动）；次数上限 `MAX_LAYOUT_SHIFTS`；
  - **没有移动**（内容指纹没变）→ 该候选放弃，按既有语义换下一个候选或走手势。
- 时间上界不变：单步 800 ms、整次 10 s、`timing` 各字段不变；额外的一步也受同一 `deadline` 约束。
- `scrollUntil` 的「记住容器」不变：折叠步之后仍是同一个列表；`until` 命中判据不变。

## D4. 能力与兼容

`ui.tree` 升到 **v6**：`range.stepCount`、`valueText` 是新增可选字段；折叠工具栏上的判步是行为修正
（移动列表时照样确认，移动布局时不再误报）。老调用方不看新字段、按既有 `steps` 使用即可。

## 备选与取舍

- *把 AppBar 从候选里剔掉。* AppBarLayout 本身不是滚动容器，问题是判步而不是候选；剔掉会误伤真正
  可滚动的头部。选判步。
- *只按首项 identity（不看位置）判步。* 倒计时重排同一行时 identity 不变、位置变，会漏判真实滚动；
  相对位置同时覆盖两种情况。
- *`range` 改名为 `{min,max,current,stepCount}`。* 破坏已部署调用方；保留 `now`，只增不改。
