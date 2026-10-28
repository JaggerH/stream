# secret-fill

## Why

AI 经 `cdp_act` 驱动浏览器时，遇到登录页只能 `kind:'type'` 把密码当 `text` 传进来——**密码因此进了模型的上下文**，
也进了 MCP 调用记录、运行记录、宿主的对话日志。模型不可控（网页里的提示注入能诱导它，它也会把看到的东西复述出去），
凭证不该经过它。

现在的 `intent:'credential'` 只是把这次动作标成高危、要人确认；确认之后密码照样经过模型。

同类做法（密码管理器给浏览器代理的自动填充）的共同点：**模型只拿到一个引用，替换成真值发生在浏览器那一层**，
填之前核对网站，填完之后模型读不回来。Stream 驱动的是真实的浏览器，正好做这一层。

## What Changes

- **秘密来源可注入（`SecretSource`）。** Stream 自己不存密码：嵌入方或自部署配置提供一个来源，按**引用名**给出
  `{ origins, username?, password?, totp? }`（`totp` 是现算的一次性码）。没有注入来源时，下面的动作一律以
  `secret-source-missing` 拒绝，其余行为与今天逐字节一致。
- **一个原子的登录动作。** `cdp_act` 新增 `kind:'login'`：参数是引用名 `secret` 与各字段的选择器
  （`usernameSelector` / `passwordSelector` / `totpSelector`，至少一个）以及可选的 `submitSelector`。
  Stream 在一次调用里：取当前标签**顶层页面的真实 origin**（经 CDP 读，不信页面脚本）→ 与该秘密绑定的 origin 比对，
  不一致即 `origin-mismatch` 拒填 → 取值、逐字段可信输入 → 提交 → 等待导航完成；限时内没导航就**清空**刚填的字段。
  动作结束后返回 `{ status, origin, filled: [字段名], navigated, cleared }`，**任何值都不出现在结果里**。
- **动作期间锁住这张标签的读取。** 从开始填到导航完成（或字段被清空）之前，同一标签上的 `cdp_look` / `cdp_shot` /
  `cdp_act` 的 `look`/`evaluate`/`exists` 等读取一律以 `secret-fill-in-progress` 拒绝，不排队等待。
- **秘密不落任何记录。** 值只在填写那一刻存在于后端内存，经中继发给浏览器；不进日志、debug bus、慢命令账本、
  运行记录、错误信息、MCP 结果。中继对承载秘密的 CDP 命令只记命令名。
- **高危闸照旧。** `kind:'login'` 固定按 `intent:'credential'` 归为高危：交互通道要 `confirmed:true`；宿主可以在自己的
  审批之后再调用。
- `facility:<name>` 与 `chrome[:<tabId>]` 两种目标都支持（采集会话的标签与用户自己的标签）。

## Capabilities

### New Capabilities
- `secret-fill`：秘密来源注入、原子登录动作、origin 核对、读取锁、不回显不落盘。

### Modified Capabilities
- `ext-cdp-interactive-transport`：`cdp_act` 多一个 `kind:'login'`；读取在登录动作期间可被拒绝。

## Impact

- `shared/browser-relay/`：`interactive-gate.ts`（动作类型与分类）、`run-action.ts`（`login` 的落地）、`relay.ts`
  （承载秘密的命令只记名字）、`tool-specs.ts`（参数说明）。
- `src/mcp/cdp-router.ts` 与 facility 的 act 通路：读取锁、取 origin、调用秘密来源。
- 引擎公共入口：`createStream` / `createRuntime` 的选项多一个 `secretSource`。
- 不改节点协议的帧格式：值经现有的 CDP 管道（`Input.insertText`）送达，扩展不需要知道什么是秘密。

## Non-Goals

- 不做密码库：存储、加密、增删改、界面都由提供 `SecretSource` 的一方负责。
- 不做短信验证码与扫码（宿主自己向人要值；要填进页面时可以作为一次性的秘密交给来源）。
- 不保证页面脚本拿不到值：被登录的网站本来就要拿到密码。保证的是**模型与 Stream 的记录**拿不到。
