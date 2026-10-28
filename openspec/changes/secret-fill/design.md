# secret-fill — design

## D1 为什么是一个原子动作，而不是「type 能接引用」

最直接的做法是给 `kind:'type'` 加一个 `secretRef` 参数。不这么做：

- 填完之后的那段时间才是危险的：密码框里有值，模型下一步就能 `cdp_look({js:'document.querySelector("input[type=password]").value'})`
  读回来。`look` / `evaluate` 跑的是任意表达式，**事后遮蔽做不到**。
- 所以「填 → 提交 → 页面离开（或字段清空）」必须在一次调用里做完，期间这张标签不接受任何读取。动作结束时，
  要么页面已经导航走了（密码框不在了；浏览器不会把密码框的值放进前进后退缓存的表单恢复里），要么字段已被清空。

## D2 origin 从哪来

用 CDP 读这张标签**顶层 frame 的 URL**（`Page.getFrameTree` 的主 frame），不在页面里 `eval location.origin`：
页面脚本改不了 `location`，但「我们问页面、页面答我们」这条路本身就不该被信任。比对用规范化后的 origin
（scheme + host + port）；秘密的 `origins` 允许多个，按精确 origin 匹配，不做后缀通配。

登录表单在 iframe 里的站（少数）：本 change 不支持，返回 `login-in-iframe-unsupported`，以后再说。

## D3 等待导航与清空

- 提交方式：给了 `submitSelector` 就可信点击它；没给就在最后一个填过的字段上按 Enter。
- 等待：最多 `waitMs`（缺省 15 s）观察主 frame 的 URL 或文档是否变化（`Page.frameNavigated`，或轮询主 frame 的 loaderId）。
- 没导航（密码错、验证码弹层、单页应用不跳转）：把填过的每个字段**清空**（可信全选 + 删除），返回 `navigated:false, cleared:true`。
  单页应用登录成功但不跳转的情况会被清空——这是对的：值不该在页面上停留。调用方看 `navigated` 自己决定下一步
  （通常是看一眼页面再判断登录成没成）。
- 清空失败（元素没了、页面卡死）：返回 `cleared:false` 并**保持这张标签的读取锁**，直到这张标签导航或被关闭。

## D4 读取锁

- 锁的粒度是一张标签（`chrome:<tabId>`，或 facility 会话当前的那张）。登录动作开始时上锁，D3 结束时解锁。
- 被锁期间：`cdp_look`、`cdp_shot`、`cdp_act` 的 `look` / `evaluate` / `exists` / `type` / `click` 一律立即拒绝
  （`secret-fill-in-progress`），不排队——排队会让模型的读取恰好落在解锁后的第一时间，没坏处但也没必要。
- 锁在后端（Stream 进程）里，不在扩展里：所有读取都经后端，后端是唯一的路。

## D5 不落记录

- `SecretSource.get()` 的返回值只在 `runLogin` 的局部变量里，用完即弃。
- `Input.insertText` 的参数会经中继发给扩展：中继的慢命令账本、debug bus、错误信息只写命令名与耗时，
  对带 `secret` 标记的命令**不写 params**。扩展侧本来就不记 CDP 参数（逐一核对后在 tasks 里打勾）。
- 错误信息：选择器没命中、origin 不符、来源拒绝等都只带引用名与字段名，不带值。
- 测试用一个特征串作密码跑完整流程，再 grep 全部日志、debug bus、MCP 结果，命中为 0。

## D6 `SecretSource` 接口

```ts
interface SecretSource {
  /** 按引用名取。不认得 → null；认得但拒绝（例如宿主要求先审批）→ 抛带原因的错误。 */
  get(ref: string, ctx: { origin: string; target: string }): Promise<SecretValue | null>
}
interface SecretValue {
  origins: string[]            // 允许填的 origin，精确匹配
  username?: string
  password?: string
  totp?: string                // 现算的一次性码；来源负责算
}
```

`ctx.origin` 先给来源：来源也可以自己拒（双保险），也可以借它记审计。没注入来源 = 功能关闭。

## 备选（没选）

- **扩展侧持有秘密**：要给扩展一条新的秘密下发通道和存储，扩展是开源的且跑在用户设备上，但秘密的来源通常在后端一侧；
  多一条通道多一处要审计。现有 CDP 管道已经够用。
- **只遮蔽 `input[type=password]` 的读取**：做不到（D1），任意表达式能绕过任何遮蔽。
