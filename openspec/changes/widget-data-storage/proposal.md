# widget-data-storage

## Why

`widget.json` 的 `dataDir` 只声明了数据目录的位置：widget 后端把文件写进这个目录之后，数据仍然只
活在宿主给的那台机器、那份目录里——换一台设备、清一次缓存，构件攒的数据就没了。要把构件数据做成
**持久**的，需要一套「宿主提供持久数据服务」的约定：宿主起一个数据服务，把地址与凭据用环境变量
注入给 widget 后端，后端按固定的 HTTP 面读写自己的数据。约定不固定，每个嵌入方只能各造一套 API，
widget 也就无法跨宿主移植。

本 change 只定约定、常量、检查与文档，**不实现存储服务端**；任何嵌入方（自部署或把本仓库嵌入别的
产品）都可以按这套约定实现宿主一侧。

## What Changes

- **数据根语义**：`dataDir` 是构件持久数据的**数据根**——数据根下的路径构成该构件持久数据的唯一
  命名空间，代码与 `widget.json` 不在其中。未声明时默认 `data/`（常量 `WIDGET_DATA_DEFAULT_DIR`）。
  既有清单的解析行为与 `data-dir` 的判定规则不变。
- **宿主注入的环境变量**（清单不能声明，环境由宿主组装——沿用既有归属规则）：`WIDGET_DATA_URL`
  （数据服务 base URL）、`WIDGET_DATA_TOKEN`（本次会话的构件凭据）、可选 `WIDGET_DATA_MODE`
  （`off` / `snapshot` / `write_behind` / `write_through`）。`WIDGET_DATA_MODE` 是宿主向构件**提示**
  其保证的持久性级别：构件 SHALL NOT 依赖它做正确性判断——即便提示为 `write_behind`，写失败仍要
  按 `503`/`507` 等错误处理与重试。环境变量名与取值枚举作为常量从公共入口导出。
- **存储接口约定**（只定约定与常量，不实现）：服务在 `<base>/v1/document` 提供整份 JSON 文档的
  `GET`/`PUT`，在 `<base>/v1/objects[/<path>]` 提供对象的 `GET`/`HEAD`/`PUT`/`DELETE` 与列举；
  覆盖写必须带 `If-Match`、新建用 `If-None-Match: *`（不满足回 `409`/`412`，不静默覆盖）；服务端
  分配单调递增的 per-widget `revision`，响应带弱 `ETag` 与 `X-Widget-Revision`；错误码
  `401/403/404/409/412/413/429/503/507`，错误体统一 `{error, message}`；**大小上限由宿主决定**
  ——超限回 `413`（单个对象/文档过大）或 `507`（总量超限），客户端必须处理这两种错误；约定只给
  「宿主至少应接受」的保守下限（文档 ≥ 256 KiB、单对象 ≥ 1 MiB）供构件作者参考，不作为契约值。
  路径规范化规则——POSIX 相对路径，拒绝绝对路径、空段、`.`、`..`、反斜杠与 NUL，段长 ≤ 255、
  总长 ≤ 512、深度 ≤ 16，保留名 `doc` 与 `.well-known` 不进文件命名空间。路径前缀、端点路径、
  路径限制等常量从公共入口导出。
- **检查器新规则 `data-storage`**：宿主注入了 `WIDGET_DATA_URL` 时探活一次（对该服务的
  `/v1/objects/<探针路径>` 发单次 `HEAD`，短超时）：`2xx` 与 `404` 通过（404 = 还没写过，正常）；
  连接失败、`401/403`、`5xx` 以及其余非 2xx/404 的状态码不通过并写明状态码。没有该环境变量时本条
  跳过（自部署 `widget check` 行为不变）。
- **最小参考客户端** `src/widgets/data-client.ts`：文档读写、对象读写/列举/删除、条件写、路径校验
  与错误码解析的参考实现，供嵌入方与实现者对照。**不进公共导出面**（公共面本次只加常量），行为由
  对假服务端的测试钉住。
- **文档**：`docs/ARCHITECTURE.md` Widget Manifest 一节补数据根、宿主注入环境与存储接口约定。

## Capabilities

### New Capabilities
- 无（全部并入既有 `widget-manifest`：数据根是 `dataDir` 语义的补全，存储接口与检查规则挂在其
  检查器与归属需求下）。

### Modified Capabilities
- `widget-manifest`：「数据目录与环境变量的归属」需求改为数据根语义（缺省数据根 `data/`）并补宿主
  注入环境的约定；新增「宿主提供的持久数据服务」需求（注入环境、HTTP 面、路径规范化、上限）；
  检查器需求补 `data-storage` 规则；公共导出需求补新常量。

## Non-Goals

- 不实现存储服务端、鉴权服务、数据迁移与配额管理；不规定某个宿主的实现。
- 不改 `POST /.well-known/widget-data` 的既有语义——那是宿主**向** widget 送数据的口，方向与本次
  的存储接口相反，两者并存。
- 参考客户端不进公共导出面；不引入新的 HTTP 客户端依赖（用 Node 内置 `fetch`）。
- 不做读写缓存、冲突合并（CRDT）与多写者语义：条件写冲突由客户端重取后重试。

## Impact

- `src/widgets/manifest.ts`（数据根语义注释、环境变量与存储接口常量）、`src/widgets/check.ts`
  （`data-dir` 缺省语义、新规则 `data-storage`）、`src/widgets/data-client.ts`（新）与
  `src/widgets/data-client.test.ts`（新）、`src/widgets/widgets.test.ts`（正反例）、
  `src/engine/index.ts` 与 `src/engine/exports.guard.test.ts`（导出与守卫快照）、
  `docs/ARCHITECTURE.md`（Widget Manifest 一节）、`openspec/changes/widget-data-storage/`。
