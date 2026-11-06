# widget-manifest-limits

## Why

`widget.json` 描述的是**用户自己写的后端**：`serve.command` 起的进程、它往哪儿写数据、它看见哪些环境
变量。宿主在挂载前能对这份描述做的最有价值的事，是把这三件事问清楚。现状是三件都没约定：

- 数据写进哪儿，清单里没有一个字段说明，每个后端只能自己挑路径，撞上宿主的数据目录也不算越界。
- `env` 类字段虽然没有（strict schema 拒未知键），但拒绝的原因写的是「不认识的字段」，用户看不出这
  是设计上的不做，而不是还没做完。
- `serve.command` 的第一个词可以是任何东西：绝对路径、清单目录外的可执行文件、带 shell 元字符的拼接
  串。而检查器在任一规则判定之前就会把这条命令真的 spawn 起来——检查器自己成了那条路径的执行者。

本 change 补三条通用规则，并把「不该起的命令检查器也不起」钉住。三条都对自部署用户本身有用，与宿主
是谁无关。

## What Changes

- **`dataDir` 声明**：`widget.json` 新增可选字段 `dataDir`——相对清单目录的路径，宿主把它映射成**该
  widget 唯一可写的数据目录**；缺省时宿主在它自己的数据目录下给一份按 widget `id` 命名的目录。schema
  受理任意非空字符串（与 `data` 无 `serve` 同一先例：受理是 schema 的事，判对错是检查器的事，现存
  清单解析行为不变），语义写进 schema 注释与类型注释。检查器新规则 `data-dir`：声明了就必须是相对
  路径、不得含 `..` 段、不得是绝对路径，否则不通过并指名是哪一条。
- **拒绝 `env` 字段**：清单不提供环境变量注入面——环境变量由宿主组装。检查器新规则 `env` 先看原始
  JSON：出现顶层 `env` 或 `environment`（键名不分大小写）就不通过，原因写「环境变量由宿主组装，清单
  不能注入」。schema 不加这两个字段（strict 本来就拒未知键）。
- **`serve.command` 解释器约束**：检查器新规则 `serve-command`（没声明 `serve` 则跳过）——第一个词
  要么是裸名且在白名单 `{node, python3, deno, bun}` 里，要么是清单目录内的相对路径（不得是绝对路径、
  不得含 `..` 段）；命令的**任意元素**含 shell 元字符（`;`、`&&`、`|`、反引号、`$(`）不通过——宿主可能
  在别处以 shell 字符串拉起后端，这道检查是有意义的纵深防御。`serve-command` 不通过时检查器 **不启动
  该命令**（`serve-up` 记跳过并说明原因，`data-endpoint` 跟着跳过）。
- **白名单怎么定的**：仓库里没有随代码发布的 `widget.json` 示例；描述与检查器全部测试夹具用的解释器
  只有 `node`。白名单按「Stream 自带的运行时候与常见 JS/TS 运行时」取四个：`node`（仓库与全部示例）、
  `deno`、`bun`、`python3`（`packages/` 里插件与脚本常见）。要加别的解释器是宿主的事，不是清单的事。

## Capabilities

### New Capabilities
- 无（三条规则都并入既有 `widget-manifest`）。

### Modified Capabilities
- `widget-manifest`：格式需求补 `dataDir` 与「无环境变量注入面」；新增「数据目录与环境变量的归属」
  需求；检查器需求补 `data-dir` / `env` / `serve-command` 三条规则与「不通过就不启动」。

## Non-Goals

- 不实现宿主侧的目录映射与环境变量组装（本 change 只定声明与检查它）。
- 不改设备转发面（`device-loopback-forward`）：核实结论见实施记录——转发目标是构造出来的回环 IP
  字面量，无用户可控主机名、无 DNS、`no_proxy`、不跟随重定向，没有可被引导转到非本机地址的路径。
- 不做 `dataDir` 的目录创建、权限设置或内容迁移。

## Impact

- `src/widgets/manifest.ts`（`dataDir` 字段与注释、`SERVE_INTERPRETERS` / `SHELL_METACHARS` /
  `FORBIDDEN_ENV_FIELDS` 契约常量）、`src/widgets/check.ts`（三条新规则 + serve-up 的「不通过就不起」）、
  `src/widgets/widgets.test.ts`（每条规则正反例；夹具从 `true` / `sleep` 换成 `node serve.js`）、
  `docs/ARCHITECTURE.md`（Widget Manifest 一节）。
- 公共导出面不变：三条规则都在既有 `checkWidget` 的 `results` 里，常量留在模块内（`SERVE_INTERPRETERS`
  等只是检查器的判据，不新增外部依赖）。
- 现有 widget 的影响：仓库内无随发布的 `widget.json`，测试夹具受影响并已在本次改动内更新；用户自己
  写的清单里用非白名单解释器（如 `ruby`、`sh`）的，`widget:check` 会指名原因。
