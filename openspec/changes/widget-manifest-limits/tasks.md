# widget-manifest-limits

## 计划 1：清单形状

- [x] 1. `manifest.ts`：`dataDir` 可选字段（非空字符串）+ 类型注释写清「宿主映射成该 widget 唯一可写的数据目录，缺省按 id 命名」
- [x] 2. `manifest.ts`：契约常量 `SERVE_INTERPRETERS` / `SHELL_METACHARS` / `FORBIDDEN_ENV_FIELDS`

## 计划 2：检查器

- [x] 1. `env` 规则：看原始 JSON 的顶层键（不分大小写），命中即不通过，原因写「环境变量由宿主组装，清单不能注入」
- [x] 2. `data-dir` 规则：声明了才查——非空、不是绝对路径、无 `..` 段；未声明 skipped
- [x] 3. `serve-command` 规则：第一个词 = 白名单裸名或清单目录内相对路径；任意元素含 shell 元字符即不通过
- [x] 4. `serve-up` 与 `data-endpoint` 跟着 `serve-command` 的结论走：不通过就不 spawn，两条记跳过并说明原因

## 计划 3：测试与文档

- [x] 1. 三条规则各有通过与不通过两侧用例；`serve-command` 不通过时断言 `serve-up` skipped
- [x] 2. 没有新字段的老清单行为不变（既有用例全绿；夹具 `true` / `sleep` 换成 `node serve.js`）
- [x] 3. `docs/ARCHITECTURE.md` Widget Manifest 一节补三条规则
- [ ] 4. typecheck + 全量测试绿后线性推 main
