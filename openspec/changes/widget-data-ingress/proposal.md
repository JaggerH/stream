# widget-data-ingress

## Why

`widget.json` 的 `data` 字段声明了 widget 的数据形状，但宿主怎么把数据**写**给 widget 一直没有约定：
每个嵌入方只能自己挑端口上随便一个路径、自己的 method 与 body 约定。既然 `serve` 已经给了 widget 一个
本机回环 HTTP 口，写入口可以完全约定死：一条固定的路径、一种 method、一种 content-type、一种成功
语义。约定一旦固定，检查器就能替用户验它——声明了 `data` 的 widget 必须真的有这个口。

## What Changes

- **数据写入口约定**：`WIDGET_DATA_PATH = '/.well-known/widget-data'`。宿主给声明了 `data` 的 widget
  送数据的方式固定为——对该 widget `serve.port` 发 `POST http://127.0.0.1:<port>/.well-known/widget-data`，
  `Content-Type: application/json`，body 是一份符合 `data` schema 的 JSON；widget 回 2xx 表示收下，
  其余状态码一律视为失败。声明了 `data` 而没有 `serve` 的 widget 无处可写。本 change 只定约定、导出
  常量并检查它；宿主的写入客户端与数据口鉴权不在范围内（传输走既有 device-loopback-forward）。
- **检查器新规则**：`data-ingress`——`data` 声明了而 `serve` 缺失 → 不通过（数据无处可写）；zod schema
  不动，现存 `widget.json` 的解析行为不变。`data-endpoint`——serve 起来后在其进程窗口内向
  `/.well-known/widget-data` 发一次最小样例（空对象 JSON，单次 2s 超时），只要求连得上且不是 404；
  widget 校验数据后回 4xx 不拦。没声明 `data` 的 widget 两条都按跳过计，行为不变。
- **导出**：`WIDGET_DATA_PATH` 从公共入口导出（导出面守卫测试同步）。

## Capabilities

### New Capabilities
- 无（全部并入既有 `widget-manifest`：写入口是 `data` 字段语义的补全，检查器规则挂在其检查器需求下）。

### Modified Capabilities
- `widget-manifest`：新增「数据写入口」需求；检查器需求补 `data-ingress` / `data-endpoint` 两条规则；
  公共导出需求补 `WIDGET_DATA_PATH`。

## Non-Goals

- 不实现宿主侧的写入客户端（往数据口送数据的调用方逻辑）。
- 不做数据口的鉴权（复用既有转发凭证与访问门）。
- 不做按 JSON Schema 生成最小样例的生成器（探测统一用空对象）。
- 自部署挂载界面不变。

## Impact

- `src/widgets/manifest.ts`（常量与类型注释）、`src/widgets/check.ts`（两条新规则）、
  `src/engine/index.ts`（导出）、`src/engine/exports.guard.test.ts`（导出快照）、
  `src/widgets/widgets.test.ts`（正反例）、`docs/ARCHITECTURE.md`（Widget Manifest 一节）。
