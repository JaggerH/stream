# widget-manifest

## Why

自部署用户在自己机器上写着各式各样的本机小工具页面（一个仪表盘、一个表单、一个状态牌）。要把这样的
页面接进 Stream 的界面，双方需要一份约定：页面得说清自己是谁、入口在哪、要不要起后端、占多大地方、
想用什么。没有这份约定，接法只能是每家一套胶水。

`device-loopback-forward` 提供了传输（主实例经设备连接到达本机回环端口）；本 change 提供描述与检查：
**挂载描述文件 `widget.json` 的格式、一个逐条给结论的检查器（CLI 与库函数），以及自部署界面里最小
的挂载呈现——列表 + iframe 打开。**

## What Changes

- **`widget.json` schema（zod）**：`id`（kebab-case）、`name`、`icon`（可选，相对路径）、`version`
  （semver）、`entry`（界面入口，相对路径 HTML）、`serve`（可选：后端启动命令与端口，只听回环）、
  `size`（`card` / `half` / `full`）、`data`（可选：数据写入口的 JSON Schema）、`permissions`（可选：
  调模型、凭证引用、联网域名白名单）、`preview`（可选：挂起时显示的静态内容）。
- **检查器 `checkWidget(dir, opts?)`**：逐条规则给出通过/失败与原因——描述合法、入口（与 icon）存在、
  `serve.port` 合法（1024–65535 且不是主实例端口）、后端能在超时（缺省 10s）内起来并回应健康检查、
  `permissions` 字段本身合法。CLI：`pnpm widget:check <dir>`。
- **挂载存储 `data/widgets.json`**：id → `{dir, device}`。新增/编辑用 CLI（`widget:add`），界面 v1
  只读。
- **最小界面**：后端服务一个只读页面——widget 列表（name/icon/size/设备在线状态）+ 点开 iframe。
  iframe 地址是转发入口（`device-loopback-forward`），带 `sandbox` 属性；页内脚本在凭证过期前刷新
  iframe 地址。
- **导出。** schema 类型、`checkWidget`、挂载存储从公共入口导出。

## Capabilities

### New Capabilities
- `widget-manifest`：`widget.json` 格式、检查器、挂载存储与最小界面。

### Modified Capabilities
- 无（传输依赖 `device-loopback-forward`，后者不依赖本 change）。

## Non-Goals

- **不做运行时权限执行**：`permissions` 本 change 只做格式校验与展示；联网白名单在转发层的执行、模型
  调用与凭证引用的发放都是后续 change。
- **不做界面内的增删改**：挂载管理走 CLI，界面只读。
- **不做 iframe 之外的第二种呈现**、不做市场、不做打包分发格式。

## Impact

- `src/widgets/`（新：`manifest.ts` schema、`check.ts` 检查器、`store.ts` 挂载存储、`cli.ts`、
  `page.ts` 最小页面）、`src/engine/index.ts`（导出）、`package.json`（`widget:check` /
  `widget:add` script）、`docs/ARCHITECTURE.md` 一节。
