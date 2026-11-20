# design — browser-actionability

## D1. 两条路径今天各自从哪里点（先核实的事实）

| 宿主 | 输入落到浏览器的方式 | 定位逻辑在哪 |
| --- | --- | --- |
| 扩展（`extension/src/lib/driver.ts`） | `dispatch` 把 `{tabId,method,params}` 交给 `chrome.debugger.sendCommand`；`Input.dispatchMouseEvent` 在 `FIRE_AND_FORGET` 里（发了不等回执） | **不在扩展里**。扩展不解释选择器、不算坐标；它只是 CDP 管子。 |
| CDP 绑定（`src/cdp-binding/ops.ts` 的 `CdpRelayOps`） | `dispatch` 把同形状命令落到 `CdpConnection.send`；同样把 `Input.dispatchMouseEvent` 放进 `FIRE_AND_FORGET` | **也不在绑定里**。绑定只做标签认领、attach、域名复核与命令透传。 |

两边真正“点哪里、怎么点”的唯一实现在 `shared/browser-relay/ext-page.ts` 的 `makeExtPageDriver`：

- `click(selector, position?)`：轮询 `getBoundingClientRect` → 取中心（或 `position` 偏移）→ `clickAt`（8 步 `mouseMoved` + `mousePressed` + `mouseReleased`）。
- `type(selector, text)`：`querySelector` + `el.focus()` → Ctrl+A → `Input.insertText`。

所以可操作性检查放进 `shared/browser-relay/` 就同时覆盖两条路径，不需要改扩展、也不需要第二份实现。扩展侧若以后多出定位逻辑，同样应落在这里，而不是在 `driver.ts` 里分叉。

## D2. 检查流水线与失败码

顺序固定，前一步不过就不做后一步，任何失败都不发输入：

1. **存在**：`document.querySelector(selector)` 命中。缺席 → `not-found`。`click` 保留原来的 5s 轮询（元素可能晚于动作出现）。
2. **可见**：`getBoundingClientRect` 宽高都 > 0；元素及祖先链上没有 `display:none`、`visibility:hidden|collapse`、`opacity:0`；有 `checkVisibility` 时再用它复核。失败 → `not-visible`，原因点名是哪种。
3. **启用**：`:disabled`（含 disabled `fieldset` 的后代）、`aria-disabled="true"`。写入还要求 `input` / `textarea` / `select` / `contenteditable` 且非 `readonly`；不可编辑 → `not-editable`。失败 → `disabled`。
4. **滚进视口**：页内 `el.scrollIntoView({block:'center',inline:'center',behavior:'instant'})`，等两个动画帧（最多 80ms）并比较前后矩形，确认布局稳定。滚动后可见交集为空 → `outside-viewport`。
5. **命中测试**：在落点（`position` 偏移或可见交集中心）取 `document.elementFromPoint`，穿透打开的 shadow root。命中目标本身或其后代（沿 `parentNode` / `ShadowRoot.host` 向上走）才算通过；否则 → `covered`，原因里带遮挡元素的简述（标签、`id`、前两个 class、`role`/`aria-label`、截断文本）。
6. **节点未换**：命中测试时给目标打一个一次性 `data-stream-target` 标记；发输入前再查一次同一个标记。节点已被替换 → `detached`，按 locator 重新定位一次再走一遍（只一次）。

## D3. 回执契约与向后兼容

```ts
type ActionFailureCode =
  | 'not-found' | 'not-visible' | 'disabled' | 'covered'
  | 'detached' | 'outside-viewport' | 'value-mismatch' | 'not-editable'

interface ActionReceipt {
  ok: boolean
  reason?: { code: ActionFailureCode; reason: string }   // ok=false 时必有
  delivery?: 'confirmed' | 'unconfirmed'                  // click 成功时；收不到可信 click 事件 = unconfirmed
  point?: { x: number; y: number }
}
```

- `PageDriver.click` / `type` 仍是 `Promise<boolean>`：前置失败一律 `false`，且一个输入事件都没发。旧调用方（recipe、采集、登录）行为不变。
- 新可选动词 `clickReceipt` / `typeReceipt` 返回 `ActionReceipt`；`makeExtPageDriver` 两者都实现。
- `actWithConfirm` 用详细回执：失败码直接成为 `ActResult.status`（如 `covered`），`reason` 写人话；成功时把 `delivery` 带上去。`not-found` 与旧语义完全重合。
- `runAction` 保持返回原来的值（`click` 返回布尔）；新增 `runActionDetailed` 给 `actWithConfirm` 用。这样共享库的既有导出面不破。

## D4. 动作后确认

- **click**：发输入前在页内挂一次性 `click` 捕获监听（`isTrusted` 原样记下），点击后最多轮询 800ms。收到可信 `click` → `delivery: 'confirmed'`；没收到 → `unconfirmed`，仍算动作已发出，不重试、不判失败。这直接回答了“回执只代表交给了 Chrome”那一档：它现在至少能回答“页面收到了一次可信点击没有”。
- **type / fill**：`Input.insertText` 返回后回读同一节点的值（`value` 或 `textContent`），与写入值逐字比较。不一致 → `value-mismatch`。回读只在页内比较，**不把值带回来**。唯一的例外是秘密填入（login）：它的既有契约是“值只许出现在 `Input.insertText` 的参数里”，因此 `runLogin` 调 `typeReceipt(..., { readBack: false })` 关掉回读——把秘密嵌进第二条 `Runtime.evaluate` 会破坏那条契约。可操作性前置检查照常生效。
- churn 的 `detached` 只重定位一次；第二次仍 `detached` 就如实返回。

## D5. 测试与证据

- 单测：`shared/browser-relay/actionability.test.ts` 用假的 `evalExpr` 覆盖每个失败码与成功落点，并断言失败时一条 `Input.*` 都没有。
- 集成测试：`src/cdp-binding/actionability-relay.test.ts` 起一台真 Chromium（复用 `src/cdp-binding/__fixtures__/chromium.ts`），用 `CdpConnection` + `CdpRelayOps` + `makeExtPageDriver` 跑与产品完全相同的命令流；fixture 页面覆盖遮挡、禁用、隐藏、零透明度、视口外、churn、表单回读。没有 Chromium 时整组跳过并打印原因。
- 扩展不需要改：它不持有定位逻辑，现成的 `driver.*.test.ts` 仍覆盖中继的命令转发；本 change 不触碰 `extension/`。

## D6. 不做的事

- 不引入外部二进制或依赖；不合并任何 spike 分支，只把 fixture 页面搬进正式测试目录。
- 不在没有 `expect` 时把 `unconfirmed` 升级成失败——那会把“页面本来就没反应”和“事件没送到”混为一谈，而后者已经由 `delivery` 分开。
- 不改 Playwright / cloak 那条路：它由 Playwright 自己的 actionability 与 auto-wait 负责。
